'use strict';

const { syntax: ts } = require('../compiler.cjs');
const { createTable, createColumn, createIndex } = require('./model.cjs');
const {
  declaredInPackage,
  calleeName,
  initializerOf,
  stringValue,
  propertyName,
  objectProperty,
  location,
  resolvedSymbol,
} = require('./ts-helpers.cjs');

const tableConstructors = { pgTable: 'postgres', mysqlTable: 'mysql' };
const schemaConstructors = { pgSchema: 'postgres', mysqlSchema: 'mysql' };
const indexBuilders = new Set(['index', 'uniqueIndex', 'unique', 'primaryKey']);
// Extras that never create an index; anything else unknown makes the table's index list incomplete.
const nonIndexExtras = new Set(['check', 'foreignKey', 'pgPolicy', 'policy']);
const booleanBuilders = new Set(['boolean']);
const enumBuilders = new Set(['mysqlEnum', 'pgEnum']);
const drizzlePackages = ['drizzle-orm'];
const tables = new WeakMap();

// `pgTable(...)`, `mysqlTable(...)` or `pgSchema('auth').table(...)` imported from drizzle-orm.
function tableDialect(call, checker) {
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
function builderChain(expression) {
  const calls = [];
  let current = ts.skipOuterExpressions(expression);
  while (ts.isCallExpression(current)) {
    calls.unshift(current);
    if (!ts.isPropertyAccessExpression(current.expression)) break;
    current = ts.skipOuterExpressions(current.expression.expression);
  }
  return calls;
}

function isEnumBuilder(call, checker) {
  const name = calleeName(call);
  if (enumBuilders.has(name)) return true;
  const options = call.arguments.find((argument) => ts.isObjectLiteralExpression(argument));
  if (objectProperty(options, 'enum')) return true;
  if (!ts.isIdentifier(call.expression)) return false;
  const initializer = initializerOf(call.expression, checker);
  return Boolean(initializer && ts.isCallExpression(initializer) && enumBuilders.has(calleeName(initializer)));
}

function referenceTarget(call) {
  const callback = call.arguments[0] && ts.skipOuterExpressions(call.arguments[0]);
  const body = callback && ts.isArrowFunction(callback) ? ts.skipOuterExpressions(callback.body) : undefined;
  if (body && ts.isPropertyAccessExpression(body)) {
    return { table: body.expression.getText(), column: body.name.text };
  }
  return { table: '', column: '' };
}

function readColumn(table, property, checker) {
  const name = propertyName(property);
  if (!name || !ts.isPropertyAssignment(property)) return false;
  const chain = builderChain(property.initializer);
  if (!chain.length) return false;
  const [builder, ...modifiers] = chain;
  const type = booleanBuilders.has(calleeName(builder))
    ? 'boolean'
    : isEnumBuilder(builder, checker)
      ? 'enum'
      : calleeName(builder);
  const where = location(property.name);
  const column = createColumn({
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

function tableColumnName(expression, parameter) {
  const value = ts.skipOuterExpressions(expression);
  if (
    ts.isPropertyAccessExpression(value) &&
    ts.isIdentifier(value.expression) &&
    value.expression.text === parameter
  ) {
    return value.name.text;
  }
}

function templateText(template, table, parameter) {
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
function indexKey(expression, table, parameter) {
  let value = ts.skipOuterExpressions(expression);
  const key = {};
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

function primaryKeyColumns(call) {
  const config = call.arguments[0] && ts.skipOuterExpressions(call.arguments[0]);
  const columns = config && ts.isObjectLiteralExpression(config) ? objectProperty(config, 'columns') : undefined;
  if (columns && ts.isArrayLiteralExpression(columns)) return [...columns.elements];
  return [...call.arguments];
}

// One extras entry, e.g. `index('n').using('gin', t.a).where(sql\`...\`)`; false when it cannot be read.
// `index as mysqlIndex` is still drizzle's index(); the declared name decides.
function importedName(call, checker) {
  if (!ts.isIdentifier(call.expression)) return;
  const symbol = resolvedSymbol(call.expression, checker);
  return symbol && declaredInPackage(call.expression, checker, drizzlePackages) ? symbol.name : undefined;
}

function readExtra(table, expression, parameter, checker) {
  const chain = builderChain(expression);
  if (!chain.length) return false;
  const [builder, ...steps] = chain;
  const kind = importedName(builder, checker);
  if (nonIndexExtras.has(kind)) return true;
  if (!indexBuilders.has(kind)) return false;
  let keyExpressions = kind === 'primaryKey' ? primaryKeyColumns(builder) : [];
  let method = 'btree';
  let predicate;
  for (const step of steps) {
    const name = calleeName(step);
    if (name === 'on' || name === 'onOnly') keyExpressions = [...step.arguments];
    else if (name === 'using') {
      method = stringValue(step.arguments[0])?.toLowerCase();
      keyExpressions = step.arguments.slice(1);
    } else if (name === 'where') predicate = step.arguments[0]?.getText() ?? '';
    else if (!['concurrently', 'nullsNotDistinct', 'with'].includes(name)) return false;
  }
  const keys = keyExpressions.map((key) => indexKey(key, table, parameter));
  if (!method || !keys.length || !keys.every(Boolean)) return false;
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

function extrasEntries(callback) {
  let body = ts.skipOuterExpressions(callback.body);
  if (ts.isBlock(body)) {
    const statement = body.statements.length === 1 ? body.statements[0] : undefined;
    if (!statement || !ts.isReturnStatement(statement) || !statement.expression) return;
    body = ts.skipOuterExpressions(statement.expression);
  }
  if (ts.isArrayLiteralExpression(body)) return [...body.elements];
  if (ts.isObjectLiteralExpression(body)) {
    if (!body.properties.every((property) => ts.isPropertyAssignment(property))) return;
    return body.properties.map((property) => property.initializer);
  }
}

// An unreadable extras entry might be an index, so rules treat the table as having unknown indexes.
function readExtras(table, argument, checker) {
  const callback = argument && ts.skipOuterExpressions(argument);
  if (!callback) return true;
  if (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback)) return false;
  const parameter = callback.parameters[0]?.name;
  if (!parameter || !ts.isIdentifier(parameter)) return callback.parameters.length === 0;
  const entries = extrasEntries(callback);
  return Boolean(entries) && entries.every((entry) => readExtra(table, entry, parameter.text, checker));
}

function buildTable(call, dialect, schemaName, checker) {
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
function drizzleTableFromCall(call, checker) {
  if (tables.has(call)) return tables.get(call);
  const origin = ts.isCallExpression(call) ? tableDialect(call, checker) : undefined;
  const table = origin && buildTable(call, origin.dialect, origin.schemaName, checker);
  tables.set(call, table);
  return table;
}

// `orders` or `schema.orders` -> the table its declaration builds.
function drizzleTable(expression, checker) {
  const value = ts.skipOuterExpressions(expression);
  if (!ts.isIdentifier(value) && !ts.isPropertyAccessExpression(value)) return;
  const initializer = initializerOf(value, checker);
  if (initializer && ts.isCallExpression(initializer)) return drizzleTableFromCall(initializer, checker);
}

// `orders.customerId` -> { table, column: 'customerId' } when the column is declared in that table.
function drizzleColumn(expression, checker) {
  const value = ts.skipOuterExpressions(expression);
  if (!ts.isPropertyAccessExpression(value)) return;
  const table = drizzleTable(value.expression, checker);
  if (table?.columns.has(value.name.text)) return { table, column: value.name.text };
}

module.exports = { drizzleTableFromCall, drizzleTable, drizzleColumn };
