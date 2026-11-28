// `process.on('uncaughtException', handler)` where the handler only logs. Node keeps running after such a handler, but
// the process is in an unknown state (half-written data, leaked handles), so the handler has to end the process.
import { ts } from '../performance/compiler.js';
import { walkNodes } from './walk.js';
import { isIgnoredSource } from './source-helpers.js';
import type { CheckerAdapter, Finding } from '../shared/types.js';
import type { CallExpression, Expression, Node, SourceFile, TryStatement } from 'typescript';

const listenerMethods = new Set(['on', 'once', 'addListener', 'prependListener', 'prependOnceListener']);
// Calls that end the process or start its shutdown, however the project names them.
const shutdownCallName = /exit|shutdown|terminate|abort|kill|crash|die|stop|close|destroy/i;

function isProcessListenerCall(call: CallExpression): boolean {
  const callee = ts.skipOuterExpressions(call.expression);
  if (!ts.isPropertyAccessExpression(callee) || !listenerMethods.has(callee.name.text)) return false;
  const receiver = ts.skipOuterExpressions(callee.expression);
  const [event] = call.arguments;
  return (
    ts.isIdentifier(receiver) &&
    receiver.text === 'process' &&
    event !== undefined &&
    ts.isStringLiteralLike(event) &&
    event.text === 'uncaughtException'
  );
}

function isProcessReference(node: Node): boolean {
  const expression = ts.skipOuterExpressions(node);
  return ts.isIdentifier(expression) && expression.text === 'process';
}

function isExitCodeAssignment(node: Node): boolean {
  if (!ts.isBinaryExpression(node) || node.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return false;
  return (
    ts.isPropertyAccessExpression(node.left) &&
    node.left.name.text === 'exitCode' &&
    isProcessReference(node.left.expression)
  );
}

function calleeName(call: CallExpression): string | undefined {
  const callee = ts.skipOuterExpressions(call.expression);
  if (ts.isIdentifier(callee)) return callee.text;
  return ts.isPropertyAccessExpression(callee) ? callee.name.text : undefined;
}

// A function written inside the handler runs only when called or handed to a call (a scheduled shutdown such as
// `setTimeout(() => process.exit(1))`); one that is merely declared or stored does not end the process.
function isDormantFunction(node: Node): boolean {
  if (!ts.isFunctionLike(node)) return false;
  return !ts.isCallExpression(node.parent) && !ts.isNewExpression(node.parent);
}

// Callbacks handed to these run after the surrounding try block has finished, so an enclosing catch cannot see them.
const deferredCallName = /^(?:setTimeout|setInterval|setImmediate|nextTick|queueMicrotask|then|catch|finally|on|once)$/;

function isDeferredCallback(node: Node): boolean {
  return (
    ts.isFunctionLike(node) && ts.isCallExpression(node.parent) && deferredCallName.test(calleeName(node.parent) ?? '')
  );
}

// A `return` in a finally block cancels a throw from the try or catch block.
function finallyReturns(statement: TryStatement): boolean {
  return (statement.finallyBlock?.statements ?? []).some((inner) => ts.isReturnStatement(inner));
}

// A throw counts only when it leaves the handler, so one inside a `try` that has a `catch`, or whose `finally` returns,
// is not evidence.
function endsOrRethrows(handler: Node): boolean {
  let ends = false;
  const visit = (node: Node, swallowed: boolean): void => {
    if (ends || isDormantFunction(node)) return;
    if ((ts.isThrowStatement(node) && !swallowed) || isExitCodeAssignment(node)) ends = true;
    else if (ts.isCallExpression(node) && shutdownCallName.test(calleeName(node) ?? '')) ends = true;
    else if (ts.isTryStatement(node)) {
      const cancelsThrow = finallyReturns(node);
      visit(node.tryBlock, swallowed || cancelsThrow || node.catchClause !== undefined);
      if (node.catchClause) visit(node.catchClause, swallowed || cancelsThrow);
      if (node.finallyBlock) visit(node.finallyBlock, swallowed);
    } else ts.forEachChild(node, (child) => visit(child, swallowed && !isDeferredCallback(child)));
  };
  ts.forEachChild(handler, (child) => visit(child, false));
  return ends;
}

function functionOf(declaration: Node | undefined): Node | undefined {
  if (!declaration || declaration.getSourceFile().isDeclarationFile) return;
  if (ts.isFunctionDeclaration(declaration) || ts.isMethodDeclaration(declaration)) return declaration;
  const initializer =
    ts.isVariableDeclaration(declaration) || ts.isPropertyAssignment(declaration) ? declaration.initializer : undefined;
  return initializer && (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))
    ? initializer
    : undefined;
}

// The handler's code when it is written in place or is a function, method or property of this file; undefined when it
// comes from elsewhere and cannot be read.
function handlerBody(handler: Expression, checker: CheckerAdapter): Node | undefined {
  const expression = ts.skipOuterExpressions(handler);
  if (ts.isArrowFunction(expression) || ts.isFunctionExpression(expression)) return expression;
  if (!ts.isIdentifier(expression) && !ts.isPropertyAccessExpression(expression)) return;
  return functionOf(checker.getSymbolAtLocation(expression)?.valueDeclaration);
}

function checkUncaughtException(sourceFile: SourceFile, file: string, checker: CheckerAdapter): Finding[] {
  if (!sourceFile.text.includes('uncaughtException') || isIgnoredSource(sourceFile, file)) return [];
  const findings: Finding[] = [];
  walkNodes(sourceFile, (node) => {
    if (!ts.isCallExpression(node) || !isProcessListenerCall(node)) return;
    const body = node.arguments[1] && handlerBody(node.arguments[1], checker);
    if (!body || endsOrRethrows(body)) return;
    const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    findings.push({
      file,
      line: position.line + 1,
      column: position.character + 1,
      ruleId: 'uncaught-exception-continues',
      message:
        'This uncaughtException handler never exits or rethrows, so the process keeps running in an unknown state. Log the error, then shut down and exit with a non-zero code.',
    });
  });
  return findings;
}

export { checkUncaughtException };
