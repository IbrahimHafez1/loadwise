import { ts } from '../compiler.js';
import { noteOnce } from '../../shared/coverage-notes.js';
import { allDefined, createTable } from './model.js';
import { currentSnapshot } from './context.js';
import { loadPrismaSchema } from './prisma-schema.js';
import { projectRootOf, projectDialect } from './project-indexes.js';
import { declaredInPackage, resolvedSymbol, stringValue } from './ts-helpers.js';
import type { A_Expr, Alias, RangeVar } from '@pgsql/types';
import type { CallExpression, PropertyAccessExpression } from 'typescript';
import type { CheckerAdapter } from '../../shared/types.js';
import type { PgStatementNode } from '../types/pg-statements.js';
import type { ConditionKind, QueryOrderEntry, QuerySite } from '../types/query-site.js';
import type { SchemaTable } from '../types/schema-model.js';
import { parseStatements } from '../sql/pg-parser.js';
import type * as PgParser from '../sql/pg-parser.js';

/** The one table a statement reads, with the names that can qualify its columns. */
interface TableReference {
  relname: string;
  schemaname?: string;
  alias?: Alias;
}

interface StatementParts {
  relation: TableReference;
  where?: PgStatementNode;
  sort?: PgStatementNode[];
  limited: boolean;
}

interface ResolvedTable {
  table: SchemaTable;
  /** Database column name to model field name, when the model maps them. */
  byDbName?: Map<string, string>;
}

interface RawContext extends ResolvedTable {
  qualifiers: Set<string>;
}

interface RawCondition {
  column: string;
  kind: ConditionKind;
  operator?: string;
  insensitive?: boolean;
  expression?: string;
}

// Raw SQL sites: a literal Postgres statement passed to a driver or ORM escape hatch. Coverage
// rules need a table model, which only a Prisma schema or a snapshot provides; without one the site
// is marked `modelless`.

const rawMethods: Record<string, readonly string[] | undefined> = {
  query: ['pg', '@types/pg', 'typeorm', 'sequelize', '@sequelize/core', 'sequelize-typescript'],
  $queryRawUnsafe: undefined,
  $executeRawUnsafe: undefined,
};
const comparisons: Record<string, ConditionKind> = {
  '=': 'eq',
  '<': 'range',
  '>': 'range',
  '<=': 'range',
  '>=': 'range',
};
const expressionFunctions = new Set(['lower', 'upper', 'date', 'coalesce', 'trim']);

function rawDialect(
  access: PropertyAccessExpression,
  packages: readonly string[] | undefined,
  root: string,
  checker: CheckerAdapter,
): string | undefined {
  if (!packages) return loadPrismaSchema(root)?.dialect;
  if (!declaredInPackage(access, checker, packages)) return;
  return declaredInPackage(access, checker, ['pg', '@types/pg']) ? 'postgres' : projectDialect(root);
}

// A Prisma client belongs to the project whose schema generated it, which may not be the calling
// file's.
function rootFile(access: PropertyAccessExpression, checker: CheckerAdapter): string {
  const isPrisma = !rawMethods[access.name.text];
  const declaration = isPrisma ? resolvedSymbol(access, checker)?.declarations?.[0] : undefined;
  return (declaration ?? access).getSourceFile().fileName;
}

function parse(text: string): PgStatementNode | null | undefined {
  let statements: ReturnType<(typeof PgParser)['parseStatements']>;
  try {
    statements = parseStatements(text);
  } catch (error) {
    // The parser loads asynchronously; a scan that did not load it has no raw SQL coverage.
    noteOnce(
      'sql-parser',
      `Note: the SQL parser is not available (${error instanceof Error ? error.message : String(error)}); skipped the raw SQL checks.`,
    );
    return;
  }
  if (statements.length !== 1 || statements[0].error) return;
  return statements[0].node;
}

// The statement's one table and the parts the rules read; joins, set operations and subqueries are
// skipped.
function tableReference(relation: RangeVar | undefined): TableReference | undefined {
  if (relation?.relname === undefined) return;
  return { relname: relation.relname, schemaname: relation.schemaname, alias: relation.alias };
}

