// `process.on('uncaughtException', handler)` where the handler only logs. Node keeps running after such a handler, but
// the process is in an unknown state (half-written data, leaked handles), so the handler has to end the process.
import { ts } from '../performance/compiler.js';
import { walkNodes } from './walk.js';
import { isIgnoredSource } from './source-helpers.js';
import type { CheckerAdapter, Finding } from '../shared/types.js';
import type { CallExpression, Expression, Node, SourceFile } from 'typescript';

const listenerMethods = new Set(['on', 'once', 'addListener', 'prependListener']);
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

function isExitCodeAssignment(node: Node): boolean {
  if (!ts.isBinaryExpression(node) || node.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return false;
  return ts.isPropertyAccessExpression(node.left) && node.left.name.text === 'exitCode';
}

function calleeName(call: CallExpression): string | undefined {
  const callee = ts.skipOuterExpressions(call.expression);
  if (ts.isIdentifier(callee)) return callee.text;
  return ts.isPropertyAccessExpression(callee) ? callee.name.text : undefined;
}

function endsOrRethrows(handler: Node): boolean {
  let ends = false;
  walkNodes(handler, (node) => {
    if (ts.isThrowStatement(node) || isExitCodeAssignment(node)) ends = true;
    if (ts.isCallExpression(node)) ends = ends || shutdownCallName.test(calleeName(node) ?? '');
  });
  return ends;
}

// The handler's code when it is written in place or is a function of this file; undefined when it comes from elsewhere
// and cannot be read.
function handlerBody(handler: Expression, checker: CheckerAdapter): Node | undefined {
  const expression = ts.skipOuterExpressions(handler);
  if (ts.isArrowFunction(expression) || ts.isFunctionExpression(expression)) return expression;
  if (!ts.isIdentifier(expression)) return;
  const declaration = checker.getSymbolAtLocation(expression)?.valueDeclaration;
  if (!declaration || declaration.getSourceFile().isDeclarationFile) return;
  if (ts.isFunctionDeclaration(declaration)) return declaration;
  const initializer = ts.isVariableDeclaration(declaration) ? declaration.initializer : undefined;
  return initializer && (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))
    ? initializer
    : undefined;
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
