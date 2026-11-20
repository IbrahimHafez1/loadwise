'use strict';

const ts = require('typescript');
const { walkNodes } = require('./walk.cjs');
const { testSourcePattern } = require('./snapshot-context.cjs');
const { generatedSource } = require('./duplicates.cjs');

const loggerNames = new Set(['console', 'logger', 'log']);
const cleanupMethods = new Set([
  'close',
  'destroy',
  'release',
  'rollback',
  'disconnect',
  'end',
  'unlink',
  'rm',
  'kill',
]);

function callOf(statement) {
  if (!ts.isExpressionStatement(statement)) return;
  const expression = ts.isAwaitExpression(statement.expression)
    ? statement.expression.expression
    : statement.expression;
  return ts.isCallExpression(expression) ? expression : undefined;
}

// Parentheses, casts and non-null assertions do not change which function is called.
function withoutWrappers(expression) {
  while (
    ts.isParenthesizedExpression(expression) ||
    ts.isAsExpression(expression) ||
    ts.isNonNullExpression(expression) ||
    ts.isTypeAssertionExpression(expression) ||
    ts.isSatisfiesExpression(expression)
  )
    expression = expression.expression;
  return expression;
}

// Names along a call's receiver chain, base first: `this.logger.warn(...)` gives ['this', 'logger', 'warn'].
function calleeNames(call) {
  const names = [];
  let receiver = withoutWrappers(call.expression);
  while (ts.isPropertyAccessExpression(receiver)) {
    names.unshift(receiver.name.text);
    receiver = withoutWrappers(receiver.expression);
  }
  if (ts.isIdentifier(receiver)) names.unshift(receiver.text);
  else if (receiver.kind === ts.SyntaxKind.ThisKeyword) names.unshift('this');
  return names;
}

function isLoggingCall(statement) {
  const call = callOf(statement);
  if (!call) return false;
  const [base, owner] = calleeNames(call);
  return loggerNames.has(base) || (base === 'this' && /^_?(?:logger|log)$/i.test(owner ?? ''));
}

function isCleanupCall(statement) {
  const call = callOf(statement);
  return Boolean(call) && cleanupMethods.has(calleeNames(call).at(-1));
}

// Comments can follow the opening brace or any statement, on the same line or the next.
function hasComment(sourceFile, block) {
  const text = sourceFile.text;
  const positions = [block.getStart(sourceFile) + 1, ...block.statements.map((statement) => statement.end)];
  return positions.some(
    (position) =>
      ts.getLeadingCommentRanges(text, position)?.length || ts.getTrailingCommentRanges(text, position)?.length,
  );
}

// `try { require('optional-dependency') } catch {}` is how an optional feature is detected.
function probesOptionalModule(tryBlock) {
  let found = false;
  walkNodes(tryBlock, (node) => {
    if (!ts.isCallExpression(node)) return;
    const callee = node.expression;
    if (callee.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(callee) && callee.text === 'require'))
      found = true;
  });
  return found;
}

// A failed cleanup in a finally or catch block must not hide the error that is already propagating.
function insideCleanupPath(node) {
  for (let child = node, parent = node.parent; parent; child = parent, parent = parent.parent) {
    if (ts.isFunctionLike(parent)) return false;
    if (ts.isCatchClause(parent) || (ts.isTryStatement(parent) && parent.finallyBlock === child)) return true;
  }
  return false;
}

// True when a later statement runs, or when the try is the last statement of a loop body and the loop goes on.
function continuesAfter(tryStatement) {
  let statement = tryStatement;
  while (ts.isBlock(statement.parent) || ts.isSourceFile(statement.parent)) {
    const siblings = statement.parent.statements;
    if (siblings.indexOf(statement) < siblings.length - 1) return true;
    statement = statement.parent;
  }
  return ts.isIterationStatement(statement.parent, false);
}

function swallowKind(sourceFile, clause) {
  const tryStatement = clause.parent;
  const statements = clause.block.statements;
  if (hasComment(sourceFile, clause.block)) return;
  if (probesOptionalModule(tryStatement.tryBlock) || insideCleanupPath(tryStatement)) return;
  if (tryStatement.tryBlock.statements.length && tryStatement.tryBlock.statements.every(isCleanupCall)) return;
  if (!statements.length) return 'empty';
  if (statements.every(isLoggingCall) && continuesAfter(tryStatement)) return 'logs';
}

const advice =
  ' The failure is hidden from the caller, so the code carries on as if it had succeeded. Rethrow, return an error value, record a failure status, or add a comment saying why ignoring the error is safe.';

function checkSwallowedErrors(sourceFile, file) {
  if (testSourcePattern.test(file) || generatedSource(sourceFile, file)) return [];
  const findings = [];
  walkNodes(sourceFile, (node) => {
    if (!ts.isCatchClause(node)) return;
    const kind = swallowKind(sourceFile, node);
    if (!kind) return;
    const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    findings.push({
      file,
      line: position.line + 1,
      column: position.character + 1,
      ruleId: 'swallowed-error',
      message:
        (kind === 'empty'
          ? 'This catch block is empty.'
          : 'This catch block only logs the error and the code after it continues.') + advice,
    });
  });
  return findings;
}

module.exports = { checkSwallowedErrors };
