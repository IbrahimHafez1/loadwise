import { ts } from './compiler.js';
import { awaitedResult, outsideWrappers } from './query-results.js';
import { operationFamily, signatureDeclaration } from './service-loops.js';
import type { BindingName, CallExpression, Expression, IfStatement, Node, Statement } from 'typescript';
import type { CheckerAdapter, PerformanceRuleContext } from '../shared/types.js';

/** The statement holding an awaited value and the names it binds. */
interface AwaitStatement {
  statement: Statement;
  names: ReadonlySet<string>;
}

/** The `if (...) return/throw` that follows an awaited statement. */
interface EarlyExitGuard {
  awaitStatement: Statement;
  guard: IfStatement;
}

const rule = 'await-before-early-exit';

// Reads only: a write, lock or auth call may be the very thing the guard after it relies on. The
// OrThrow and OrFail variants are left out because their exception is an outcome the guard order
// can change.
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

function skipParentheses(node: Node): Node {
  let current = node;
  while (ts.isParenthesizedExpression(current)) current = current.expression;
  return current;
}

function isOrmRead(call: CallExpression, checker: CheckerAdapter): boolean {
  if (!ts.isPropertyAccessExpression(call.expression)) return false;
  const method = call.expression.name.text;
  if (!readMethods.has(method.toLowerCase())) return false;
  const declaration = signatureDeclaration(call, checker);
  return declaration !== undefined && readFamilies.has(operationFamily(method, declaration) ?? '');
}

function hasNoMethodOption(options: Expression | undefined): boolean {
  if (!options) return true;
  const literal = skipParentheses(options);
  return (
    ts.isObjectLiteralExpression(literal) &&
    literal.properties.every((property) => ts.isPropertyAssignment(property) && property.name.getText() !== 'method')
  );
}

// `fetch(url)` and `axios.get(url)`: the plain HTTP reads, never a POST whose effect a guard may
// depend on.
function isHttpRead(call: CallExpression, context: PerformanceRuleContext): boolean {
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

function isExit(statement: Statement): boolean {
  return ts.isReturnStatement(statement) || ts.isThrowStatement(statement);
}

function exitsEarly(statement: Statement): boolean {
  if (ts.isBlock(statement))
    return statement.statements.length > 0 && isExit(statement.statements[statement.statements.length - 1]);
  return isExit(statement);
}

function mentionsAny(root: Node, names: ReadonlySet<string>): boolean {
  let found = false;
  (function visit(node: Node): void {
    if (found) return;
    if (ts.isIdentifier(node) && names.has(node.text)) found = true;
    else ts.forEachChild(node, visit);
  })(root);
  return found;
}

function containsAwait(root: Node): boolean {
  let found = false;
  (function visit(node: Node): void {
    if (found) return;
    if (ts.isAwaitExpression(node) || ts.isYieldExpression(node)) found = true;
    else ts.forEachChild(node, visit);
  })(root);
  return found;
}

function boundNames(name: BindingName, names: Set<string>): Set<string> {
  if (ts.isIdentifier(name)) names.add(name.text);
  else
    for (const element of name.elements)
      if (ts.isBindingElement(element) && element.name) boundNames(element.name, names);
  return names;
}

// The statement that holds the awaited value and the names it binds: `await read();`, `const x =
// await read();` or `x = await read();`. Anything else may use the value in ways this rule does not
// follow.
function awaitStatementOf(awaited: Expression): AwaitStatement | undefined {
  const expression = outsideWrappers(awaited);
  const parent = expression.parent;
  if (ts.isExpressionStatement(parent)) return { statement: parent, names: new Set<string>() };
  if (ts.isVariableDeclaration(parent) && parent.initializer === expression) {
    const list = parent.parent;
    if (ts.isVariableDeclarationList(list) && list.declarations.length === 1 && ts.isVariableStatement(list.parent))
      return { statement: list.parent, names: boundNames(parent.name, new Set<string>()) };
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

// The `if (...) return/throw` right after `awaited`'s statement when it does not use anything the
// await produced.
function guardAfterAwait(awaited: Expression): EarlyExitGuard | undefined {
  const found = awaitStatementOf(awaited);
  if (!found || !ts.isBlock(found.statement.parent)) return;
  const siblings = found.statement.parent.statements;
  const guard = siblings[siblings.indexOf(found.statement) + 1];
  if (!guard || !ts.isIfStatement(guard) || guard.elseStatement || !exitsEarly(guard.thenStatement)) return;
  if (mentionsAny(guard, found.names) || containsAwait(guard)) return;
  return { awaitStatement: found.statement, guard };
}

function check(call: CallExpression, context: PerformanceRuleContext): void {
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

export { check, guardAfterAwait };
