import { loadSyntax } from './compiler.cjs';
import { typeFromPackage } from './package-types.cjs';
import { initializerOf, declaredInPackage, propertyName, resolvedSymbol } from './schema/ts-helpers.cjs';
import type {
  CallExpression,
  Expression,
  ExpressionStatement,
  Identifier,
  Node,
  ObjectLiteralExpression,
  TaggedTemplateExpression,
  VariableDeclaration,
  VariableStatement,
  Statement,
} from 'typescript';
import type { CheckerAdapter, PerformanceRuleContext } from '../shared/types.cjs';
const ts = loadSyntax();

const mysqlDatabaseTypes = ['MySql2Database', 'MySql2Transaction'];
// A single-row insert followed by `select last_insert_id()` in the same block.
interface InsertedIdSite {
  query: TaggedTemplateExpression;
  alias: string;
  declaration: VariableDeclaration;
  statement: VariableStatement;
  insert: ExpressionStatement;
  receiver: Identifier;
  table: Expression;
  row: ObjectLiteralExpression;
  next: Statement | undefined;
}

const idQuery = /^\s*select\s+last_insert_id\s*\(\s*\)\s+(?:as\s+)?([A-Za-z_]\w*)\s*;?\s*$/i;

function method(call: Node | undefined, name: string): Expression | undefined {
  if (
    call &&
    ts.isCallExpression(call) &&
    ts.isPropertyAccessExpression(call.expression) &&
    call.expression.name.text === name &&
    !ts.isOptionalChain(call)
  )
    return call.expression.expression;
}

function constDeclaration(statement: Node | undefined): VariableDeclaration | undefined {
  if (
    statement &&
    ts.isVariableStatement(statement) &&
    statement.declarationList.flags & ts.NodeFlags.Const &&
    statement.declarationList.declarations.length === 1
  )
    return statement.declarationList.declarations[0];
}

function insertedIdQuery(call: CallExpression): InsertedIdSite | undefined {
  const receiver = method(call, 'execute');
  if (!receiver || !ts.isIdentifier(receiver) || call.arguments.length !== 1) return;
  const query = call.arguments[0];
  if (!ts.isTaggedTemplateExpression(query) || !ts.isNoSubstitutionTemplateLiteral(query.template)) return;
  const alias = idQuery.exec(query.template.text)?.[1];
  if (!alias || !ts.isAwaitExpression(call.parent)) return;
  const declaration = call.parent.parent;
  if (!ts.isVariableDeclaration(declaration) || !ts.isIdentifier(declaration.name)) return;
  const statement = declaration.parent.parent;
  if (
    !ts.isVariableStatement(statement) ||
    constDeclaration(statement) !== declaration ||
    !ts.isBlock(statement.parent)
  )
    return;
  const siblings = statement.parent.statements;
  const index = siblings.indexOf(statement);
  const insert = siblings[index - 1];
  if (!insert || !ts.isExpressionStatement(insert) || !ts.isAwaitExpression(insert.expression)) return;
  const values = insert.expression.expression;
  const builder = method(values, 'values');
  const insertReceiver = method(builder, 'insert');
  const row = ts.isCallExpression(values) ? values.arguments[0] : undefined;
  if (
    !insertReceiver ||
    !ts.isCallExpression(values) ||
    !builder ||
    !ts.isCallExpression(builder) ||
    !ts.isIdentifier(insertReceiver) ||
    insertReceiver.text !== receiver.text ||
    builder.arguments.length !== 1 ||
    values.arguments.length !== 1 ||
    !row ||
    !ts.isObjectLiteralExpression(row)
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
    row,
    next: siblings[index + 1],
  };
}

// A connection's old LAST_INSERT_ID can survive an insert with an explicit key or no auto-increment
// column.
function hasGeneratedIntegerKey(site: InsertedIdSite, checker: CheckerAdapter): boolean {
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
  const keys: string[] = [];
  for (const column of columns.properties) {
    if (!ts.isPropertyAssignment(column)) return false;
    const key = propertyName(column);
    if (!key) return false;
    let expression: Expression = column.initializer;
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
      keys.push(key);
  }
  return (
    keys.length === 1 &&
    site.row.properties.every((property) => propertyName(property) && propertyName(property) !== keys[0])
  );
}

function checkLastInsertId(call: CallExpression, context: PerformanceRuleContext): void {
  const site = insertedIdQuery(call);
  if (!site || !ts.isPropertyAccessExpression(call.expression)) return;
  const { checker } = context;
  const receiver = checker.getTypeAtLocation(site.receiver);
  const types = receiver.flags & ts.TypeFlags.Intersection ? (receiver.types ?? [receiver]) : [receiver];
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

export type { InsertedIdSite };
export { checkLastInsertId, insertedIdQuery, constDeclaration };
