import { coverage, fixFor } from './schema/model.cjs';
import type { PerformanceRuleContext } from '../shared/types.cjs';
import type { QueryCondition, QuerySite } from './types/query-site.cjs';
import type { SchemaOrm } from './types/schema-model.cjs';
import { contextFor, hasExpressionIndex, hasPatternIndex, place, relatedTo, sizeCaveat } from './index-rules-table.cjs';
import type { IndexFixText, TableInfo } from './index-rules-table.cjs';

// The same statement shape as fixFor's DDL, renamed and switched to the given method and key.
function variantSql(
  info: TableInfo,
  column: string,
  suffix: string | undefined,
  method: string | undefined,
  key: (list: string) => string,
): string {
  const { sql } = fixFor(info.table, [column], 'sql');
  return sql.replace(/_idx" ON /, `_${suffix}_idx" ON `).replace(/ \(([^()]*)\);$/, (_match: string, list: string) => {
    return `${method ? ` USING ${method}` : ''} (${key(list)});`;
  });
}

function indexNameIn(sql: string): string | undefined {
  return /INDEX CONCURRENTLY "([^"]+)"/.exec(sql)?.[1];
}

function trigramFix(info: TableInfo, column: string, orm: SchemaOrm | undefined): IndexFixText {
  const { table } = info;
  const sql = variantSql(info, column, 'trgm', 'gin', (list) => `${list} gin_trgm_ops`);
  const name = indexNameIn(sql);
  const where = place(table);
  const snippets: Partial<Record<SchemaOrm, [string, string]>> = {
    prisma: [
      `@@index([${column}(ops: raw("gin_trgm_ops"))], type: Gin, map: "${name}")`,
      `to model \`${table.name}\` (${where})`,
    ],
    drizzle: [
      `index('${name}').using('gin', table.${column}.op('gin_trgm_ops'))`,
      `to the indexes of table \`${table.name}\` (${where})`,
    ],
    sequelize: [
      `{ name: '${name}', fields: [{ name: '${column}', operator: 'gin_trgm_ops' }], using: 'gin' }`,
      `to the \`indexes\` of model \`${table.name}\` (${where})`,
    ],
  };
  const snippet = orm === undefined ? undefined : snippets[orm];
  // TypeORM decorators cannot name an operator class, so the index belongs in a migration.
  if (!snippet) return { suggestion: sql, text: `Add a trigram index in a migration: \`${sql}\`` };
  return {
    suggestion: snippet[0],
    text: `Add a trigram index: \`${snippet[0]}\` ${snippet[1]}; on a live database build it with \`${sql}\``,
  };
}

const prismaPatterns: Record<string, string> = {
  contains: "'%...%'",
  endsWith: "'%...'",
  startsWith: "'...%'",
};

function patternSubject(condition: QueryCondition, orm: SchemaOrm | undefined): string {
  const { operator, insensitive } = condition;
  if (orm === 'prisma' && operator !== undefined && Object.hasOwn(prismaPatterns, operator)) {
    const mode = insensitive ? " with `mode: 'insensitive'`" : '';
    return `\`${operator}\`${mode} compiles to \`${insensitive ? 'ILIKE' : 'LIKE'} ${prismaPatterns[operator]}\``;
  }
  return `\`${operator}\` with a leading \`%\``;
}

