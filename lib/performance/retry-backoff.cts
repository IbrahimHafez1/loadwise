import { loadSyntax } from './compiler.cjs';
import { describeCall, isDefaultAxios, isGlobalFetch } from './http-timeouts.cjs';
import type {
  CallExpression,
  DoStatement,
  Expression,
  ForStatement,
  Identifier,
  Node,
  TryStatement,
  WhileStatement,
} from 'typescript';
import type { CheckerAdapter, PerformanceRuleContext } from '../shared/types.cjs';
const ts = loadSyntax();

const RULE_ID = 'retry-without-backoff';
const BACKOFF_ADVICE =
  'Add exponential backoff with jitter (for example `delay = base * 2 ** attempt + random jitter`)';
const HTTP_PACKAGES = new Set(['got', 'ky', 'undici', 'axios', 'node-fetch', 'superagent']);
const RETRY_NAME = /retr|attempt|tries|try/i;
const DELAY_NAME = /sleep|delay|backoff|^wait|settimeout|^pause|throttle/i;
type RetryLoop = ForStatement | WhileStatement | DoStatement;

function isRetryLoopKind(node: Node): node is RetryLoop {
  return ts.isForStatement(node) || ts.isWhileStatement(node) || ts.isDoStatement(node);
}

function rootIdentifier(expression: Expression): Identifier | undefined {
  let current = ts.skipOuterExpressions(expression);
  while (ts.isPropertyAccessExpression(current) || ts.isCallExpression(current)) {
    current = ts.skipOuterExpressions(current.expression);
  }
  return ts.isIdentifier(current) ? current : undefined;
}

function importedPackage(identifier: Identifier, checker: CheckerAdapter): string | undefined {
  const declaration = checker.getSymbolAtLocation(identifier)?.declarations?.[0];
  if (!declaration) return;
  const importDeclaration = ts.findAncestor(declaration, ts.isImportDeclaration);
  return importDeclaration && ts.isStringLiteral(importDeclaration.moduleSpecifier)
    ? importDeclaration.moduleSpecifier.text
    : undefined;
}

function isNetworkCall(node: CallExpression, context: PerformanceRuleContext): boolean {
  const described = describeCall(node);
  if (described?.library === 'fetch') return isGlobalFetch(described.receiver, context);
  if (described) return isDefaultAxios(described.receiver, context);
  const root = rootIdentifier(node.expression);
  if (!root) return false;
  const packageName = importedPackage(root, context.checker);
  return packageName !== undefined && HTTP_PACKAGES.has(packageName);
}

function mentionsRetryName(expression: Expression): boolean {
  let found = false;
  (function visit(child: Node): void {
    if (ts.isIdentifier(child) && RETRY_NAME.test(child.text)) found = true;
    else ts.forEachChild(child, visit);
  })(expression);
  return found;
}

// `for (let attempt = 0; attempt < 3; ...)`, `for (;;)`, `while (true)` and `while (retries-- > 0)`
// retry; `while (queue.length)` does not.
function isRetryLoop(loop: RetryLoop): boolean {
  if (ts.isForStatement(loop)) return !loop.condition || mentionsRetryName(loop.condition);
  const condition = loop.expression;
  return condition.kind === ts.SyntaxKind.TrueKeyword || mentionsRetryName(condition);
}

// A retry loop leaves through the successful attempt; a loop that never returns or breaks is a
// batch, not a retry.
function containsExit(block: Node): boolean {
  let found = false;
  (function visit(child: Node): void {
    if (ts.isFunctionLike(child)) return;
    if (ts.isReturnStatement(child) || ts.isBreakStatement(child)) found = true;
    else ts.forEachChild(child, visit);
  })(block);
  return found;
}

function callName(call: CallExpression): string {
  const callee = ts.skipOuterExpressions(call.expression);
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  return ts.isIdentifier(callee) ? callee.text : '';
}

function waitsInside(loop: RetryLoop): boolean {
  let found = false;
  (function visit(child: Node): void {
    if (found) return;
    if (ts.isCallExpression(child) && DELAY_NAME.test(callName(child))) found = true;
    else ts.forEachChild(child, visit);
  })(loop.statement);
  return found;
}

// The loop that retries `node` after the catch of the try that holds it, within the same function.
function retryLoopOf(node: Node): RetryLoop | undefined {
  let child = node;
  let tryStatement: TryStatement | undefined;
  for (let parent = node.parent; parent && !ts.isFunctionLike(parent); child = parent, parent = parent.parent) {
    if (!tryStatement && ts.isTryStatement(parent) && parent.tryBlock === child && parent.catchClause) {
      tryStatement = parent;
    }
    if (tryStatement && isRetryLoopKind(parent)) {
      return containsExit(tryStatement.tryBlock) && isRetryLoop(parent) ? parent : undefined;
    }
  }
}

function checkRetryLoop(node: CallExpression, context: PerformanceRuleContext): void {
  if (!isNetworkCall(node, context)) return;
  const loop = retryLoopOf(node);
  if (!loop || waitsInside(loop)) return;
  context.report(
    node,
    RULE_ID,
    `This request is retried in a loop with no wait between attempts, so a struggling server is hit again at full speed. ${BACKOFF_ADVICE} before the next attempt.`,
  );
}

function lacksRetryDelay(options: Expression | undefined): boolean {
  if (!options) return true;
  const literal = ts.skipOuterExpressions(options);
  if (!ts.isObjectLiteralExpression(literal)) return false;
  if (literal.properties.some((property) => ts.isSpreadAssignment(property))) return false;
  return !literal.properties.some((property) => property.name?.getText() === 'retryDelay');
}

function checkAxiosRetry(node: CallExpression, context: PerformanceRuleContext): void {
  const callee = ts.skipOuterExpressions(node.expression);
  if (!ts.isIdentifier(callee) || importedPackage(callee, context.checker) !== 'axios-retry') return;
  if (!lacksRetryDelay(node.arguments[1])) return;
  context.report(
    node,
    RULE_ID,
    `axios-retry waits 0 ms between attempts unless \`retryDelay\` is set. ${BACKOFF_ADVICE}: pass \`retryDelay: axiosRetry.exponentialDelay\`.`,
    'Another interceptor or a custom adapter may already delay retries, which this check cannot see.',
  );
}

function check(node: CallExpression, context: PerformanceRuleContext): void {
  checkAxiosRetry(node, context);
  checkRetryLoop(node, context);
}

export { check };
