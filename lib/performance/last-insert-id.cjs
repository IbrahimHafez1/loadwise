'use strict';

const { syntax: ts } = require('./compiler.cjs');
const { typeFromPackage } = require('./package-types.cjs');
const { initializerOf, declaredInPackage, propertyName, resolvedSymbol } = require('./schema/ts-helpers.cjs');

const mysqlDatabaseTypes = ['MySql2Database', 'MySql2Transaction'];
const idQuery = /^\s*select\s+last_insert_id\s*\(\s*\)\s+(?:as\s+)?([A-Za-z_]\w*)\s*;?\s*$/i;

function method(call, name) {
  if (
    call &&
    ts.isCallExpression(call) &&
    ts.isPropertyAccessExpression(call.expression) &&
    call.expression.name.text === name &&
    !ts.isOptionalChain(call)
  )
    return call.expression.expression;
}

function constDeclaration(statement) {
  if (
    statement &&
    ts.isVariableStatement(statement) &&
    statement.declarationList.flags & ts.NodeFlags.Const &&
    statement.declarationList.declarations.length === 1
  )
    return statement.declarationList.declarations[0];
}

function insertedIdQuery(call) {
  const receiver = method(call, 'execute');
  if (!receiver || !ts.isIdentifier(receiver) || call.arguments.length !== 1) return;
  const query = call.arguments[0];
  if (!ts.isTaggedTemplateExpression(query) || !ts.isNoSubstitutionTemplateLiteral(query.template)) return;
  const alias = idQuery.exec(query.template.text)?.[1];
  if (!alias || !ts.isAwaitExpression(call.parent)) return;
  const declaration = call.parent.parent;
  if (!ts.isVariableDeclaration(declaration) || !ts.isIdentifier(declaration.name)) return;
  const statement = declaration.parent.parent;
  if (constDeclaration(statement) !== declaration || !ts.isBlock(statement.parent)) return;
  const siblings = statement.parent.statements;
  const index = siblings.indexOf(statement);
  const insert = siblings[index - 1];
  if (!insert || !ts.isExpressionStatement(insert) || !ts.isAwaitExpression(insert.expression)) return;
  const values = insert.expression.expression;
  const builder = method(values, 'values');
  const insertReceiver = method(builder, 'insert');
  if (
    !insertReceiver ||
    !ts.isIdentifier(insertReceiver) ||
    insertReceiver.text !== receiver.text ||
    builder.arguments.length !== 1 ||
    values.arguments.length !== 1 ||
    !ts.isObjectLiteralExpression(values.arguments[0])
  )
    return;
  return {
    query,
    alias,
    declaration,
    statement,
    insert,
    receiver,
    table: builder.arguments[0],
    row: values.arguments[0],
    next: siblings[index + 1],
  };
}

// A connection's old LAST_INSERT_ID can survive an insert with an explicit key or no auto-increment column.
function hasGeneratedIntegerKey(site, checker) {
  const table = initializerOf(site.table, checker);
  if (
    !table ||
    !ts.isCallExpression(table) ||
    resolvedSymbol(table.expression, checker)?.name !== 'mysqlTable' ||
    !declaredInPackage(table.expression, checker, ['drizzle-orm'])
  )
    return false;
  const columns = table.arguments[1];
  if (!columns || !ts.isObjectLiteralExpression(columns)) return false;
  const keys = [];
  for (const column of columns.properties) {
    if (!ts.isPropertyAssignment(column) || !propertyName(column)) return false;
    let expression = column.initializer;
    let generated = false;
    while (ts.isCallExpression(expression) && ts.isPropertyAccessExpression(expression.expression)) {
      if (expression.expression.name.text === 'autoincrement') generated = true;
      expression = expression.expression.expression;
    }
    if (
      generated &&
      ts.isCallExpression(expression) &&
      resolvedSymbol(expression.expression, checker)?.name === 'int' &&
      declaredInPackage(expression.expression, checker, ['drizzle-orm'])
    )
      keys.push(propertyName(column));
  }
  return (
    keys.length === 1 &&
    site.row.properties.every((property) => propertyName(property) && propertyName(property) !== keys[0])
  );
}

function checkLastInsertId(call, context) {
  const site = insertedIdQuery(call);
  if (!site) return;
  const { checker } = context;
  const receiver = checker.getTypeAtLocation(site.receiver);
  const types = receiver.flags & ts.TypeFlags.Intersection ? receiver.types : [receiver];
  if (
    !types.some((type) => typeFromPackage(type, ['drizzle-orm/mysql2'], mysqlDatabaseTypes)) ||
    resolvedSymbol(site.query.tag, checker)?.name !== 'sql' ||
    !declaredInPackage(site.query.tag, checker, ['drizzle-orm']) ||
    !hasGeneratedIntegerKey(site, checker)
  )
    return;
  context.report(
    call.expression.name,
    'drizzle-last-insert-id',
    'A single-row MySQL insert is followed by SELECT LAST_INSERT_ID(). Read the generated ID from the mysql2 insert result to avoid a second query and a connection-local lookup.',
  );
}

module.exports = { checkLastInsertId, insertedIdQuery, constDeclaration };
