'use strict';

const { syntax: ts } = require('../compiler.cjs');
const { createTable, createColumn, createIndex } = require('./model.cjs');
const {
  declaredInPackage,
  calleeName,
  initializerOf,
  resolvedSymbol,
  stringValue,
  propertyName,
  objectProperty,
  location,
} = require('./ts-helpers.cjs');

const mongoosePackages = ['mongoose'];
const keyMethods = { text: 'text', hashed: 'hash', '2dsphere': 'geo', '2d': 'geo' };
const tables = new WeakMap();

function isTrue(node) {
  return node?.kind === ts.SyntaxKind.TrueKeyword;
}

// Mongoose's default collection name: lower-cased and pluralized.
function collectionName(modelName) {
  const lower = modelName.toLowerCase();
  if (/[^aeiou]y$/.test(lower)) return lower.slice(0, -1) + 'ies';
  return /(?:s|x|z|ch|sh)$/.test(lower) ? lower + 'es' : lower + 's';
}

function typeName(node) {
  const value = node && ts.skipOuterExpressions(node);
  if (!value) return 'unknown';
  if (ts.isIdentifier(value)) return value.text.toLowerCase();
  if (ts.isPropertyAccessExpression(value)) return value.name.text.toLowerCase();
  if (ts.isArrayLiteralExpression(value)) return 'array';
  return 'unknown';
}

function fieldIndex(name, options, line) {
  const index = objectProperty(options, 'index');
  const unique = isTrue(objectProperty(options, 'unique')) || isTrue(objectProperty(index, 'unique'));
  const special = stringValue(index);
  if (special) return createIndex({ keys: [{ column: name }], method: keyMethods[special] ?? special, line });
  if (unique || isTrue(index) || (index && ts.isObjectLiteralExpression(index))) {
    return createIndex({ keys: [{ column: name }], unique, line });
  }
  if (isTrue(objectProperty(options, 'text'))) return createIndex({ keys: [{ column: name }], method: 'text', line });
}

function readFields(table, definition) {
  for (const property of definition.properties) {
    const name = propertyName(property);
    if (!name || !ts.isPropertyAssignment(property)) {
      table.complete = false;
      continue;
    }
    let value = ts.skipOuterExpressions(property.initializer);
    // `tags: [{ type: String, index: true }]` indexes each array element.
    if (ts.isArrayLiteralExpression(value) && value.elements.length === 1) {
      value = ts.skipOuterExpressions(value.elements[0]);
    }
    const options = ts.isObjectLiteralExpression(value) ? value : undefined;
    // An object without `type` is a nested path; its own fields are not top-level columns.
    if (options && !objectProperty(options, 'type')) continue;
    const kind =
      options && objectProperty(options, 'enum') ? 'enum' : typeName(options ? objectProperty(options, 'type') : value);
    const where = location(property.name);
    table.columns.set(
      name,
      createColumn({ name, type: kind, file: where.file, line: where.line, column: where.column }),
    );
    const index = options && fieldIndex(name, options, where.line);
    if (index) table.indexes.push(index);
  }
}

// `{ tenantId: 1, createdAt: -1 }` -> keys; a text or geo key makes the whole index that method.
function schemaIndex(call) {
  const spec = call.arguments[0] && ts.skipOuterExpressions(call.arguments[0]);
  if (!spec || !ts.isObjectLiteralExpression(spec)) return;
  let method = 'btree';
  const keys = spec.properties.map((property) => {
    const column = propertyName(property);
    if (!column || !ts.isPropertyAssignment(property)) return;
    const value = ts.skipOuterExpressions(property.initializer);
    const special = stringValue(value);
    if (special) method = keyMethods[special] ?? special;
    const negative = ts.isPrefixUnaryExpression(value) && value.operator === ts.SyntaxKind.MinusToken;
    return negative ? { column, direction: 'desc' } : { column };
  });
  if (!keys.length || !keys.every(Boolean)) return;
  const options = call.arguments[1] && ts.skipOuterExpressions(call.arguments[1]);
  const partial = objectProperty(options, 'partialFilterExpression');
  return createIndex({
    name: stringValue(objectProperty(options, 'name')),
    keys,
    unique: isTrue(objectProperty(options, 'unique')),
    method,
    predicate: partial ? partial.getText() : undefined,
    line: location(call).line,
  });
}

