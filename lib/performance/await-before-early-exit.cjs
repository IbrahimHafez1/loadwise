'use strict';

const { syntax: ts } = require('./compiler.cjs');
const { awaitedResult, outsideWrappers } = require('./query-results.cjs');
const { operationFamily, signatureDeclaration } = require('./service-loops.cjs');

const rule = 'await-before-early-exit';

// Reads only: a write, lock or auth call may be the very thing the guard after it relies on. The OrThrow and
// OrFail variants are left out because their exception is an outcome the guard order can change.
const readMethods = new Set(
  [
    'findUnique',
    'findFirst',
    'findMany',
    'count',
    'aggregate',
    'groupBy',
    'find',
    'findBy',
    'findOne',
    'findOneBy',
    'findOneById',
    'findAndCount',
    'findAndCountBy',
    'countBy',
    'exist',
    'exists',
    'existsBy',
    'getOne',
    'getMany',
    'getManyAndCount',
    'getRawOne',
    'getRawMany',
    'getCount',
    'findAll',
    'findByPk',
    'findAndCountAll',
    'findById',
    'countDocuments',
    'get',
    'mget',
    'hget',
    'hgetall',
    'hmget',
    'smembers',
    'sismember',
    'zrange',
    'zscore',
    'lrange',
    'ttl',
  ].map((name) => name.toLowerCase()),
);
// Raw SQL text (pg) can be a write, and queues start work, so neither counts as a read.
const readFamilies = new Set(['prisma', 'typeorm', 'drizzle', 'sequelize', 'mongoose', 'redis']);
const httpReadMethods = new Set(['get', 'head', 'options']);

function skipParentheses(node) {
  let current = node;
  while (ts.isParenthesizedExpression(current)) current = current.expression;
  return current;
}

function isOrmRead(call, checker) {
  if (!ts.isPropertyAccessExpression(call.expression)) return false;
  const method = call.expression.name.text;
  if (!readMethods.has(method.toLowerCase())) return false;
  const declaration = signatureDeclaration(call, checker);
  return Boolean(declaration) && readFamilies.has(operationFamily(method, declaration));
}

function hasNoMethodOption(options) {
  if (!options) return true;
  const literal = skipParentheses(options);
  return (
    ts.isObjectLiteralExpression(literal) &&
    literal.properties.every((property) => ts.isPropertyAssignment(property) && property.name.getText() !== 'method')
  );
}

// `fetch(url)` and `axios.get(url)`: the plain HTTP reads, never a POST whose effect a guard may depend on.
function isHttpRead(call, context) {
  const callee = skipParentheses(call.expression);
  if (ts.isIdentifier(callee) && callee.text === 'fetch') {
    // The global fetch has no project declaration; a function the project named `fetch` does.
    const declarations = context.checker.getSymbolAtLocation(callee)?.declarations;
    return (
      (!declarations?.length || declarations.every((declaration) => declaration.getSourceFile().isDeclarationFile)) &&
      hasNoMethodOption(call.arguments[1])
    );
  }
  return (
    ts.isPropertyAccessExpression(callee) &&
    ts.isIdentifier(callee.expression) &&
    callee.expression.text === 'axios' &&
    httpReadMethods.has(callee.name.text) &&
    context.isPackageType(callee.expression, ['axios'], ['AxiosStatic'])
  );
}

function isExit(statement) {
  return ts.isReturnStatement(statement) || ts.isThrowStatement(statement);
}

function exitsEarly(statement) {
  if (ts.isBlock(statement)) return statement.statements.length > 0 && isExit(statement.statements.at(-1));
  return isExit(statement);
}

function mentionsAny(root, names) {
  let found = false;
  (function visit(node) {
    if (found) return;
    if (ts.isIdentifier(node) && names.has(node.text)) found = true;
    else ts.forEachChild(node, visit);
  })(root);
  return found;
}

function containsAwait(root) {
  let found = false;
  (function visit(node) {
    if (found) return;
    if (ts.isAwaitExpression(node) || ts.isYieldExpression(node)) found = true;
    else ts.forEachChild(node, visit);
  })(root);
  return found;
}

function boundNames(name, names) {
  if (ts.isIdentifier(name)) names.add(name.text);
  else
    for (const element of name.elements)
      if (ts.isBindingElement(element) && element.name) boundNames(element.name, names);
  return names;
}

// The statement that holds the awaited value and the names it binds: `await read();`, `const x = await read();`
// or `x = await read();`. Anything else may use the value in ways this rule does not follow.
function awaitStatementOf(awaited) {
  const expression = outsideWrappers(awaited);
  const parent = expression.parent;
  if (ts.isExpressionStatement(parent)) return { statement: parent, names: new Set() };
  if (ts.isVariableDeclaration(parent) && parent.initializer === expression) {
    const list = parent.parent;
    if (list.declarations.length === 1 && ts.isVariableStatement(list.parent))
      return { statement: list.parent, names: boundNames(parent.name, new Set()) };
    return;
  }
  const assignment = parent;
  if (
    ts.isBinaryExpression(assignment) &&
    assignment.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    assignment.right === expression &&
    ts.isIdentifier(assignment.left) &&
    ts.isExpressionStatement(assignment.parent)
  )
    return { statement: assignment.parent, names: new Set([assignment.left.text]) };
}

// The `if (...) return/throw` right after `awaited`'s statement when it does not use anything the await produced.
function guardAfterAwait(awaited) {
  const found = awaitStatementOf(awaited);
  if (!found || !ts.isBlock(found.statement.parent)) return;
  const siblings = found.statement.parent.statements;
  const guard = siblings[siblings.indexOf(found.statement) + 1];
  if (!guard || !ts.isIfStatement(guard) || guard.elseStatement || !exitsEarly(guard.thenStatement)) return;
  if (mentionsAny(guard, found.names) || containsAwait(guard)) return;
  return { awaitStatement: found.statement, guard };
}

function check(call, context) {
  const awaited = awaitedResult(call);
  if (!awaited || !(isOrmRead(call, context.checker) || isHttpRead(call, context))) return;
  if (!guardAfterAwait(awaited)) return;
  context.report(
    awaited,
    rule,
    'The guard right after this await returns or throws without using what the call read, so a request the guard rejects still pays the round trip. ' +
      'Run the guard first and await the call after it. Keep the order when the call is there for its error or its timing, since a missing row would no longer be reported ahead of the guard.',
  );
}

module.exports = { check, guardAfterAwait };