export function reportPattern(
  site: QuerySite,
  info: TableInfo,
  condition: QueryCondition,
  context: PerformanceRuleContext,
): void {
  const { table } = info;
  const label = `\`${table.name}.${condition.column}\``;
  let message: string;
  let suggestion: string | undefined;
  if (info.dialect === 'mongo') {
    message =
      `This regular expression on ${label} is unanchored or case-insensitive, so an index cannot narrow it and ` +
      'MongoDB examines every document (or every key of an index on the field). Anchor it with `^` and keep it ' +
      'case-sensitive, or match a lower-cased copy of the field that is indexed.' +
      sizeCaveat(info);
  } else {
    const fix = trigramFix(info, condition.column, site.orm);
    suggestion = fix.suggestion;
    const alternative =
      site.orm === 'prisma' && !condition.insensitive && condition.operator === 'contains'
        ? ', or use `startsWith`'
        : '';
    // Without a model the rules cannot see the table's indexes, so the claim is conditional.
    const consequence = table.modelless ? ', so this scans the table unless a trigram index exists' : '';
    message =
      `${patternSubject(condition, site.orm)}, which a btree index on ${label} cannot serve${consequence}. ` +
      `${fix.text} (requires \`pg_trgm\`)${alternative}.${sizeCaveat(info)}`;
  }
  context.report(condition.node, 'index-unusable-pattern', message, contextFor(info, condition.node), {
    ...(suggestion && { suggestion }),
    ...relatedTo(table),
  });
}

// `lower(email)` or `created_at::date` -> the index key, the SQL key list and the drizzle sql``
// template.
function expressionParts(
  info: TableInfo,
  column: string,
  expression: string,
): { suffix: string | undefined; sqlKey: (list: string) => string; template: string } {
  const dbName = info.table.columns.get(column)?.dbName ?? column;
  const cast = /::(\w+)$/.exec(expression);
  const fn = /^(\w+)\(/.exec(expression)?.[1];
  const sqlKey = (list: string) => (cast ? `(${list}::${cast[1]})` : expression.replace(dbName, list));
  const template = expression.replace(dbName, '${table.' + column + '}');
  return { suffix: cast ? cast[1] : fn, sqlKey, template };
}

function expressionFix(
  info: TableInfo,
  column: string,
  expression: string,
  orm: SchemaOrm | undefined,
): { suggestion?: string; text: string } {
  const { table } = info;
  const parts = expressionParts(info, column, expression);
  const sql = variantSql(info, column, parts.suffix, undefined, parts.sqlKey);
  if (orm !== 'drizzle') return { text: `Create \`${sql}\`` };
  const name = indexNameIn(sql);
  const suggestion = `index('${name}').on(sql\`${parts.template}\`)`;
  return {
    suggestion,
    text:
      `Add \`${suggestion}\` to the indexes of table \`${table.name}\` (${place(table)}); ` +
      `on a live database build it with \`${sql}\``,
  };
}

export function reportExpression(
  site: QuerySite,
  info: TableInfo,
  condition: QueryCondition,
  context: PerformanceRuleContext,
): void {
  const { table } = info;
  const label = `\`${table.name}.${condition.column}\``;
  let message: string;
  let suggestion: string | undefined;
  if (condition.operator === 'insensitive') {
    if (hasPatternIndex(info, condition.column)) return;
    const fix = trigramFix(info, condition.column, site.orm);
    suggestion = fix.suggestion;
    message =
      `\`mode: 'insensitive'\` compiles to \`ILIKE\`, which a btree index on ${label} cannot serve. ${fix.text} ` +
      '(requires `pg_trgm`), or store the value lower-cased and match it with `equals`.';
  } else {
    const { expression } = condition;
    if (!expression || hasExpressionIndex(info, condition)) return;
    const fix = expressionFix(info, condition.column, expression, site.orm);
    suggestion = fix.suggestion;
    const effect =
      coverage(table, condition.column) === 'leading'
        ? `hides the index on ${label}`
        : `keeps PostgreSQL from using a plain index on ${label}`;
    const consequence = table.modelless ? ', so this scans the table unless an expression index exists' : '';
    message = `\`${condition.expression}\` ${effect}${consequence}. ${fix.text}, or store a normalized column.`;
  }
  context.report(
    condition.node,
    'index-unusable-expression',
    message + sizeCaveat(info),
    contextFor(info, condition.node),
    {
      ...(suggestion && { suggestion }),
      ...relatedTo(table),
    },
  );
}
