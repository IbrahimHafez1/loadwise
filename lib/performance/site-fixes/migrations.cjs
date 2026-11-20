'use strict';

// Site fixes for migration findings. A finding carries only its file and position, so the flagged statement, the
// framework and the transaction around it are re-read here: from the raw text of a .sql file, or from the query
// literal (or the up() function) of a TypeORM, Knex or Sequelize migration. Each rule turns the statement into
// replacement SQL; `place` then writes it back where it can run (in place, after COMMIT, or in its own migration).
const fs = require('node:fs');
const path = require('node:path');
const { detectFramework } = require('../migrations/extract-code.cjs');
const { quoteIdentifier } = require('../migrations/operations.cjs');
const { ts, ancestor, enclosingStatement, indentationAt, insertLinesBefore, lineStart } = require('./helpers.cjs');

const LOCK_TIMEOUT_SQL = "SET lock_timeout = '5s'";
const IDENT = String.raw`(?:"[^"]*"|\x60[^\x60]*\x60|\$\{[^}]*\}|[A-Za-z_][\w$]*)`;
const QUALIFIED = String.raw`${IDENT}(?:\s*\.\s*${IDENT})*`;
const ALTER_HEADER = new RegExp(String.raw`^ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?(${QUALIFIED})\s*`, 'id');
const DOLLAR_QUOTE = /\$([A-Za-z_]\w*)?\$/y;
const COLUMN_CONSTRAINT_KEYWORD =
  /(?:NOT\s+NULL|NULL|CHECK|REFERENCES|UNIQUE|PRIMARY|CONSTRAINT|COLLATE|GENERATED)\b/iy;
const SIMPLE_ESCAPES = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', 0: '\0' };

const INVALID_INDEX_NOTE =
  'If a concurrent build fails it leaves an INVALID index behind: drop it with `DROP INDEX CONCURRENTLY` and rerun.';
const TYPEORM_TRANSACTION_NOTE =
  "Added `transaction = false`: TypeORM honours it only when migrations run with `migrationsTransactionMode: 'each'` (CLI `--transaction each`) and refuses it in the default `all` mode. The other statements of this migration no longer roll back together.";
const KNEX_TRANSACTION_NOTE =
  'Added `config = { transaction: false }`: the other statements of this migration no longer roll back together.';

// --- Scanning SQL text (raw file text, or the raw content of a JS string literal) -------------------------------

// Index just past the quoted string, comment or template hole that starts at `index`, or `index` when none does.
function skipOpaque(text, index, end, { escapes, holes }) {
  const char = text[index];
  const next = text[index + 1];
  if (escapes && char === '\\') return Math.min(index + 2, end);
  if (holes && char === '$' && next === '{') return closeBrace(text, index + 2, end);
  if (char === '-' && next === '-') {
    const newline = text.indexOf('\n', index);
    return newline === -1 || newline > end ? end : newline;
  }
  if (char === '/' && next === '*') {
    const close = text.indexOf('*/', index + 2);
    return close === -1 || close + 2 > end ? end : close + 2;
  }
  if (char === "'" || char === '"' || (char === '`' && !holes)) return closingQuote(text, index, end, char, escapes);
  if (char === '$' && !/[\w$]/.test(text[index - 1] ?? '')) {
    DOLLAR_QUOTE.lastIndex = index;
    const match = DOLLAR_QUOTE.exec(text);
    if (match) {
      const close = text.indexOf(match[0], index + match[0].length);
      return close === -1 ? end : Math.min(close + match[0].length, end);
    }
  }
  return index;
}

function closingQuote(text, index, end, quote, escapes) {
  for (let position = index + 1; position < end; position++) {
    if (escapes && text[position] === '\\') position++;
    else if (text[position] === quote) {
      if (text[position + 1] !== quote) return position + 1;
      position++;
    }
  }
  return end;
}

function closeBrace(text, index, end) {
  let depth = 1;
  for (let position = index; position < end; position++) {
    if (text[position] === '{') depth++;
    else if (text[position] === '}' && --depth === 0) return position + 1;
  }
  return end;
}

// Calls `visit(index, char, depth)` for every character outside strings, comments and template holes.
function scanCode(text, start, end, options, visit) {
  let depth = 0;
  for (let index = start; index < end;) {
    const skipped = skipOpaque(text, index, end, options);
    if (skipped !== index) {
      index = skipped;
      continue;
    }
    const char = text[index];
    if (char === '(') depth++;
    else if (char === ')') depth--;
    else visit(index, char, depth);
    index++;
  }
}

