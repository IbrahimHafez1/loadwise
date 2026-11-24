import { loadSyntax } from '../compiler.cjs';
import { allDefined, createTable, createColumn, createIndex } from './model.cjs';
import {
  declaredInPackage,
  calleeName,
  initializerOf,
  stringValue,
  propertyName,
  objectProperty,
  location,
  resolvedSymbol,
} from './ts-helpers.cjs';
import type {
  ArrowFunction,
  CallExpression,
  Expression,
  FunctionExpression,
  ObjectLiteralElementLike,
  TemplateLiteral,
} from 'typescript';
import type { CheckerAdapter } from '../../shared/types.cjs';
import type { ColumnReference } from '../types/query-site.cjs';
import type { ColumnForeignKey, SchemaColumn, SchemaIndexKey, SchemaTable } from '../types/schema-model.cjs';

interface TableOrigin {
  dialect: string;
  schemaName?: string;
}

const ts = loadSyntax();

const tableConstructors: Record<string, string> = { pgTable: 'postgres', mysqlTable: 'mysql' };
const schemaConstructors: Record<string, string> = { pgSchema: 'postgres', mysqlSchema: 'mysql' };
const indexBuilders = new Set(['index', 'uniqueIndex', 'unique', 'primaryKey']);
// Extras that never create an index; anything else unknown makes the table's index list incomplete.
const nonIndexExtras = new Set(['check', 'foreignKey', 'pgPolicy', 'policy']);
const booleanBuilders = new Set(['boolean']);
const enumBuilders = new Set(['mysqlEnum', 'pgEnum']);
const drizzlePackages = ['drizzle-orm'];
const tables = new WeakMap<CallExpression, SchemaTable | undefined>();

// `pgTable(...)`, `mysqlTable(...)` or `pgSchema('auth').table(...)` imported from drizzle-orm.
function tableDialect(call: CallExpression, checker: CheckerAdapter): TableOrigin | undefined {
  const callee = call.expression;
  if (ts.isIdentifier(callee) && Object.hasOwn(tableConstructors, callee.text)) {
    return declaredInPackage(callee, checker, drizzlePackages)
      ? { dialect: tableConstructors[callee.text] }
      : undefined;
  }
  if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== 'table') return;
  const owner = ts.isCallExpression(callee.expression) ? callee.expression : initializerOf(callee.expression, checker);
  if (!owner || !ts.isCallExpression(owner) || !ts.isIdentifier(owner.expression)) return;
  const dialect = schemaConstructors[owner.expression.text];
  const schemaName = stringValue(owner.arguments[0]);
  if (!dialect || !schemaName || !declaredInPackage(owner.expression, checker, drizzlePackages)) return;
  return { dialect, schemaName };
}

// The column builder chain, innermost call first: `uuid('id').notNull().primaryKey()`.
function builderChain(expression: Expression): CallExpression[] {
  const calls: CallExpression[] = [];
  let current: Expression = ts.skipOuterExpressions(expression);
  while (ts.isCallExpression(current)) {
    calls.unshift(current);
    if (!ts.isPropertyAccessExpression(current.expression)) break;
    current = ts.skipOuterExpressions(current.expression.expression);
  }
  return calls;
}

function isEnumBuilderName(name: string | undefined): boolean {
  return name !== undefined && enumBuilders.has(name);
}

function isEnumBuilder(call: CallExpression, checker: CheckerAdapter): boolean {
  const name = calleeName(call);
  if (name !== undefined && enumBuilders.has(name)) return true;
  const options = call.arguments.find((argument: Expression) => ts.isObjectLiteralExpression(argument));
  if (objectProperty(options, 'enum')) return true;
  if (!ts.isIdentifier(call.expression)) return false;
  const initializer = initializerOf(call.expression, checker);
  return Boolean(initializer && ts.isCallExpression(initializer) && isEnumBuilderName(calleeName(initializer)));
}

function referenceTarget(call: CallExpression): ColumnForeignKey {
  const callback = call.arguments[0] && ts.skipOuterExpressions(call.arguments[0]);
  const body = callback && ts.isArrowFunction(callback) ? ts.skipOuterExpressions(callback.body) : undefined;
  if (body && ts.isPropertyAccessExpression(body)) {
    return { table: body.expression.getText(), column: body.name.text };
  }
  return { table: '', column: '' };
}

