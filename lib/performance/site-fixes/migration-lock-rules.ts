// Migration site-fix rules for indexes, constraints, transactions, lock timeouts and online
// table rewrites.
import { quoteIdentifier } from '../migrations/operations.js';
import { ts, ancestor, insertLinesBefore } from './helpers.js';
import {
  IDENT,
  alterParts,
  groupText,
  hasIndices,
  lastNamePart,
  mask,
  sliceOf,
  splice,
  subcommandAt,
  unquote,
} from './migration-context.js';
import { insideSequelizeTransaction, joinNotes, place } from './migration-placement.js';
import type { CallExpression, Node } from 'typescript';
import type { FixResult } from '../../shared/types.js';
import type { BlockBodyFunction, MigrationContext } from '../types/migrations.js';

const LOCK_TIMEOUT_SQL = "SET lock_timeout = '5s'";
const INVALID_INDEX_NOTE =
  'If a concurrent build fails it leaves an INVALID index behind: drop it with `DROP INDEX CONCURRENTLY` and rerun.';

const LOCK_TIMEOUT_RECEIVERS: Record<string, string> = {
  typeorm: '.query',
  knex: '.raw',
  sequelize: '.sequelize.query',
};

function sequelizeAddIndexConcurrently(context: MigrationContext): FixResult | undefined {
  if (context.framework !== 'sequelize' || !context.node) return;
  const call = ancestor(
    context.node,
    (current): current is CallExpression =>
      ts.isCallExpression(current) &&
      ts.isPropertyAccessExpression(current.expression) &&
      current.expression.name.text === 'addIndex',
  );
  if (!call || insideSequelizeTransaction(call)) return;
  const options = call.arguments.at(-1);
  const hasOptions = options && ts.isObjectLiteralExpression(options) && call.arguments.length >= 2;
  const note = INVALID_INDEX_NOTE;
  if (!hasOptions) {
    const last = call.arguments.at(-1);
    if (!last || call.arguments.length !== 2) return;
    return { edits: [{ start: last.end, end: last.end, text: ', { concurrently: true }' }], note };
  }
  if (options.properties.some((property) => property.name?.getText(context.sourceFile) === 'concurrently')) return;
  const first = options.properties[0];
  if (!first) {
    return {
      edits: [{ start: options.getStart(context.sourceFile), end: options.end, text: '{ concurrently: true }' }],
      note,
    };
  }
  const start = first.getStart(context.sourceFile);
  return { edits: [{ start, end: start, text: 'concurrently: true, ' }], note };
}

export function indexNotConcurrent(context: MigrationContext): FixResult | undefined {
  if (!context.statement) return sequelizeAddIndexConcurrently(context);
  const { sql, masked } = context.statement;
  const match = /^CREATE\s+(?:UNIQUE\s+)?INDEX\b/i.exec(masked);
  if (!match || /\bCONCURRENTLY\b/i.test(masked)) return;
  const fixed = splice(sql, match[0].length, match[0].length, ' CONCURRENTLY');
  return place(context, { sqls: [fixed], outsideTransaction: true, note: INVALID_INDEX_NOTE });
}

export function concurrentInTransaction(context: MigrationContext): FixResult | undefined {
  if (!context.statement) return;
  return place(context, {
    sqls: [context.statement.sql],
    outsideTransaction: true,
    note: 'Each statement now commits on its own, so keep it idempotent (`IF NOT EXISTS` / `IF EXISTS`).',
  });
}

export function constraintNotValid(context: MigrationContext): FixResult | undefined {
  const { statement } = context;
  if (!statement) return;
  if (/^ALTER\s+TABLE\b[\s\S]*\bVALIDATE\s+CONSTRAINT\b/i.test(statement.masked)) {
    return place(context, {
      sqls: [statement.sql],
      outsideTransaction: true,
      note: 'VALIDATE CONSTRAINT now runs after the NOT VALID add has committed, so the add only holds its lock briefly.',
    });
  }
  const parts = alterParts(statement);
  if (!parts) return;
  const part = subcommandAt(parts, context.relativeOffset);
  const command = sliceOf(statement, part);
  if (!/^ADD\b/i.test(command.masked) || /\bNOT\s+VALID\b/i.test(command.masked)) return;
  const named = new RegExp(String.raw`^ADD\s+CONSTRAINT\s+(${IDENT})`, 'id').exec(command.masked);
  const name = hasIndices(named) ? groupText(command.sql, named, 1) : '<constraint name>';
  return place(context, {
    sqls: [splice(statement.sql, part.end, part.end, ' NOT VALID')],
    note: `New and updated rows are checked right away. In a later migration run \`ALTER TABLE ${parts.table} VALIDATE CONSTRAINT ${name};\`, which allows reads and writes while it scans.`,
  });
}