function statementParts(node: PgStatementNode | null | undefined): StatementParts | undefined {
  if (node?.SelectStmt) {
    const select = node.SelectStmt;
    const sources: PgStatementNode[] | undefined = select.fromClause;
    if (select.op !== 'SETOP_NONE' || sources?.length !== 1) return;
    const relation = tableReference(sources[0].RangeVar);
    if (!relation) return;
    return { relation, where: select.whereClause, sort: select.sortClause, limited: Boolean(select.limitCount) };
  }
  const update = node?.UpdateStmt;
  const modify = update ?? node?.DeleteStmt;
  const extraSources = update ? update.fromClause : node?.DeleteStmt?.usingClause;
  if (modify && !extraSources?.length) {
    const relation = tableReference(modify.relation);
    if (!relation) return;
    return { relation, where: modify.whereClause, limited: false };
  }
}

function snapshotTable(relation: TableReference): SchemaTable | undefined {
  const snapshot = currentSnapshot();
  const qualified = `${relation.schemaname ?? 'public'}.${relation.relname}`;
  if (!snapshot || (!snapshot.tables[qualified] && !snapshot.tables[relation.relname])) return;
  const table = createTable({ name: relation.relname, dialect: snapshot.dialect });
  table.orm = 'sql';
  return table;
}

function resolveTable(relation: TableReference, root: string): ResolvedTable {
  const schema = loadPrismaSchema(root);
  const model = [...(schema?.models.values() ?? [])].find((candidate) => candidate.dbName === relation.relname);
  if (model && !relation.schemaname) return { table: model, byDbName: dbNameIndex(model) };
  const fromSnapshot = snapshotTable(relation);
  if (fromSnapshot) return { table: fromSnapshot };
  const table = createTable({ name: relation.relname, dialect: 'postgres' });
  table.orm = 'sql';
  table.modelless = true;
  return { table };
}

const dbNameIndexes = new WeakMap<SchemaTable, Map<string, string>>();

function dbNameIndex(table: SchemaTable): Map<string, string> {
  const known = dbNameIndexes.get(table);
  if (known) return known;
  const created = new Map([...table.columns.values()].map((column): [string, string] => [column.dbName, column.name]));
  dbNameIndexes.set(table, created);
  return created;
}

function lastFieldName(reference: PgStatementNode | undefined): string | undefined {
  const fields: PgStatementNode[] | undefined = reference?.ColumnRef?.fields;
  const last: PgStatementNode | undefined = fields?.at(-1);
  return last?.String?.sval;
}

function columnOf(reference: PgStatementNode | undefined, context: RawContext): string | undefined {
  const fields: PgStatementNode[] | undefined = reference?.ColumnRef?.fields;
  if (!fields) return;
  const names = fields.map((field) => field.String?.sval);
  if (!allDefined(names)) return;
  if (names.length === 2 && !context.qualifiers.has(names[0])) return;
  if (names.length > 2) return;
  const dbName = names[names.length - 1];
  if (!context.byDbName) return dbName;
  return context.byDbName.get(dbName);
}

function isValue(node: PgStatementNode | undefined): boolean {
  if (node?.TypeCast) return isValue(node.TypeCast.arg);
  return Boolean(node?.A_Const || node?.ParamRef);
}

// `lower(email)` or `created_at::date` around a plain column.
function expressionOf(
  node: PgStatementNode | undefined,
  context: RawContext,
): { column: string; expression: string } | undefined {
  const call = node?.FuncCall;
  if (call) {
    const funcname: PgStatementNode[] = call.funcname ?? [];
    const name = funcname.at(-1)?.String?.sval?.toLowerCase();
    const args: PgStatementNode[] | undefined = call.args;
    if (name === undefined || !expressionFunctions.has(name) || args?.length !== 1) return;
    const column = columnOf(args[0], context);
    return column ? { column, expression: `${name}(${lastFieldName(args[0])})` } : undefined;
  }
  const cast = node?.TypeCast;
  const castArgument: PgStatementNode | undefined = cast?.arg;
  if (cast && castArgument?.ColumnRef) {
    const column = columnOf(castArgument, context);
    const typeNames: PgStatementNode[] = cast.typeName?.names ?? [];
    const type = typeNames.at(-1)?.String?.sval;
    return column && type ? { column, expression: `${lastFieldName(castArgument)}::${type}` } : undefined;
  }
}

// The leftmost literal of a `'%' || $1 || '%'` chain, or the literal itself.
function patternStart(node: PgStatementNode | undefined): string | undefined {
  if (node?.A_Const) return node.A_Const.sval?.sval;
  const concatenation = node?.A_Expr;
  const operatorName: PgStatementNode | undefined = concatenation?.name?.[0];
  if (concatenation?.kind === 'AEXPR_OP' && operatorName?.String?.sval === '||') {
    return patternStart(concatenation.lexpr);
  }
}