// The same text with string, identifier and comment contents blanked, so keyword regexes only see SQL code.
function mask(sql, holes) {
  let masked = '';
  let index = 0;
  const options = { escapes: false, holes };
  while (index < sql.length) {
    const skipped = skipOpaque(sql, index, sql.length, options);
    if (skipped === index) {
      masked += sql[index++];
      continue;
    }
    const span = sql.slice(index, skipped);
    const keepsDelimiters = /^["'`]|^\$\{/.test(span) && span.length >= 2;
    masked += keepsDelimiters ? span[0] + ' '.repeat(span.length - 2) + span.at(-1) : ' '.repeat(span.length);
    index = skipped;
  }
  return masked;
}

function skipLeadingTrivia(text, start, end, options) {
  let index = start;
  for (;;) {
    while (index < end && /\s/.test(text[index])) index++;
    const isComment = text.startsWith('--', index) || text.startsWith('/*', index);
    if (!isComment) return index;
    index = skipOpaque(text, index, end, options);
  }
}

function splitStatements(text, start, end, options) {
  const statements = [];
  let from = start;
  const push = (to, semicolon) => {
    const first = skipLeadingTrivia(text, from, to, options);
    let last = to;
    while (last > first && /\s/.test(text[last - 1])) last--;
    if (last > first) statements.push({ start: first, end: last, semicolon });
  };
  scanCode(text, start, end, options, (index, char) => {
    if (char !== ';') return;
    push(index, index);
    from = index + 1;
  });
  push(end, null);
  return statements;
}

// --- Literal encoding --------------------------------------------------------------------------------------------

function decodeRaw(raw, quote) {
  if (!quote) return raw;
  return raw.replace(/\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|\r?\n|[\s\S])/g, (match, escape) => {
    if (escape.startsWith('u') && escape.length > 1)
      return String.fromCodePoint(parseInt(escape.replace(/[u{}]/g, ''), 16));
    if (escape.startsWith('x') && escape.length === 3) return String.fromCharCode(parseInt(escape.slice(1), 16));
    if (escape.includes('\n')) return '';
    return SIMPLE_ESCAPES[escape] ?? escape;
  });
}

function encode(sql, quote) {
  if (!quote) return sql;
  const escaped = sql.replaceAll('\\', '\\\\');
  if (quote === '`') return escaped.replaceAll('`', '\\`');
  return escaped.replaceAll(quote, '\\' + quote).replace(/\r?\n/g, '\\n');
}

// --- Context: where the flagged statement is and what runs it ------------------------------------------------------

function offsetOf(text, line, column) {
  let start = 0;
  for (let row = 1; row < line; row++) {
    start = text.indexOf('\n', start) + 1;
    if (start === 0) return undefined;
  }
  return start + column - 1;
}

function siblingPath(file, ...parts) {
  const join = file.includes('\\') ? path.join : path.posix.join;
  return join(...parts);
}

function sqlFileFramework(file, load) {
  const directory = path.dirname(file);
  if (path.basename(file) === 'migration.sql' && load(path.join(directory, '..', 'migration_lock.toml'))) {
    return 'prisma';
  }
  if (load(path.join(directory, 'meta', '_journal.json'))) return 'drizzle';
  return 'sql';
}

function enclosingLiteral(node) {
  return ancestor(
    node,
    (current) =>
      ts.isStringLiteral(current) || ts.isNoSubstitutionTemplateLiteral(current) || ts.isTemplateExpression(current),
  );
}

function migrationContext({ finding, node, sourceFile, text, load }) {
  if (typeof text !== 'string' || typeof finding.file !== 'string') return;
  const offset = offsetOf(text, finding.line, finding.column);
  if (offset === undefined) return;
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const context = { finding, node, sourceFile, text, load, offset, eol, file: finding.file };
  if (!sourceFile) {
    Object.assign(context, { framework: sqlFileFramework(finding.file, load), quote: null, regionStart: 0 });
    context.regionEnd = text.length;
  } else {
    context.framework = detectFramework(text);
    const literal = node && enclosingLiteral(node);
    if (!literal) return context;
    const literalStart = literal.getStart(sourceFile);
    Object.assign(context, { literal, quote: text[literalStart], regionStart: literalStart + 1 });
    context.regionEnd = literal.end - 1;
  }
  const options = { escapes: Boolean(context.quote), holes: context.quote === '`' };
  context.statements = splitStatements(text, context.regionStart, context.regionEnd, options).map((statement) => {
    const sql = decodeRaw(text.slice(statement.start, statement.end), context.quote);
    return { ...statement, sql, masked: mask(sql, options.holes) };
  });
  context.statement =
    context.statements.find(
      (statement) => statement.start <= offset && offset <= (statement.semicolon ?? statement.end),
    ) ?? context.statements.findLast((statement) => statement.start <= offset);
  if (context.statement) {
    const before = text.slice(context.statement.start, Math.max(offset, context.statement.start));
    context.relativeOffset = decodeRaw(before, context.quote).length;
  }
  return context;
}