export function constraintWithoutIndex(context: MigrationContext): FixResult | undefined {
  const { statement } = context;
  if (!statement) return;
  const parts = alterParts(statement);
  if (!parts || parts.subcommands.length !== 1) return;
  const command = sliceOf(statement, parts.subcommands[0]);
  const match = new RegExp(
    String.raw`^ADD\s+(?:CONSTRAINT\s+(${IDENT})\s+)?(UNIQUE|PRIMARY\s+KEY)\s*\(([^()]*)\)\s*$`,
    'id',
  ).exec(command.masked);
  if (!hasIndices(match)) return;
  const columnList = groupText(command.sql, match, 3);
  const list = `(${columnList})`;
  const columns = columnList.split(',').map((column) => column.trim());
  if (!columns.every((column) => new RegExp(`^${IDENT}$`).test(column))) return;
  const primary = /^PRIMARY/i.test(match[2]);
  const table = lastNamePart(parts.table);
  const name = match[1]
    ? groupText(command.sql, match, 1)
    : quoteIdentifier(primary ? `${table}_pkey` : `${table}_${columns.map(unquote).join('_')}_key`);
  const kind = primary ? 'PRIMARY KEY' : 'UNIQUE';
  return place(context, {
    sqls: [
      `CREATE UNIQUE INDEX CONCURRENTLY ${name} ON ${parts.table} ${list}`,
      `ALTER TABLE ${parts.table} ADD CONSTRAINT ${name} ${kind} USING INDEX ${name}`,
    ],
    outsideTransaction: true,
    note: joinNotes(
      INVALID_INDEX_NOTE,
      primary
        ? 'A primary key also needs NOT NULL columns; prove them first with a validated `CHECK (... IS NOT NULL)`.'
        : 'Existing duplicates make the build fail.',
    ),
  });
}

function upFunction(node: Node): BlockBodyFunction | undefined {
  return ancestor(node, (current): current is BlockBodyFunction => {
    if (!ts.isFunctionLike(current) || !('body' in current) || !current.body || !ts.isBlock(current.body)) return false;
    const ownName = 'name' in current ? current.name : undefined;
    const owner = ownName ?? (ts.isPropertyAssignment(current.parent) ? current.parent.name : undefined);
    if (owner?.getText() === 'up') return true;
    const assignment = current.parent;
    return ts.isBinaryExpression(assignment) && /(?:^|\.)up$/.test(assignment.left.getText());
  });
}

function lockTimeoutInCode(context: MigrationContext): FixResult | undefined {
  const receiver = LOCK_TIMEOUT_RECEIVERS[context.framework];
  const fn = context.node && upFunction(context.node);
  if (!receiver || !fn) return;
  const first = fn.body.statements[0];
  const parameter = fn.parameters[0]?.name;
  const isAsync = (ts.getModifiers(fn) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword);
  if (!first || !parameter || !ts.isIdentifier(parameter) || !isAsync) return;
  return {
    edits: [insertLinesBefore(first, [`await ${parameter.text}${receiver}("${LOCK_TIMEOUT_SQL}");`])],
    note: 'Skip this if the migration runner already sets `lock_timeout` on its connection. Retry the migration when it times out.',
  };
}

export function missingLockTimeout(context: MigrationContext): FixResult | undefined {
  if (context.sourceFile) return lockTimeoutInCode(context);
  if (!context.statement) return;
  return place(context, {
    sqls: [LOCK_TIMEOUT_SQL, context.statement.sql],
    note: 'Skip this if the migration runner already sets `lock_timeout` on its connection. Retry the migration when it times out.',
  });
}

export function tableRewriteCommand(context: MigrationContext): FixResult | undefined {
  const { statement } = context;
  if (!statement) return;
  // VACUUM FULL and CLUSTER have no online form in SQL; they need pg_repack, which is not a
  // migration statement.
  const match = /^REINDEX\s+(?:\([^)]*\)\s*)?(?:INDEX|TABLE|SCHEMA|DATABASE)\b/i.exec(statement.masked);
  if (!match || /\bCONCURRENTLY\b/i.test(statement.masked)) return;
  return place(context, {
    sqls: [splice(statement.sql, match[0].length, match[0].length, ' CONCURRENTLY')],
    outsideTransaction: true,
    note: 'REINDEX CONCURRENTLY needs PostgreSQL 12+. A failed run leaves `_ccnew` invalid indexes to drop.',
  });
}

// States ALGORITHM=INPLACE and LOCK=NONE, replacing whatever the statement asked for.
function onlineMysqlStatement(context: MigrationContext, note: string): FixResult | undefined {
  const { statement } = context;
  if (!statement) return;
  const createIndex = /^CREATE\s+(?:UNIQUE\s+|FULLTEXT\s+|SPATIAL\s+)?INDEX\b/i.test(statement.masked);
  if (!createIndex && !/^ALTER\s+TABLE\b/i.test(statement.masked)) return;
  let { sql } = statement;
  const missing: string[] = [];
  const clauses: [RegExp, string][] = [
    [/\bALGORITHM\s*=?\s*\w+/i, 'ALGORITHM=INPLACE'],
    [/\bLOCK\s*=?\s*\w+/i, 'LOCK=NONE'],
  ];
  for (const [pattern, clause] of clauses) {
    const found = pattern.exec(mask(sql, context.quote === '`'));
    if (found) sql = splice(sql, found.index, found.index + found[0].length, clause);
    else missing.push(clause);
  }
  if (missing.length) sql += (createIndex ? ' ' : ', ') + missing.join(createIndex ? ' ' : ', ');
  if (sql === statement.sql) return;
  return place(context, { sqls: [sql], note });
}

export function mysqlTableCopy(context: MigrationContext): FixResult | undefined {
  return onlineMysqlStatement(
    context,
    'MySQL now refuses the statement with an error instead of copying the table and blocking writes. If it refuses, run the change with `gh-ost` or `pt-online-schema-change`, or add a new column, backfill in batches and swap.',
  );
}

export function mysqlLockUnspecified(context: MigrationContext): FixResult | undefined {
  return onlineMysqlStatement(
    context,
    'MySQL now fails instead of silently copying the table. `ALGORITHM=INSTANT` is better where supported (adding a column on MySQL 8.0.29+).',
  );
}
