// Writes replacement SQL back into .sql files or code migrations, handling transactions,
// COMMIT-boundary moves and Prisma multi-file splits.
import fs from 'node:fs';
import path from 'node:path';
import { ts, ancestor, enclosingStatement, indentationAt, insertLinesBefore, lineStart } from './helpers.js';
import { encode } from './migration-context.js';
import type { CallExpression, ExpressionStatement, Node, PropertyDeclaration } from 'typescript';
import type { FileTarget, FixResult, TextEdit } from '../../shared/types.js';
import type { MigrationContext, Notes, PlacementPlan, SqlStatement, TransactionEdit } from '../types/migrations.js';

const TYPEORM_TRANSACTION_NOTE =
  "Added `transaction = false`: TypeORM honours it only when migrations run with `migrationsTransactionMode: 'each'` (CLI `--transaction each`) and refuses it in the default `all` mode. The other statements of this migration no longer roll back together.";
const MOVED_PAST_LATER_NOTE =
  'The statement now runs in its own call after the rest of this query string, so check that none of the later statements depends on it.';
const MIKRO_ORM_TRANSACTION_NOTE =
  'Added `isTransactional()` returning false: the other statements of this migration no longer roll back together.';
const KNEX_TRANSACTION_NOTE =
  'Added `config = { transaction: false }`: the other statements of this migration no longer roll back together.';

function siblingPath(file: string, ...parts: string[]): string {
  const join = file.includes('\\') ? path.join : path.posix.join;
  return join(...parts);
}

function joinSeparator(context: MigrationContext, statement: SqlStatement): string {
  if (!context.quote) return ';' + context.eol;
  if (context.quote === '`') return ';\n' + indentationAt(context.text, statement.start);
  return '; ';
}

export function replaceStatement(context: MigrationContext, statement: SqlStatement, sqls: string[]): TextEdit {
  const text = sqls.map((sql) => encode(sql, context.quote)).join(joinSeparator(context, statement));
  return { start: statement.start, end: statement.end, text };
}

// Deletes the statement with its semicolon, leaving the neighbouring statements intact.
export function statementRemoval(context: MigrationContext, statement: SqlStatement): TextEdit | undefined {
  const { text } = context;
  if (statement.semicolon === null) {
    const previous = context.statements[context.statements.indexOf(statement) - 1];
    if (!previous || previous.semicolon === null) return;
    return { start: previous.semicolon + 1, end: statement.end, text: '' };
  }
  const trailing = (/^[ \t]*(?:\r?\n)?/.exec(text.slice(statement.semicolon + 1, context.regionEnd)) ?? [''])[0];
  const lineBegin = Math.max(lineStart(text, statement.start), context.regionStart);
  const start = /^[ \t]*$/.test(text.slice(lineBegin, statement.start)) && trailing ? lineBegin : statement.start;
  return { start, end: statement.semicolon + 1 + trailing.length, text: '' };
}

// The call whose argument is the query literal, and the statement it is awaited in.
export function queryCall(
  context: MigrationContext,
): { call: CallExpression; statement: ExpressionStatement } | undefined {
  const { literal } = context;
  if (!literal) return;
  const call = literal.parent;
  if (!call || !ts.isCallExpression(call) || !call.arguments.includes(literal)) return;
  const statement = enclosingStatement(call);
  if (!statement || !ts.isExpressionStatement(statement) || !ts.isBlock(statement.parent)) return;
  return { call, statement };
}

// New `await queryRunner.query(...)` calls after the flagged one, one per statement, so each runs
// on its own.
function callsAfter(context: MigrationContext, sqls: string[]): TextEdit | undefined {
  const found = queryCall(context);
  if (!found) return;
  const { sourceFile, text, quote, eol } = context;
  const awaitPrefix = ts.isAwaitExpression(found.statement.expression) ? 'await ' : '';
  const callee = found.call.expression.getText(sourceFile);
  const indentation = indentationAt(text, found.statement.getStart(sourceFile));
  const lines = sqls.map(
    (sql) => `${eol}${indentation}${awaitPrefix}${callee}(${quote}${encode(sql, quote)}${quote});`,
  );
  return { start: found.statement.end, end: found.statement.end, text: lines.join('') };
}

function isTransactionStart(statement: SqlStatement): boolean {
  return /^(?:BEGIN|START\s+TRANSACTION)\b/i.test(statement.masked);
}

function isTransactionEnd(statement: SqlStatement): boolean {
  return /^(?:COMMIT|END|ROLLBACK)\b/i.test(statement.masked);
}

