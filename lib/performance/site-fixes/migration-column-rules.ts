// Migration site-fix rules for column defaults/types/nullability and breaking drops/renames.
import { quoteIdentifier } from '../migrations/operations.js';
import { indentationAt, insertLinesBefore } from './helpers.js';
import {
  IDENT,
  QUALIFIED,
  alterParts,
  groupText,
  hasIndices,
  lastNamePart,
  mask,
  outsideParentheses,
  replaceSubcommand,
  sliceOf,
  splice,
  subcommandAt,
  unquote,
  withoutSubcommand,
} from './migration-context.js';
import { joinNotes, place, queryCall, replaceStatement, statementRemoval } from './migration-placement.js';
import type { FixResult } from '../../shared/types.js';
import type { MigrationContext, SqlStatement, SubcommandRange } from '../types/migrations.js';

const COLUMN_CONSTRAINT_KEYWORD =
  /(?:NOT\s+NULL|NULL|CHECK|REFERENCES|UNIQUE|PRIMARY|CONSTRAINT|COLLATE|GENERATED)\b/iy;

const MYSQL_IMPLICIT_DEFAULTS: [RegExp, string][] = [
  [/^(?:tiny|small|medium|big)?int(?:eger)?$|^(?:decimal|dec|numeric|float|double|real|bit|bool|boolean)$/, '0'],
  [/^(?:var)?(?:char|binary)$/, "''"],
];

const DEFER_NOTE =
  'Deferred: ship the drop in a later release, after no running app version reads or writes it. If none does already, restore it and mark it reviewed with `-- loadwise-reviewed migration-breaking-drop -- <reason>`.';

function mysqlNotNullDefault(
  context: MigrationContext,
  statement: SqlStatement,
  part: SubcommandRange,
): FixResult | undefined {
  const column = sliceOf(statement, part);
  const definition = new RegExp(String.raw`^ADD\s+(?:COLUMN\s+)?${IDENT}\s+(\w+)`, 'i').exec(column.masked);
  const notNull = /\bNOT\s+NULL\b/i.exec(outsideParentheses(column.masked));
  if (!definition || !notNull) return;
  const value = MYSQL_IMPLICIT_DEFAULTS.find(([pattern]) => pattern.test(definition[1].toLowerCase()))?.[1];
  if (value === undefined) return;
  const at = part.start + notNull.index + notNull[0].length;
  return place(context, {
    sqls: [splice(statement.sql, at, at, ` DEFAULT ${value}`)],
    note: `\`DEFAULT ${value}\` is the value MySQL already gives existing rows; make sure it is a correct value for them (or choose a better one), so app versions that do not write this column keep working.`,
  });
}

export function notNullWithoutDefault(context: MigrationContext): FixResult | undefined {
  const { statement } = context;
  if (!statement) return;
  const parts = alterParts(statement);
  if (!parts) return;
  const part = subcommandAt(parts, context.relativeOffset);
  if (!/^ADD\b/i.test(sliceOf(statement, part).masked)) return;
  if (/\bMySQL\b/.test(context.finding.message ?? '')) return mysqlNotNullDefault(context, statement, part);
  const notNull = /\s+NOT\s+NULL\b/i.exec(outsideParentheses(sliceOf(statement, part).masked));
  if (!notNull) return;
  const start = part.start + notNull.index;
  return place(context, {
    sqls: [splice(statement.sql, start, start + notNull[0].length, '')],
    note: 'The column is now added nullable. Make every running app version write it, backfill old rows in batches, then enforce it in a later migration with `CHECK (... IS NOT NULL) NOT VALID`, `VALIDATE CONSTRAINT` and `SET NOT NULL`.',
  });
}