function readColumn(table: SchemaTable, property: ObjectLiteralElementLike, checker: CheckerAdapter): boolean {
  const name = propertyName(property);
  if (!name || !ts.isPropertyAssignment(property)) return false;
  const chain = builderChain(property.initializer);
  if (!chain.length) return false;
  const [builder, ...modifiers] = chain;
  const builderName = calleeName(builder);
  const type =
    builderName !== undefined && booleanBuilders.has(builderName)
      ? 'boolean'
      : isEnumBuilder(builder, checker)
        ? 'enum'
        : builderName;
  const where = location(property.name);
  const column: SchemaColumn = createColumn({
    name,
    dbName: stringValue(builder.arguments[0]) ?? name,
    type,
    file: where.file,
    line: where.line,
    column: where.column,
  });
  table.columns.set(name, column);
  for (const modifier of modifiers) {
    const method = calleeName(modifier);
    if (method === 'primaryKey' || method === 'unique') {
      const primary = method === 'primaryKey';
      table.indexes.push(createIndex({ keys: [{ column: name }], unique: true, primary, line: where.line }));
    } else if (method === 'references') {
      column.foreignKey = referenceTarget(modifier);
    }
  }
  return true;
}

function tableColumnName(expression: Expression, parameter: string): string | undefined {
  const value = ts.skipOuterExpressions(expression);
  if (
    ts.isPropertyAccessExpression(value) &&
    ts.isIdentifier(value.expression) &&
    value.expression.text === parameter
  ) {
    return value.name.text;
  }
}

function templateText(template: TemplateLiteral, table: SchemaTable, parameter: string): string | undefined {
  if (ts.isNoSubstitutionTemplateLiteral(template)) return template.text;
  let text = template.head.text;
  for (const span of template.templateSpans) {
    const column = tableColumnName(span.expression, parameter);
    if (!column) return;
    text += (table.columns.get(column)?.dbName ?? column) + span.literal.text;
  }
  return text;
}

// `t.a`, `t.a.desc()`, `t.a.op('gin_trgm_ops')` or `sql\`lower(${t.a})\``.
function indexKey(expression: Expression, table: SchemaTable, parameter: string): SchemaIndexKey | undefined {
  let value: Expression = ts.skipOuterExpressions(expression);
  const key: SchemaIndexKey = {};
  while (ts.isCallExpression(value) && ts.isPropertyAccessExpression(value.expression)) {
    const modifier = value.expression.name.text;
    if (modifier === 'op') key.opclass = stringValue(value.arguments[0]);
    else if (modifier === 'desc') key.direction = 'desc';
    else if (!['asc', 'nullsFirst', 'nullsLast'].includes(modifier)) return;
    value = ts.skipOuterExpressions(value.expression.expression);
  }
  if (ts.isTaggedTemplateExpression(value) && ts.isIdentifier(value.tag) && value.tag.text === 'sql') {
    const text = templateText(value.template, table, parameter);
    return text === undefined ? undefined : { ...key, expression: text };
  }
  const column = tableColumnName(value, parameter);
  return column ? { ...key, column } : undefined;
}

function primaryKeyColumns(call: CallExpression): Expression[] {
  const config = call.arguments[0] && ts.skipOuterExpressions(call.arguments[0]);
  const columns = config && ts.isObjectLiteralExpression(config) ? objectProperty(config, 'columns') : undefined;
  if (columns && ts.isArrayLiteralExpression(columns)) return [...columns.elements];
  return [...call.arguments];
}

// One extras entry, e.g. `index('n').using('gin', t.a).where(sql\`...\`)`; false when it cannot be
// read.
// `index as mysqlIndex` is still drizzle's index(); the declared name decides.
function importedName(call: CallExpression, checker: CheckerAdapter): string | undefined {
  if (!ts.isIdentifier(call.expression)) return;
  const symbol = resolvedSymbol(call.expression, checker);
  return symbol && declaredInPackage(call.expression, checker, drizzlePackages) ? symbol.name : undefined;
}