// The COMMIT closing an explicit BEGIN block around the statement, if there is one.
function closingCommit(context: MigrationContext, statement: SqlStatement): SqlStatement | null | undefined {
  const position = context.statements.indexOf(statement);
  let open = false;
  for (const earlier of context.statements.slice(0, position)) {
    if (isTransactionStart(earlier)) open = true;
    else if (isTransactionEnd(earlier)) open = false;
  }
  if (!open) return null;
  return context.statements.slice(position + 1).find(isTransactionEnd) ?? undefined;
}

function moveAfterCommit(
  context: MigrationContext,
  statement: SqlStatement,
  commit: SqlStatement,
  sqls: string[],
): FixResult | undefined {
  const removal = statementRemoval(context, statement);
  if (!removal) return;
  const at = commit.semicolon === null ? commit.end : commit.semicolon + 1;
  const prefix = commit.semicolon === null ? ';' : '';
  const insertion = { start: at, end: at, text: `${prefix}${context.eol}${sqls.join(';' + context.eol)};` };
  return {
    edits: [removal, insertion],
    note: 'Moved after COMMIT, so it runs after the rest of the transaction and outside it.',
  };
}

function nextPrismaFolder(migrationsDirectory: string, folder: string, step: number): string | undefined {
  const match = /^(\d+)_(.+)$/.exec(folder);
  if (!match) return;
  const timestamp = (BigInt(match[1]) + BigInt(step)).toString().padStart(match[1].length, '0');
  let existing: string[];
  try {
    existing = fs.readdirSync(migrationsDirectory);
  } catch {
    return;
  }
  // Another migration already holding this timestamp would run in between or clash.
  if (existing.some((name) => name.startsWith(timestamp + '_'))) return;
  return `${timestamp}_${match[2]}_step${step + 1}`;
}

// Prisma runs a multi-statement migration.sql in one transaction, so the concurrent statement gets
// a file of its own.
function prismaSplit(context: MigrationContext, statement: SqlStatement, sqls: string[]): FixResult | undefined {
  const { file, statements } = context;
  const folder = path.dirname(file);
  const migrationsDirectory = path.dirname(folder);
  const single = statements.length === 1;
  const edit = single ? replaceStatement(context, statement, sqls.slice(0, 1)) : statementRemoval(context, statement);
  if (!edit) return;
  const groups = (single ? [sqls.slice(1)] : [sqls.slice(0, 1), sqls.slice(1)]).filter((group) => group.length);
  const targets: FileTarget[] = [{ file, edits: [edit] }];
  for (const [index, group] of groups.entries()) {
    const name = nextPrismaFolder(migrationsDirectory, path.basename(folder), index + 1);
    if (!name) return;
    const created = siblingPath(file, migrationsDirectory, name, 'migration.sql');
    targets.push({ file: created, create: true, text: group.join(';\n') + ';\n' });
  }
  return {
    targets,
    note: 'Prisma runs a migration file with several statements in one transaction, so the statement that must run outside it now has a migration of its own, right after this one. Check that nothing later in this file depends on it.',
  };
}

function typeormTransactionEdit(context: MigrationContext): TransactionEdit | undefined {
  const owner = context.node && ancestor(context.node, ts.isClassLike);
  if (!owner || !owner.members.length) return;
  const existing = owner.members.find(
    (member): member is PropertyDeclaration =>
      ts.isPropertyDeclaration(member) && member.name.getText(context.sourceFile) === 'transaction',
  );
  if (existing?.initializer?.kind === ts.SyntaxKind.FalseKeyword) return { edits: [] };
  if (existing?.initializer) {
    const start = existing.initializer.getStart(context.sourceFile);
    return { edits: [{ start, end: existing.initializer.end, text: 'false' }], note: TYPEORM_TRANSACTION_NOTE };
  }
  return { edits: [insertLinesBefore(owner.members[0], ['transaction = false;'])], note: TYPEORM_TRANSACTION_NOTE };
}

function mikroOrmTransactionEdit(context: MigrationContext): TransactionEdit | undefined {
  const owner = context.node && ancestor(context.node, ts.isClassLike);
  if (!owner || !owner.members.length) return;
  // An existing isTransactional() may decide at run time; rewriting its body is left to a person.
  const declared = owner.members.some(
    (member) => ts.isMethodDeclaration(member) && member.name.getText(context.sourceFile) === 'isTransactional',
  );
  if (declared) return;
  const fileName = context.sourceFile?.fileName;
  if (fileName === undefined) return;
  const typed = /\.[cm]?tsx?$/i.test(fileName);
  const signature = typed ? 'override isTransactional(): boolean {' : 'isTransactional() {';
  return {
    edits: [insertLinesBefore(owner.members[0], [signature, '  return false;', '}'])],
    note: MIKRO_ORM_TRANSACTION_NOTE,
  };
}