// --- Statement anatomy ---------------------------------------------------------------------------------------------

function unquote(name) {
  if (/^".*"$/s.test(name)) return name.slice(1, -1).replaceAll('""', '"');
  if (/^`.*`$/s.test(name)) return name.slice(1, -1).replaceAll('``', '`');
  return name;
}

// The original text of a capture group of a regex (with the `d` flag) that matched the masked SQL.
function groupText(sql, match, index) {
  const [start, end] = match.indices[index];
  return sql.slice(start, end);
}

function lastNamePart(qualified) {
  const parts = qualified.match(new RegExp(IDENT, 'g'));
  return unquote(parts.at(-1));
}

// `ALTER TABLE t a, b` -> the table text and each comma-separated sub-command as offsets into the statement SQL.
function alterParts(statement) {
  const header = ALTER_HEADER.exec(statement.masked);
  if (!header) return;
  const subcommands = [];
  let from = header[0].length;
  const push = (to) => {
    const text = statement.masked.slice(from, to);
    const start = from + (text.length - text.trimStart().length);
    const end = to - (text.length - text.trimEnd().length);
    if (end > start) subcommands.push({ start, end });
  };
  scanCode(statement.masked, from, statement.masked.length, { escapes: false, holes: false }, (index, char, depth) => {
    if (char !== ',' || depth !== 0) return;
    push(index);
    from = index + 1;
  });
  push(statement.masked.length);
  return { table: groupText(statement.sql, header, 1), subcommands };
}

function subcommandAt(parts, relativeOffset) {
  return (
    parts.subcommands.find((part) => part.start <= relativeOffset && relativeOffset <= part.end) ?? parts.subcommands[0]
  );
}

function sliceOf(statement, part) {
  return { sql: statement.sql.slice(part.start, part.end), masked: statement.masked.slice(part.start, part.end) };
}

function splice(text, start, end, replacement) {
  return text.slice(0, start) + replacement + text.slice(end);
}

function replaceSubcommand(statement, part, replacement) {
  return splice(statement.sql, part.start, part.end, replacement);
}

// The statement without one sub-command and the comma that joined it to its neighbour.
function withoutSubcommand(statement, parts, part) {
  const index = parts.subcommands.indexOf(part);
  const start = index === 0 ? part.start : statement.masked.lastIndexOf(',', part.start);
  const end = index === 0 ? parts.subcommands[1].start : part.end;
  return splice(statement.sql, start, end, '');
}

// --- Writing replacement SQL back ----------------------------------------------------------------------------------

function joinSeparator(context, statement) {
  if (!context.quote) return ';' + context.eol;
  if (context.quote === '`') return ';\n' + indentationAt(context.text, statement.start);
  return '; ';
}

function replaceStatement(context, sqls) {
  const { statement } = context;
  const text = sqls.map((sql) => encode(sql, context.quote)).join(joinSeparator(context, statement));
  return { start: statement.start, end: statement.end, text };
}

// Deletes the statement with its semicolon, leaving the neighbouring statements intact.
function statementRemoval(context, statement) {
  const { text } = context;
  if (statement.semicolon === null) {
    const previous = context.statements[context.statements.indexOf(statement) - 1];
    return previous && { start: previous.semicolon + 1, end: statement.end, text: '' };
  }
  const trailing = /^[ \t]*(?:\r?\n)?/.exec(text.slice(statement.semicolon + 1, context.regionEnd))[0];
  const lineBegin = Math.max(lineStart(text, statement.start), context.regionStart);
  const start = /^[ \t]*$/.test(text.slice(lineBegin, statement.start)) && trailing ? lineBegin : statement.start;
  return { start, end: statement.semicolon + 1 + trailing.length, text: '' };
}

// The call whose argument is the query literal, and the statement it is awaited in.
function queryCall(context) {
  const call = context.literal.parent;
  if (!call || !ts.isCallExpression(call) || !call.arguments.includes(context.literal)) return;
  const statement = enclosingStatement(call);
  if (!statement || !ts.isExpressionStatement(statement) || !ts.isBlock(statement.parent)) return;
  return { call, statement };
}