function readExtra(table: SchemaTable, expression: Expression, parameter: string, checker: CheckerAdapter): boolean {
  const chain = builderChain(expression);
  if (!chain.length) return false;
  const [builder, ...steps] = chain;
  const kind = importedName(builder, checker);
  if (kind !== undefined && nonIndexExtras.has(kind)) return true;
  if (kind === undefined || !indexBuilders.has(kind)) return false;
  let keyExpressions: Expression[] = kind === 'primaryKey' ? primaryKeyColumns(builder) : [];
  let method: string | undefined = 'btree';
  let predicate: string | undefined;
  for (const step of steps) {
    const name = calleeName(step);
    if (name === 'on' || name === 'onOnly') keyExpressions = [...step.arguments];
    else if (name === 'using') {
      method = stringValue(step.arguments[0])?.toLowerCase();
      keyExpressions = step.arguments.slice(1);
    } else if (name === 'where') predicate = step.arguments[0]?.getText() ?? '';
    else if (name === undefined || !['concurrently', 'nullsNotDistinct', 'with'].includes(name)) return false;
  }
  const keys = keyExpressions.map((key) => indexKey(key, table, parameter));
  if (!method || !keys.length || !allDefined(keys)) return false;
  table.indexes.push(
    createIndex({
      name: stringValue(builder.arguments[0]),
      keys,
      unique: kind !== 'index',
      primary: kind === 'primaryKey',
      method,
      predicate,
      line: location(builder).line,
    }),
  );
  return true;
}

function extrasEntries(callback: ArrowFunction | FunctionExpression): Expression[] | undefined {
  let body = ts.skipOuterExpressions(callback.body);
  if (ts.isBlock(body)) {
    const statement = body.statements.length === 1 ? body.statements[0] : undefined;
    if (!statement || !ts.isReturnStatement(statement) || !statement.expression) return;
    body = ts.skipOuterExpressions(statement.expression);
  }
  if (ts.isArrayLiteralExpression(body)) return [...body.elements];
  if (ts.isObjectLiteralExpression(body)) {
    const assignments = body.properties.filter(ts.isPropertyAssignment);
    if (assignments.length !== body.properties.length) return;
    return assignments.map((property) => property.initializer);
  }
}

// An unreadable extras entry might be an index, so rules treat the table as having unknown indexes.
function readExtras(table: SchemaTable, argument: Expression | undefined, checker: CheckerAdapter): boolean {
  const callback = argument && ts.skipOuterExpressions(argument);
  if (!callback) return true;
  if (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback)) return false;
  const parameter = callback.parameters[0]?.name;
  if (!parameter || !ts.isIdentifier(parameter)) return callback.parameters.length === 0;
  const entries = extrasEntries(callback);
  return entries !== undefined && entries.every((entry) => readExtra(table, entry, parameter.text, checker));
}

function buildTable(
  call: CallExpression,
  dialect: string,
  schemaName: string | undefined,
  checker: CheckerAdapter,
): SchemaTable | undefined {
  const name = stringValue(call.arguments[0]);
  const columns = call.arguments[1] && ts.skipOuterExpressions(call.arguments[1]);
  if (!name || !columns || !ts.isObjectLiteralExpression(columns)) return;
  const where = location(call);
  const table = createTable({
    name,
    dbName: schemaName ? schemaName + '.' + name : name,
    dialect,
    file: where.file,
    line: where.line,
    column: where.column,
  });
  table.orm = 'drizzle';
  table.complete = columns.properties.every((property) => readColumn(table, property, checker));
  table.complete = readExtras(table, call.arguments[2], checker) && table.complete;
  for (const index of table.indexes) index.file = where.file;
  return table;
}

// Returns the table a `pgTable(...)` call declares, or undefined for any other call.
function drizzleTableFromCall(call: CallExpression, checker: CheckerAdapter): SchemaTable | undefined {
  if (tables.has(call)) return tables.get(call);
  const origin = ts.isCallExpression(call) ? tableDialect(call, checker) : undefined;
  const table = origin && buildTable(call, origin.dialect, origin.schemaName, checker);
  tables.set(call, table);
  return table;
}

// `orders` or `schema.orders` -> the table its declaration builds.
function drizzleTable(expression: Expression, checker: CheckerAdapter): SchemaTable | undefined {
  const value = ts.skipOuterExpressions(expression);
  if (!ts.isIdentifier(value) && !ts.isPropertyAccessExpression(value)) return;
  const initializer = initializerOf(value, checker);
  if (initializer && ts.isCallExpression(initializer)) return drizzleTableFromCall(initializer, checker);
}

// `orders.customerId` -> { table, column: 'customerId' } when the column is declared in that table.
function drizzleColumn(expression: Expression, checker: CheckerAdapter): ColumnReference | undefined {
  const value = ts.skipOuterExpressions(expression);
  if (!ts.isPropertyAccessExpression(value)) return;
  const table = drizzleTable(value.expression, checker);
  if (table?.columns.has(value.name.text)) return { table, column: value.name.text };
}

export { drizzleTableFromCall, drizzleTable, drizzleColumn };