function knexTransactionEdit(context: MigrationContext): TransactionEdit | undefined {
  if (/\bconfig\s*=\s*\{[^}]*\btransaction\s*:\s*false/.test(context.text)) return { edits: [] };
  const topLevel =
    context.node && ancestor(context.node, (current) => current.parent && ts.isSourceFile(current.parent));
  if (!topLevel) return;
  const commonJs = /\b(?:module\.)?exports\.\w+\s*=/.test(context.text);
  const line = commonJs ? 'exports.config = { transaction: false };' : 'export const config = { transaction: false };';
  return { edits: [insertLinesBefore(topLevel, [line, ''])], note: KNEX_TRANSACTION_NOTE };
}

export function insideSequelizeTransaction(node: Node | undefined): boolean {
  return Boolean(
    node &&
    ancestor(
      node,
      (current) =>
        ts.isCallExpression(current) &&
        ts.isPropertyAccessExpression(current.expression) &&
        current.expression.name.text === 'transaction' &&
        current.arguments.some((argument) => ts.isFunctionLike(argument)),
    ),
  );
}

// Edits that take the code migration out of its default transaction; undefined when that is not
// possible here.
function codeTransactionEdit(context: MigrationContext): TransactionEdit | undefined {
  if (context.framework === 'typeorm') return typeormTransactionEdit(context);
  if (context.framework === 'knex') return knexTransactionEdit(context);
  if (context.framework === 'mikro-orm') return mikroOrmTransactionEdit(context);
  if (context.framework === 'sequelize' && insideSequelizeTransaction(context.node)) return;
  return { edits: [] };
}

function placeInSqlFile(
  context: MigrationContext,
  statement: SqlStatement,
  plan: PlacementPlan,
): FixResult | undefined {
  const { sqls, outsideTransaction } = plan;
  if (outsideTransaction && context.framework === 'drizzle') return;
  if (outsideTransaction && context.framework === 'prisma' && (context.statements.length > 1 || sqls.length > 1)) {
    return prismaSplit(context, statement, sqls);
  }
  const commit = outsideTransaction ? closingCommit(context, statement) : null;
  if (commit === undefined) return;
  if (commit) return moveAfterCommit(context, statement, commit, sqls);
  return { edits: [replaceStatement(context, statement, sqls)] };
}

function placeInCode(context: MigrationContext, statement: SqlStatement, plan: PlacementPlan): FixResult | undefined {
  const { sqls, outsideTransaction } = plan;
  if (!outsideTransaction) return { edits: [replaceStatement(context, statement, sqls)] };
  const transaction = codeTransactionEdit(context);
  if (!transaction) return;
  // A query string with several statements runs as one implicit transaction, so each gets its own
  // call.
  const single = context.statements.length === 1;
  const inPlace = single
    ? replaceStatement(context, statement, sqls.slice(0, 1))
    : statementRemoval(context, statement);
  const rest = single ? sqls.slice(1) : sqls;
  const after = rest.length ? callsAfter(context, rest) : null;
  if (!inPlace || after === undefined) return;
  // The new call runs after the whole query string, so the statement now follows the ones that came
  // after it.
  const movedPastLater = !single && context.statements.at(-1) !== statement;
  const note = joinNotes(transaction.note, movedPastLater && MOVED_PAST_LATER_NOTE);
  return { edits: [...transaction.edits, inPlace, ...(after ? [after] : [])], note };
}

export function joinNotes(...notes: Notes): string {
  return notes.filter(Boolean).join(' ');
}

// plan: { sqls, outsideTransaction?, note? } replacing the flagged statement.
export function place(context: MigrationContext, plan: PlacementPlan): FixResult | undefined {
  const { statement } = context;
  if (!statement) return;
  const placed = context.sourceFile ? placeInCode(context, statement, plan) : placeInSqlFile(context, statement, plan);
  if (!placed) return;
  const note = joinNotes(plan.note, placed.note);
  if (placed.targets) return { targets: placed.targets, note };
  return { edits: placed.edits, ...(note ? { note } : {}) };
}