// End of a column DEFAULT expression: the next top-level column constraint keyword, or the end of
// the definition.
function defaultExpressionEnd(masked: string, from: number): number {
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

export function volatileDefault(context: MigrationContext): FixResult | undefined {
  const { statement } = context;
  if (!statement) return;
  const parts = alterParts(statement);
  if (!parts) return;
  const part = subcommandAt(parts, context.relativeOffset);
  const column = sliceOf(statement, part);
  const definition = new RegExp(String.raw`^ADD\s+(?:COLUMN\s+)?(?:IF\s+NOT\s+EXISTS\s+)?(${IDENT})\s+`, 'id').exec(
    column.masked,
  );
  // serial, identity and stored generated columns have no default to move; they need a manual
  // backfill plan.
  if (!hasIndices(definition) || /\b(?:small|big)?serial\d?\b|\bGENERATED\b/i.test(column.masked)) return;
  const keyword = /\s+DEFAULT\s+/i.exec(column.masked);
  if (!keyword) return;
  const expressionStart = keyword.index + keyword[0].length;
  const expressionEnd = defaultExpressionEnd(column.masked, expressionStart);
  const expression = column.sql.slice(expressionStart, expressionEnd).trim();
  let definitionSql = splice(column.sql, keyword.index, expressionEnd, '');
  const notNull = /\s+NOT\s+NULL\b/i.exec(outsideParentheses(mask(definitionSql, context.quote === '`')));
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

export function columnTypeRewrite(context: MigrationContext): FixResult | undefined {
  const { statement } = context;
  if (!statement) return;
  const parts = alterParts(statement);
  if (!parts || parts.subcommands.length !== 1) return;
  const part = parts.subcommands[0];
  const command = sliceOf(statement, part);
  const header = new RegExp(String.raw`^ALTER\s+(?:COLUMN\s+)?(${IDENT})\s+(?:SET\s+DATA\s+)?TYPE\s+`, 'id').exec(
    command.masked,
  );
  if (!hasIndices(header)) return;
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

export function setNotNullScan(context: MigrationContext): FixResult | undefined {
  const { statement } = context;
  if (!statement) return;
  const parts = alterParts(statement);
  if (!parts || parts.subcommands.length !== 1) return;
  const command = sliceOf(statement, parts.subcommands[0]);
  const match = new RegExp(String.raw`^ALTER\s+(?:COLUMN\s+)?(${IDENT})\s+SET\s+NOT\s+NULL\s*$`, 'id').exec(
    command.masked,
  );
  if (!hasIndices(match)) return;
  const column = groupText(command.sql, match, 1);
  const constraint = quoteIdentifier(`${lastNamePart(parts.table)}_${unquote(column)}_not_null`);
  const table = parts.table;
  return place(context, {
    sqls: [`ALTER TABLE ${table} ADD CONSTRAINT ${constraint} CHECK (${column} IS NOT NULL) NOT VALID`],
    note: `Backfill NULLs first. In a later migration run \`ALTER TABLE ${table} VALIDATE CONSTRAINT ${constraint};\`, \`ALTER TABLE ${table} ALTER COLUMN ${column} SET NOT NULL;\` (PostgreSQL 12+ skips the scan thanks to the validated check) and \`ALTER TABLE ${table} DROP CONSTRAINT ${constraint};\`.`,
  });
}

function sqlCommentLines(sql: string): string[] {
  return sql.split(/\r?\n/).map((line) => `-- ${line.trim()}`);
}

// Comments the dropped SQL out, keeping the rest of the statement, until a later release can run
// it.
function defer(
  context: MigrationContext,
  statement: SqlStatement,
  remaining: string | null,
  deferred: string,
): FixResult | undefined {
  const { text, eol } = context;
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
  const comment = insertLinesBefore(found.statement, [`// ${header}`, `// ${deferred.replaceAll(/\s+/g, ' ').trim()}`]);
  if (remaining) return { edits: [comment, replaceStatement(context, statement, [remaining])], note: DEFER_NOTE };
  if (context.statements.length > 1) {
    const removal = statementRemoval(context, statement);
    return removal && { edits: [comment, removal], note: DEFER_NOTE };
  }
  // The query held only the dropped statement: the comment replaces the whole call.
  const lineBreak = /^\r?\n/.exec(text.slice(found.statement.end))?.[0] ?? '';
  return { edits: [{ ...comment, end: found.statement.end + lineBreak.length }], note: DEFER_NOTE };
}

export function breakingDrop(context: MigrationContext): FixResult | undefined {
  const { statement } = context;
  if (!statement) return;
  if (/^DROP\s+TABLE\b/i.test(statement.masked)) {
    if (statement.masked.includes(',')) return;
    return defer(context, statement, null, statement.sql);
  }
  const parts = alterParts(statement);
  if (!parts) return;
  const part = subcommandAt(parts, context.relativeOffset);
  const command = sliceOf(statement, part);
  if (!/^DROP\b/i.test(command.masked)) return;
  if (parts.subcommands.length === 1) return defer(context, statement, null, statement.sql);
  return defer(
    context,
    statement,
    withoutSubcommand(statement, parts, part),
    `ALTER TABLE ${parts.table} ${command.sql}`,
  );
}

export function breakingRename(context: MigrationContext): FixResult | undefined {
  const { statement } = context;
  if (!statement) return;
  const alter = new RegExp(
    String.raw`^ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(${QUALIFIED})\s+RENAME\s+(?:TO|AS)\s+(${QUALIFIED})\s*$`,
    'id',
  );
  const rename = new RegExp(String.raw`^RENAME\s+TABLE\s+(${QUALIFIED})\s+TO\s+(${QUALIFIED})\s*$`, 'id');
  const match = alter.exec(statement.masked) ?? rename.exec(statement.masked);
  if (!hasIndices(match)) return;
  const oldName = groupText(statement.sql, match, 1);
  const newName = groupText(statement.sql, match, 2);
  // PostgreSQL keeps a renamed table in its schema while MySQL moves it to the current database;
  // skip the ambiguity.
  if (match[1].includes('.') !== match[2].includes('.')) return;
  return place(context, {
    sqls: [statement.sql, `CREATE VIEW ${oldName} AS SELECT * FROM ${newName}`],
    note: `Running app versions keep using ${oldName} through an updatable view over ${newName}. Drop the view in a later release, once no version uses the old name. The view keeps the column list of today, so add columns to ${newName} only after it is gone.`,
  });
}