// New `await queryRunner.query(...)` calls after the flagged one, one per statement, so each runs on its own.
function callsAfter(context, sqls) {
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

function isTransactionStart(statement) {
  return /^(?:BEGIN|START\s+TRANSACTION)\b/i.test(statement.masked);
}

function isTransactionEnd(statement) {
  return /^(?:COMMIT|END|ROLLBACK)\b/i.test(statement.masked);
}

// The COMMIT closing an explicit BEGIN block around the statement, if there is one.
function closingCommit(context) {
  const position = context.statements.indexOf(context.statement);
  let open = false;
  for (const statement of context.statements.slice(0, position)) {
    if (isTransactionStart(statement)) open = true;
    else if (isTransactionEnd(statement)) open = false;
  }
  if (!open) return null;
  return context.statements.slice(position + 1).find(isTransactionEnd) ?? undefined;
}

function moveAfterCommit(context, commit, sqls) {
  const removal = statementRemoval(context, context.statement);
  if (!removal) return;
  const at = commit.semicolon === null ? commit.end : commit.semicolon + 1;
  const prefix = commit.semicolon === null ? ';' : '';
  const insertion = { start: at, end: at, text: `${prefix}${context.eol}${sqls.join(';' + context.eol)};` };
  return {
    edits: [removal, insertion],
    note: 'Moved after COMMIT, so it runs after the rest of the transaction and outside it.',
  };
}

function nextPrismaFolder(migrationsDirectory, folder, step) {
  const match = /^(\d+)_(.+)$/.exec(folder);
  if (!match) return;
  const timestamp = (BigInt(match[1]) + BigInt(step)).toString().padStart(match[1].length, '0');
  let existing;
  try {
    existing = fs.readdirSync(migrationsDirectory);
  } catch {
    return;
  }
  // Another migration already holding this timestamp would run in between or clash.
  if (existing.some((name) => name.startsWith(timestamp + '_'))) return;
  return `${timestamp}_${match[2]}_step${step + 1}`;
}

// Prisma runs a multi-statement migration.sql in one transaction, so the concurrent statement gets a file of its own.
function prismaSplit(context, sqls) {
  const { file, statements } = context;
  const folder = path.dirname(file);
  const migrationsDirectory = path.dirname(folder);
  const single = statements.length === 1;
  const edit = single ? replaceStatement(context, sqls.slice(0, 1)) : statementRemoval(context, context.statement);
  if (!edit) return;
  const groups = (single ? [sqls.slice(1)] : [sqls.slice(0, 1), sqls.slice(1)]).filter((group) => group.length);
  const targets = [{ file, edits: [edit] }];
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

function typeormTransactionEdit(context) {
  const owner = ancestor(context.node, ts.isClassLike);
  if (!owner || !owner.members.length) return;
  const existing = owner.members.find(
    (member) => ts.isPropertyDeclaration(member) && member.name.getText(context.sourceFile) === 'transaction',
  );
  if (existing?.initializer?.kind === ts.SyntaxKind.FalseKeyword) return { edits: [] };
  if (existing?.initializer) {
    const start = existing.initializer.getStart(context.sourceFile);
    return { edits: [{ start, end: existing.initializer.end, text: 'false' }], note: TYPEORM_TRANSACTION_NOTE };
  }
  return { edits: [insertLinesBefore(owner.members[0], ['transaction = false;'])], note: TYPEORM_TRANSACTION_NOTE };
}

function knexTransactionEdit(context) {
  if (/\bconfig\s*=\s*\{[^}]*\btransaction\s*:\s*false/.test(context.text)) return { edits: [] };
  const topLevel = ancestor(context.node, (current) => current.parent && ts.isSourceFile(current.parent));
  if (!topLevel) return;
  const commonJs = /\b(?:module\.)?exports\.\w+\s*=/.test(context.text);
  const line = commonJs ? 'exports.config = { transaction: false };' : 'export const config = { transaction: false };';
  return { edits: [insertLinesBefore(topLevel, [line, ''])], note: KNEX_TRANSACTION_NOTE };
}

function insideSequelizeTransaction(node) {
  return Boolean(
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

// Edits that take the code migration out of its default transaction; undefined when that is not possible here.
function codeTransactionEdit(context) {
  if (context.framework === 'typeorm') return typeormTransactionEdit(context);
  if (context.framework === 'knex') return knexTransactionEdit(context);
  if (context.framework === 'sequelize' && insideSequelizeTransaction(context.node)) return;
  return { edits: [] };
}

function placeInSqlFile(context, plan) {
  const { sqls, outsideTransaction } = plan;
  if (outsideTransaction && context.framework === 'drizzle') return;
  if (outsideTransaction && context.framework === 'prisma' && (context.statements.length > 1 || sqls.length > 1)) {
    return prismaSplit(context, sqls);
  }
  const commit = outsideTransaction ? closingCommit(context) : null;
  if (commit === undefined) return;
  if (commit) return moveAfterCommit(context, commit, sqls);
  return { edits: [replaceStatement(context, sqls)] };
}

function placeInCode(context, plan) {
  const { sqls, outsideTransaction } = plan;
  if (!outsideTransaction) return { edits: [replaceStatement(context, sqls)] };
  const transaction = codeTransactionEdit(context);
  if (!transaction) return;
  // A query string with several statements runs as one implicit transaction, so each gets its own call.
  const single = context.statements.length === 1;
  const inPlace = single ? replaceStatement(context, sqls.slice(0, 1)) : statementRemoval(context, context.statement);
  const rest = single ? sqls.slice(1) : sqls;
  const after = rest.length ? callsAfter(context, rest) : null;
  if (!inPlace || after === undefined) return;
  return { edits: [...transaction.edits, inPlace, ...(after ? [after] : [])], note: transaction.note };
}

function joinNotes(...notes) {
  return notes.filter(Boolean).join(' ');
}

// plan: { sqls, outsideTransaction?, note? } replacing the flagged statement.
function place(context, plan) {
  const placed = context.sourceFile ? placeInCode(context, plan) : placeInSqlFile(context, plan);
  if (!placed) return;
  const note = joinNotes(plan.note, placed.note);
  if (placed.targets) return { targets: placed.targets, note };
  return { edits: placed.edits, ...(note && { note }) };
}

// --- Rules ---------------------------------------------------------------------------------------------------------

function sequelizeAddIndexConcurrently(context) {
  if (context.framework !== 'sequelize' || !context.node) return;
  const call = ancestor(
    context.node,
    (current) =>
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

function indexNotConcurrent(context) {
  if (!context.statement) return sequelizeAddIndexConcurrently(context);
  const { sql, masked } = context.statement;
  const match = /^CREATE\s+(?:UNIQUE\s+)?INDEX\b/i.exec(masked);
  if (!match || /\bCONCURRENTLY\b/i.test(masked)) return;
  const fixed = splice(sql, match[0].length, match[0].length, ' CONCURRENTLY');
  return place(context, { sqls: [fixed], outsideTransaction: true, note: INVALID_INDEX_NOTE });
}

function concurrentInTransaction(context) {
  if (!context.statement) return;
  return place(context, {
    sqls: [context.statement.sql],
    outsideTransaction: true,
    note: 'Each statement now commits on its own, so keep it idempotent (`IF NOT EXISTS` / `IF EXISTS`).',
  });
}

const MYSQL_IMPLICIT_DEFAULTS = [
  [/^(?:tiny|small|medium|big)?int(?:eger)?$|^(?:decimal|dec|numeric|float|double|real|bit|bool|boolean)$/, '0'],
  [/^(?:var)?(?:char|binary)$/, "''"],
];

function mysqlNotNullDefault(context, statement, parts, part) {
  const column = sliceOf(statement, part);
  const definition = new RegExp(String.raw`^ADD\s+(?:COLUMN\s+)?${IDENT}\s+(\w+)`, 'i').exec(column.masked);
  const notNull = /\bNOT\s+NULL\b/i.exec(column.masked);
  if (!definition || !notNull) return;
  const value = MYSQL_IMPLICIT_DEFAULTS.find(([pattern]) => pattern.test(definition[1].toLowerCase()))?.[1];
  if (value === undefined) return;
  const at = part.start + notNull.index + notNull[0].length;
  return place(context, {
    sqls: [splice(statement.sql, at, at, ` DEFAULT ${value}`)],
    note: `\`DEFAULT ${value}\` is the value MySQL already gives existing rows; make sure it is a correct value for them (or choose a better one), so app versions that do not write this column keep working.`,
  });
}

function notNullWithoutDefault(context) {
  const { statement } = context;
  const parts = statement && alterParts(statement);
  if (!parts) return;
  const part = subcommandAt(parts, context.relativeOffset);
  if (!/^ADD\b/i.test(sliceOf(statement, part).masked)) return;
  if (/\bMySQL\b/.test(context.finding.message ?? '')) return mysqlNotNullDefault(context, statement, parts, part);
  const notNull = /\s+NOT\s+NULL\b/i.exec(sliceOf(statement, part).masked);
  if (!notNull) return;
  const start = part.start + notNull.index;
  return place(context, {
    sqls: [splice(statement.sql, start, start + notNull[0].length, '')],
    note: 'The column is now added nullable. Make every running app version write it, backfill old rows in batches, then enforce it in a later migration with `CHECK (... IS NOT NULL) NOT VALID`, `VALIDATE CONSTRAINT` and `SET NOT NULL`.',
  });
}

// End of a column DEFAULT expression: the next top-level column constraint keyword, or the end of the definition.
function defaultExpressionEnd(masked, from) {
  let depth = 0;
  for (let index = from; index < masked.length; index++) {
    const char = masked[index];
    if (char === '(') depth++;
    else if (char === ')') depth--;
    else if (depth === 0 && /\s/.test(char)) {
      COLUMN_CONSTRAINT_KEYWORD.lastIndex = index + 1;
      if (COLUMN_CONSTRAINT_KEYWORD.test(masked)) return index;
    }
  }
  return masked.length;
}

function volatileDefault(context) {
  const { statement } = context;
  const parts = statement && alterParts(statement);
  if (!parts) return;
  const part = subcommandAt(parts, context.relativeOffset);
  const column = sliceOf(statement, part);
  const definition = new RegExp(String.raw`^ADD\s+(?:COLUMN\s+)?(?:IF\s+NOT\s+EXISTS\s+)?(${IDENT})\s+`, 'id').exec(
    column.masked,
  );
  // serial, identity and stored generated columns have no default to move; they need a manual backfill plan.
  if (!definition || /\b(?:small|big)?serial\d?\b|\bGENERATED\b/i.test(column.masked)) return;
  const keyword = /\s+DEFAULT\s+/i.exec(column.masked);
  if (!keyword) return;
  const expressionStart = keyword.index + keyword[0].length;
  const expressionEnd = defaultExpressionEnd(column.masked, expressionStart);
  const expression = column.sql.slice(expressionStart, expressionEnd).trim();
  let definitionSql = splice(column.sql, keyword.index, expressionEnd, '');
  const notNull = /\s+NOT\s+NULL\b/i.exec(mask(definitionSql, context.quote === '`'));
  if (notNull) definitionSql = splice(definitionSql, notNull.index, notNull.index + notNull[0].length, '');
  const columnName = groupText(column.sql, definition, 1);
  const setDefault = `ALTER TABLE ${parts.table} ALTER COLUMN ${columnName} SET DEFAULT ${expression}`;
  return place(context, {
    sqls: [replaceSubcommand(statement, part, definitionSql), setDefault],
    note: joinNotes(
      `New rows get \`${expression}\` from the separate \`SET DEFAULT\`; backfill existing rows in batches.`,
      notNull &&
        'NOT NULL was dropped too, because existing rows are NULL until backfilled; enforce it afterwards with `CHECK (... IS NOT NULL) NOT VALID`, `VALIDATE CONSTRAINT` and `SET NOT NULL`.',
    ),
  });
}

function columnTypeRewrite(context) {
  const { statement } = context;
  const parts = statement && alterParts(statement);
  if (!parts || parts.subcommands.length !== 1) return;
  const part = parts.subcommands[0];
  const command = sliceOf(statement, part);
  const header = new RegExp(String.raw`^ALTER\s+(?:COLUMN\s+)?(${IDENT})\s+(?:SET\s+DATA\s+)?TYPE\s+`, 'id').exec(
    command.masked,
  );
  if (!header) return;
  const using = /\s+USING\s+/i.exec(command.masked.slice(header[0].length));
  const typeEnd = using ? header[0].length + using.index : command.sql.length;
  const type = command.sql.slice(header[0].length, typeEnd).trim();
  const column = groupText(command.sql, header, 1);
  const newColumn = /^".*"$/.test(column) ? `"${column.slice(1, -1)}_new"` : `${column}_new`;
  const backfill = using ? command.sql.slice(typeEnd + using[0].length).trim() : `${column}::${type}`;
  return place(context, {
    sqls: [replaceSubcommand(statement, part, `ADD COLUMN ${newColumn} ${type}`)],
    note: `Expand/contract instead of an in-place rewrite: this adds ${newColumn}. Then dual-write both columns from the app, backfill \`${newColumn} = ${backfill}\` in batches, switch reads to ${newColumn}, and drop ${column} (then rename) in a later release. If the change is a metadata-only widening (longer varchar, wider numeric), keep the original statement and mark it reviewed instead.`,
  });
}

function setNotNullScan(context) {
  const { statement } = context;
  const parts = statement && alterParts(statement);
  if (!parts || parts.subcommands.length !== 1) return;
  const command = sliceOf(statement, parts.subcommands[0]);
  const match = new RegExp(String.raw`^ALTER\s+(?:COLUMN\s+)?(${IDENT})\s+SET\s+NOT\s+NULL\s*$`, 'id').exec(
    command.masked,
  );
  if (!match) return;
  const column = groupText(command.sql, match, 1);
  const constraint = quoteIdentifier(`${lastNamePart(parts.table)}_${unquote(column)}_not_null`);
  const table = parts.table;
  return place(context, {
    sqls: [`ALTER TABLE ${table} ADD CONSTRAINT ${constraint} CHECK (${column} IS NOT NULL) NOT VALID`],
    note: `Backfill NULLs first. In a later migration run \`ALTER TABLE ${table} VALIDATE CONSTRAINT ${constraint};\`, \`ALTER TABLE ${table} ALTER COLUMN ${column} SET NOT NULL;\` (PostgreSQL 12+ skips the scan thanks to the validated check) and \`ALTER TABLE ${table} DROP CONSTRAINT ${constraint};\`.`,
  });
}

function constraintNotValid(context) {
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
  const name = named ? groupText(command.sql, named, 1) : '<constraint name>';
  return place(context, {
    sqls: [splice(statement.sql, part.end, part.end, ' NOT VALID')],
    note: `New and updated rows are checked right away. In a later migration run \`ALTER TABLE ${parts.table} VALIDATE CONSTRAINT ${name};\`, which allows reads and writes while it scans.`,
  });
}

function constraintWithoutIndex(context) {
  const { statement } = context;
  const parts = statement && alterParts(statement);
  if (!parts || parts.subcommands.length !== 1) return;
  const command = sliceOf(statement, parts.subcommands[0]);
  const match = new RegExp(
    String.raw`^ADD\s+(?:CONSTRAINT\s+(${IDENT})\s+)?(UNIQUE|PRIMARY\s+KEY)\s*\(([^()]*)\)\s*$`,
    'id',
  ).exec(command.masked);
  if (!match) return;
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

function sqlCommentLines(sql) {
  return sql.split(/\r?\n/).map((line) => `-- ${line.trim()}`);
}

const DEFER_NOTE =
  'Deferred: ship the drop in a later release, after no running app version reads or writes it. If none does already, restore it and mark it reviewed with `-- loadwise-reviewed migration-breaking-drop -- <reason>`.';

// Comments the dropped SQL out, keeping the rest of the statement, until a later release can run it.
function defer(context, remaining, deferred) {
  const { statement, text, eol } = context;
  const header = 'Deferred to a later release (expand/contract), once no running app version uses it:';
  if (!context.sourceFile) {
    const end = statement.semicolon === null ? statement.end : statement.semicolon + 1;
    const indentation = indentationAt(text, statement.start);
    const lines = ['-- ' + header, ...sqlCommentLines(deferred + ';')].join(eol + indentation);
    const kept = remaining ? `${remaining};${eol}${indentation}` : '';
    return { edits: [{ start: statement.start, end, text: kept + lines }], note: DEFER_NOTE };
  }
  const found = queryCall(context);
  if (!found) return;
  const comment = insertLinesBefore(found.statement, [`// ${header}`, `// ${deferred.replace(/\s+/g, ' ').trim()}`]);
  if (remaining) return { edits: [comment, replaceStatement(context, [remaining])], note: DEFER_NOTE };
  if (context.statements.length > 1)
    return { edits: [comment, statementRemoval(context, statement)], note: DEFER_NOTE };
  // The query held only the dropped statement: the comment replaces the whole call.
  const lineBreak = /^\r?\n/.exec(text.slice(found.statement.end))?.[0] ?? '';
  return { edits: [{ ...comment, end: found.statement.end + lineBreak.length }], note: DEFER_NOTE };
}

function breakingDrop(context) {
  const { statement } = context;
  if (!statement) return;
  if (/^DROP\s+TABLE\b/i.test(statement.masked)) {
    if (statement.masked.includes(',')) return;
    return defer(context, null, statement.sql);
  }
  const parts = alterParts(statement);
  if (!parts) return;
  const part = subcommandAt(parts, context.relativeOffset);
  const command = sliceOf(statement, part);
  if (!/^DROP\b/i.test(command.masked)) return;
  if (parts.subcommands.length === 1) return defer(context, null, statement.sql);
  return defer(context, withoutSubcommand(statement, parts, part), `ALTER TABLE ${parts.table} ${command.sql}`);
}

function breakingRename(context) {
  const { statement } = context;
  if (!statement) return;
  const alter = new RegExp(
    String.raw`^ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(${QUALIFIED})\s+RENAME\s+(?:TO|AS)\s+(${QUALIFIED})\s*$`,
    'id',
  );
  const rename = new RegExp(String.raw`^RENAME\s+TABLE\s+(${QUALIFIED})\s+TO\s+(${QUALIFIED})\s*$`, 'id');
  const match = alter.exec(statement.masked) ?? rename.exec(statement.masked);
  if (!match) return;
  const oldName = groupText(statement.sql, match, 1);
  const newName = groupText(statement.sql, match, 2);
  // PostgreSQL keeps a renamed table in its schema while MySQL moves it to the current database; skip the ambiguity.
  if (match[1].includes('.') !== match[2].includes('.')) return;
  return place(context, {
    sqls: [statement.sql, `CREATE VIEW ${oldName} AS SELECT * FROM ${newName}`],
    note: `Running app versions keep using ${oldName} through an updatable view over ${newName}. Drop the view in a later release, once no version uses the old name. The view keeps the column list of today, so add columns to ${newName} only after it is gone.`,
  });
}

function upFunction(node) {
  return ancestor(node, (current) => {
    if (!ts.isFunctionLike(current) || !current.body || !ts.isBlock(current.body)) return false;
    const owner = current.name ?? (ts.isPropertyAssignment(current.parent) ? current.parent.name : undefined);
    if (owner?.getText() === 'up') return true;
    const assignment = current.parent;
    return ts.isBinaryExpression(assignment) && /(?:^|\.)up$/.test(assignment.left.getText());
  });
}

const LOCK_TIMEOUT_RECEIVERS = { typeorm: '.query', knex: '.raw', sequelize: '.sequelize.query' };

function lockTimeoutInCode(context) {
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

function missingLockTimeout(context) {
  if (context.sourceFile) return lockTimeoutInCode(context);
  if (!context.statement) return;
  return place(context, {
    sqls: [LOCK_TIMEOUT_SQL, context.statement.sql],
    note: 'Skip this if the migration runner already sets `lock_timeout` on its connection. Retry the migration when it times out.',
  });
}

function tableRewriteCommand(context) {
  const { statement } = context;
  if (!statement) return;
  // VACUUM FULL and CLUSTER have no online form in SQL; they need pg_repack, which is not a migration statement.
  const match = /^REINDEX\s+(?:\([^)]*\)\s*)?(?:INDEX|TABLE|SCHEMA|DATABASE)\b/i.exec(statement.masked);
  if (!match || /\bCONCURRENTLY\b/i.test(statement.masked)) return;
  return place(context, {
    sqls: [splice(statement.sql, match[0].length, match[0].length, ' CONCURRENTLY')],
    outsideTransaction: true,
    note: 'REINDEX CONCURRENTLY needs PostgreSQL 12+. A failed run leaves `_ccnew` invalid indexes to drop.',
  });
}

// States ALGORITHM=INPLACE and LOCK=NONE, replacing whatever the statement asked for.
function onlineMysqlStatement(context, note) {
  const { statement } = context;
  if (!statement) return;
  const createIndex = /^CREATE\s+(?:UNIQUE\s+|FULLTEXT\s+|SPATIAL\s+)?INDEX\b/i.test(statement.masked);
  if (!createIndex && !/^ALTER\s+TABLE\b/i.test(statement.masked)) return;
  let { sql } = statement;
  const missing = [];
  for (const [pattern, clause] of [
    [/\bALGORITHM\s*=?\s*\w+/i, 'ALGORITHM=INPLACE'],
    [/\bLOCK\s*=?\s*\w+/i, 'LOCK=NONE'],
  ]) {
    const found = pattern.exec(mask(sql, context.quote === '`'));
    if (found) sql = splice(sql, found.index, found.index + found[0].length, clause);
    else missing.push(clause);
  }
  if (missing.length) sql += (createIndex ? ' ' : ', ') + missing.join(createIndex ? ' ' : ', ');
  if (sql === statement.sql) return;
  return place(context, { sqls: [sql], note });
}

function mysqlTableCopy(context) {
  return onlineMysqlStatement(
    context,
    'MySQL now refuses the statement with an error instead of copying the table and blocking writes. If it refuses, run the change with `gh-ost` or `pt-online-schema-change`, or add a new column, backfill in batches and swap.',
  );
}

function mysqlLockUnspecified(context) {
  return onlineMysqlStatement(
    context,
    'MySQL now fails instead of silently copying the table. `ALGORITHM=INSTANT` is better where supported (adding a column on MySQL 8.0.29+).',
  );
}

function withContext(rule) {
  return (input) => {
    const context = migrationContext(input);
    return context && rule(context);
  };
}

// migration-breaking-rename of a column and migration-unparsed have no builder: a safe column rename needs the column
// type (not in the finding), and SQL the parser rejected cannot be rewritten reliably.
module.exports = {
  'migration-index-not-concurrent': withContext(indexNotConcurrent),
  'migration-concurrent-in-transaction': withContext(concurrentInTransaction),
  'migration-not-null-without-default': withContext(notNullWithoutDefault),
  'migration-volatile-default': withContext(volatileDefault),
  'migration-column-type-rewrite': withContext(columnTypeRewrite),
  'migration-set-not-null-scan': withContext(setNotNullScan),
  'migration-constraint-not-valid': withContext(constraintNotValid),
  'migration-constraint-without-index': withContext(constraintWithoutIndex),
  'migration-breaking-drop': withContext(breakingDrop),
  'migration-breaking-rename': withContext(breakingRename),
  'migration-missing-lock-timeout': withContext(missingLockTimeout),
  'migration-table-rewrite-command': withContext(tableRewriteCommand),
  'migration-mysql-table-copy': withContext(mysqlTableCopy),
  'migration-mysql-lock-unspecified': withContext(mysqlLockUnspecified),
};
