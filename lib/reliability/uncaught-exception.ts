// `process.on('uncaughtException', handler)` where the handler only logs. Node keeps running after such a handler, but
// the process is in an unknown state (half-written data, leaked handles), so the handler has to end the process.
import { ts } from '../performance/compiler.js';
import { walkNodes } from './walk.js';
import { isIgnoredSource } from './source-helpers.js';
import type { CheckerAdapter, Finding } from '../shared/types.js';
import type { BinaryExpression, CallExpression, Expression, Node, SourceFile, TryStatement } from 'typescript';

const listenerMethods = new Set(['on', 'once', 'addListener', 'prependListener', 'prependOnceListener']);
const processModuleNames = new Set(['process', 'node:process']);
// Calls that end the process or start its shutdown, however the project names them.
const shutdownCallName = /exit|shutdown|terminate|abort|kill|crash|die|stop|close|destroy/i;
const promiseReactionName = /^(?:then|catch|finally)$/;
// Callbacks handed to these run after the surrounding try block has finished, so an enclosing catch cannot see them.
const deferredCallName = /^(?:setTimeout|setInterval|setImmediate|nextTick|queueMicrotask|then|catch|finally|on|once)$/;

function isProcessModuleImport(declaration: Node): boolean {
  const importDeclaration = ts.findAncestor(declaration, ts.isImportDeclaration);
  return (
    importDeclaration !== undefined &&
    ts.isStringLiteralLike(importDeclaration.moduleSpecifier) &&
    processModuleNames.has(importDeclaration.moduleSpecifier.text)
  );
}

// The Node `process`: the global from the Node typings, or an import of `node:process`. A local variable of that name
// is some other object.
function isNodeProcess(identifier: Node, checker: CheckerAdapter): boolean {
  const declarations = checker.getSymbolAtLocation(identifier)?.declarations ?? [];
  return declarations.every(
    (declaration) => declaration.getSourceFile().isDeclarationFile || isProcessModuleImport(declaration),
  );
}

function isProcessListenerCall(call: CallExpression, checker: CheckerAdapter): boolean {
  const callee = ts.skipOuterExpressions(call.expression);
  if (!ts.isPropertyAccessExpression(callee) || !listenerMethods.has(callee.name.text)) return false;
  const receiver = ts.skipOuterExpressions(callee.expression);
  const [event] = call.arguments;
  return (
    ts.isIdentifier(receiver) &&
    receiver.text === 'process' &&
    isNodeProcess(receiver, checker) &&
    event !== undefined &&
    ts.isStringLiteralLike(event) &&
    event.text === 'uncaughtException'
  );
}

function isProcessReference(node: Node, checker: CheckerAdapter): boolean {
  const expression = ts.skipOuterExpressions(node);
  return ts.isIdentifier(expression) && expression.text === 'process' && isNodeProcess(expression, checker);
}

function isExitCodeAssignment(node: Node, checker: CheckerAdapter): node is BinaryExpression {
  if (!ts.isBinaryExpression(node) || node.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return false;
  return (
    ts.isPropertyAccessExpression(node.left) &&
    node.left.name.text === 'exitCode' &&
    isProcessReference(node.left.expression, checker)
  );
}

// Assigning `undefined` or `null` clears the exit status instead of setting one.
function clearsExitCode(assignment: BinaryExpression): boolean {
  const value = ts.skipOuterExpressions(assignment.right);
  return value.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(value) && value.text === 'undefined');
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
  let parent = node.parent;
  // `(() => { ... })()` wraps the function in parentheses before the call.
  while (ts.isParenthesizedExpression(parent)) parent = parent.parent;
  return !ts.isCallExpression(parent) && !ts.isNewExpression(parent);
}

function isDeferredCallback(node: Node): boolean {
  return (
    ts.isFunctionLike(node) && ts.isCallExpression(node.parent) && deferredCallName.test(calleeName(node.parent) ?? '')
  );
}

// Callbacks of `then`, `catch` and `finally` run as promise reactions, so a throw in one rejects the derived promise.
function isPromiseReaction(node: Node): boolean {
  return (
    ts.isFunctionLike(node) &&
    ts.isCallExpression(node.parent) &&
    promiseReactionName.test(calleeName(node.parent) ?? '')
  );
}

// A Promise executor's throw becomes a rejection instead of leaving the handler.
function isPromiseExecutor(node: Node): boolean {
  return (
    ts.isFunctionLike(node) &&
    ts.isNewExpression(node.parent) &&
    ts.isIdentifier(node.parent.expression) &&
    node.parent.expression.text === 'Promise'
  );
}

// A `return` in a finally block cancels a throw from the try or catch block.
function finallyReturns(statement: TryStatement): boolean {
  return (statement.finallyBlock?.statements ?? []).some((inner) => ts.isReturnStatement(inner));
}