function addCondition(site: QuerySite, context: RawContext, condition: RawCondition): void {
  site.conditions.push({ table: context.table, node: site.node, ...condition });
}

function readPattern(site: QuerySite, context: RawContext, expression: A_Expr): void {
  const column = columnOf(expression.lexpr, context);
  const start = patternStart(expression.rexpr);
  const operatorName: PgStatementNode | undefined = expression.name?.[0];
  const negated = operatorName?.String?.sval?.startsWith('!');
  if (!column || start === undefined || negated) {
    site.uncertain = true;
    return;
  }
  const insensitive = expression.kind === 'AEXPR_ILIKE';
  const kind = start.startsWith('%') ? 'pattern' : 'other';
  addCondition(site, context, { column, kind, operator: insensitive ? 'ILIKE' : 'LIKE', insensitive });
}

function readComparison(site: QuerySite, context: RawContext, expression: A_Expr): void {
  const operatorName: PgStatementNode | undefined = expression.name?.[0];
  const operator = operatorName?.String?.sval;
  const kind = operator === undefined ? undefined : comparisons[operator];
  const [subject, value] = isValue(expression.lexpr)
    ? [expression.rexpr, expression.lexpr]
    : [expression.lexpr, expression.rexpr];
  if (!isValue(value)) {
    site.uncertain = true;
    return;
  }
  const column = columnOf(subject, context);
  if (column) {
    addCondition(site, context, { column, kind: kind ?? 'other' });
    return;
  }
  const wrapped = kind && expressionOf(subject, context);
  if (wrapped) addCondition(site, context, { ...wrapped, kind: 'expression' });
  else site.uncertain = true;
}

function isEqualsOperator(expression: A_Expr): boolean {
  const operatorName: PgStatementNode | undefined = expression.name?.[0];
  return operatorName?.String?.sval === '=';
}

function readConjunct(site: QuerySite, context: RawContext, node: PgStatementNode | undefined): void {
  if (node?.BoolExpr?.boolop === 'AND_EXPR') {
    for (const argument of node.BoolExpr.args ?? []) readConjunct(site, context, argument);
    return;
  }
  const expression = node?.A_Expr;
  const nullTest = node?.NullTest;
  if (nullTest) {
    const column = columnOf(nullTest.arg, context);
    if (column) addCondition(site, context, { column, kind: nullTest.nulltesttype === 'IS_NULL' ? 'null' : 'other' });
    else site.uncertain = true;
  } else if (expression?.kind === 'AEXPR_LIKE' || expression?.kind === 'AEXPR_ILIKE') {
    readPattern(site, context, expression);
  } else if (expression?.kind === 'AEXPR_IN' && isEqualsOperator(expression)) {
    const column = columnOf(expression.lexpr, context);
    if (column) addCondition(site, context, { column, kind: 'in' });
    else site.uncertain = true;
  } else if (expression?.kind === 'AEXPR_OP') {
    readComparison(site, context, expression);
  } else {
    site.uncertain = true;
  }
}

function readOrder(site: QuerySite, context: RawContext, sort: PgStatementNode[]): QueryOrderEntry[] | null {
  const order: QueryOrderEntry[] = [];
  for (const item of sort) {
    const column = columnOf(item.SortBy?.node, context);
    if (!column) return null;
    order.push({ table: context.table, column, node: site.node });
  }
  return order;
}

function rawSqlSite(call: CallExpression, checker: CheckerAdapter): QuerySite | undefined {
  const access = call.expression;
  if (!ts.isPropertyAccessExpression(access) || !Object.hasOwn(rawMethods, access.name.text)) return;
  const text = stringValue(call.arguments[0]);
  if (!text || !/^\s*(?:select|update|delete)\b/i.test(text)) return;
  const root = projectRootOf(rootFile(access, checker));
  if (rawDialect(access, rawMethods[access.name.text], root, checker) !== 'postgres') return;
  const parts = statementParts(parse(text));
  if (!parts) return;
  const { table, byDbName } = resolveTable(parts.relation, root);
  table.root ??= root;
  const qualifiers = new Set(
    [parts.relation.relname, parts.relation.alias?.aliasname].filter((name): name is string => Boolean(name)),
  );
  const context: RawContext = { table, byDbName, qualifiers };
  const site: QuerySite = {
    orm: table.orm,
    node: call.arguments[0],
    conditions: [],
    order: undefined,
    limited: parts.limited,
    uncertain: false,
  };
  if (parts.where) readConjunct(site, context, parts.where);
  if (parts.sort) site.order = readOrder(site, context, parts.sort);
  return site;
}

export { rawSqlSite };