// Top-level `schema.index(...)`, `schema.plugin(...)` and `schema.add(...)` statements in the schema's file.
function readSchemaStatements(table, declaration) {
  const schemaName = declaration.name.text;
  for (const statement of declaration.getSourceFile().statements) {
    if (!ts.isExpressionStatement(statement)) continue;
    const call = ts.skipOuterExpressions(statement.expression);
    if (!ts.isCallExpression(call) || !ts.isPropertyAccessExpression(call.expression)) continue;
    const receiver = call.expression.expression;
    if (!ts.isIdentifier(receiver) || receiver.text !== schemaName) continue;
    const method = call.expression.name.text;
    if (method === 'index') {
      const index = schemaIndex(call);
      if (index) table.indexes.push(index);
      else table.complete = false;
    } else if (method === 'add') table.complete = false;
    else if (method === 'plugin') table.plugins = true;
  }
}

function isExported(declaration) {
  const statement = declaration.parent?.parent;
  return Boolean(
    statement &&
    ts.isVariableStatement(statement) &&
    statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword),
  );
}

function buildTable(modelCall, checker) {
  const modelName = stringValue(modelCall.arguments[0]);
  const schemaReference = modelCall.arguments[1] && ts.skipOuterExpressions(modelCall.arguments[1]);
  if (!modelName || !schemaReference || !ts.isIdentifier(schemaReference)) return;
  const construction = initializerOf(schemaReference, checker);
  if (!construction || !ts.isNewExpression(construction)) return;
  if (!declaredInPackage(construction.expression, checker, mongoosePackages)) return;
  const definition = construction.arguments?.[0] && ts.skipOuterExpressions(construction.arguments[0]);
  if (!definition || !ts.isObjectLiteralExpression(definition)) return;
  const declaration = resolvedSymbol(schemaReference, checker)?.valueDeclaration;
  if (!declaration || !ts.isVariableDeclaration(declaration) || !ts.isIdentifier(declaration.name)) return;
  const options = construction.arguments[1] && ts.skipOuterExpressions(construction.arguments[1]);
  const where = location(declaration.name);
  const table = createTable({
    name: modelName,
    dbName:
      stringValue(modelCall.arguments[2]) ??
      stringValue(objectProperty(options, 'collection')) ??
      collectionName(modelName),
    dialect: 'mongo',
    file: where.file,
    line: where.line,
    column: where.column,
  });
  table.orm = 'mongoose';
  table.schemaName = declaration.name.text;
  table.complete = !isExported(declaration);
  table.columns.set('_id', createColumn({ name: '_id', type: 'objectid' }));
  table.indexes.push(createIndex({ keys: [{ column: '_id' }], unique: true, primary: true }));
  readFields(table, definition);
  const timestamps = objectProperty(options, 'timestamps');
  if (timestamps && timestamps.kind !== ts.SyntaxKind.FalseKeyword) {
    for (const name of ['createdAt', 'updatedAt']) {
      if (!table.columns.has(name)) table.columns.set(name, createColumn({ name, type: 'date' }));
    }
  }
  readSchemaStatements(table, declaration);
  for (const index of table.indexes) index.file = where.file;
  return table;
}

// `AuditLog` in `AuditLog.find(...)` -> the collection `mongoose.model('AuditLog', schema)` declares.
function mongooseTableOf(expression, checker) {
  const value = expression && ts.skipOuterExpressions(expression);
  if (!value || (!ts.isIdentifier(value) && !ts.isPropertyAccessExpression(value))) return;
  const call = initializerOf(value, checker);
  if (!call || !ts.isCallExpression(call) || calleeName(call) !== 'model') return;
  if (!declaredInPackage(call.expression, checker, mongoosePackages)) return;
  if (!tables.has(call)) tables.set(call, buildTable(call, checker));
  return tables.get(call);
}

module.exports = { mongooseTableOf };