// A `let` or `var` may have been reassigned, so its initializer is not trustworthy.
function isMutableVariable(declaration: Node | undefined): boolean {
  return (
    declaration !== undefined &&
    ts.isVariableDeclaration(declaration) &&
    !(ts.getCombinedNodeFlags(declaration) & ts.NodeFlags.Const)
  );
}

// An async function turns a throw into a rejected promise instead of letting it escape.
function isAsyncFunction(node: Node): boolean {
  return (
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)
  );
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

// The function a call invokes when it is written inside the handler, so a helper that rethrows is read at its call site.
function localFunction(expression: Expression, handler: Node, checker: CheckerAdapter): Node | undefined {
  const callee = ts.skipOuterExpressions(expression);
  if (!ts.isIdentifier(callee)) return;
  const declaration = checker.getSymbolAtLocation(callee)?.valueDeclaration;
  if (isMutableVariable(declaration)) return;
  const target = functionOf(declaration);
  return target && target.pos >= handler.pos && target.end <= handler.end ? target : undefined;
}

// A throw counts only when it leaves the handler, so one inside a `try` that has a `catch`, whose `finally` returns, or
// inside a promise callback is not evidence. The last write to `process.exitCode` decides whether an exit status stays.
function endsOrRethrows(handler: Node, checker: CheckerAdapter): boolean {
  let ends = false;
  let exitCodeRetained = false;
  const visitedHelpers = new Set<Node>();
  const visitChildren = (node: Node, swallowed: boolean): void => {
    ts.forEachChild(node, (child) =>
      visit(child, isPromiseExecutor(child) || isPromiseReaction(child) || (swallowed && !isDeferredCallback(child))),
    );
  };
  const visitHelper = (helper: Node, swallowed: boolean): void => {
    if (visitedHelpers.has(helper)) return;
    visitedHelpers.add(helper);
    visitChildren(helper, swallowed || isAsyncFunction(helper));
  };
  const visitCalledHelpers = (call: CallExpression, swallowed: boolean): void => {
    const name = calleeName(call) ?? '';
    const callee = localFunction(call.expression, handler, checker);
    if (callee) visitHelper(callee, swallowed);
    if (!deferredCallName.test(name)) return;
    // A named function handed to a scheduler runs later, like an inline callback.
    for (const argument of call.arguments) {
      const scheduled = localFunction(argument, handler, checker);
      if (scheduled) visitHelper(scheduled, promiseReactionName.test(name));
    }
  };
  const visit = (node: Node, swallowed: boolean): void => {
    if (ends || isDormantFunction(node)) return;
    if (ts.isThrowStatement(node) && !swallowed) ends = true;
    else if (isExitCodeAssignment(node, checker)) exitCodeRetained = !clearsExitCode(node);
    else if (ts.isCallExpression(node) && shutdownCallName.test(calleeName(node) ?? '')) ends = true;
    else if (ts.isTryStatement(node)) {
      const cancelsThrow = finallyReturns(node);
      visit(node.tryBlock, swallowed || cancelsThrow || node.catchClause !== undefined);
      if (node.catchClause) visit(node.catchClause, swallowed || cancelsThrow);
      if (node.finallyBlock) visit(node.finallyBlock, swallowed);
    } else {
      if (ts.isCallExpression(node)) visitCalledHelpers(node, swallowed);
      visitChildren(node, swallowed);
    }
  };
  visitChildren(handler, false);
  return ends || exitCodeRetained;
}

// The handler's code when it is written in place or is a function, method or property of this file; undefined when it
// comes from elsewhere and cannot be read.
function handlerBody(handler: Expression, checker: CheckerAdapter): Node | undefined {
  const expression = ts.skipOuterExpressions(handler);
  if (ts.isArrowFunction(expression) || ts.isFunctionExpression(expression)) return expression;
  if (!ts.isIdentifier(expression) && !ts.isPropertyAccessExpression(expression)) return;
  const declaration = checker.getSymbolAtLocation(expression)?.valueDeclaration;
  if (isMutableVariable(declaration)) return;
  return functionOf(declaration);
}

function checkUncaughtException(sourceFile: SourceFile, file: string, checker: CheckerAdapter): Finding[] {
  if (!sourceFile.text.includes('uncaughtException') || isIgnoredSource(sourceFile, file)) return [];
  const findings: Finding[] = [];
  walkNodes(sourceFile, (node) => {
    if (!ts.isCallExpression(node) || !isProcessListenerCall(node, checker)) return;
    const body = node.arguments[1] && handlerBody(node.arguments[1], checker);
    if (!body || endsOrRethrows(body, checker)) return;
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
