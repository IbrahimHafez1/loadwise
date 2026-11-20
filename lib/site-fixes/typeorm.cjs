'use strict';

const { ts, calleeCall, indentationAt } = require('./helpers.cjs');

const existenceMethodByRead = { findOne: 'exists', findOneBy: 'existsBy' };
const countMethodByMessage = [
  { marker: 'Repository.count()', read: 'find', replacement: 'count' },
  { marker: 'Repository.countBy()', read: 'findBy', replacement: 'countBy' },
  { marker: 'Model.count()', read: 'findAll', replacement: 'count' },
];

// The method name of `receiver.method(...)`, when the call has that plain shape.
function calledMethod(call) {
  if (!call || !ts.isPropertyAccessExpression(call.expression)) return;
  return call.expression.name;
}

function skipParentheses(node) {
  let current = node;
  while (ts.isParenthesizedExpression(current.parent)) current = current.parent;
  return current;
}

const nullishComparisonTokens = [ts.SyntaxKind.ExclamationEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken];

function isNegation(node) {
  return ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken;
}

// The identifier a guard reads: `x`, `!x`, `!!x`, `Boolean(x)` or `x != null` style comparisons.
// `comparison` is set for the last form, which is only true for an entity, never for a boolean.
function testedIdentifier(expression, allowBare) {
  let value = ts.skipOuterExpressions(expression);
  let comparison;
  if (isNegation(value)) {
    value = ts.skipOuterExpressions(value.operand);
    if (isNegation(value)) value = ts.skipOuterExpressions(value.operand);
  } else if (ts.isCallExpression(value) && ts.isIdentifier(value.expression) && value.expression.text === 'Boolean') {
    if (value.arguments.length !== 1) return;
    value = ts.skipOuterExpressions(value.arguments[0]);
  } else if (ts.isBinaryExpression(value) && nullishComparisonTokens.includes(value.operatorToken.kind)) {
    comparison = value;
    value = ts.skipOuterExpressions(value.left);
  } else if (!allowBare) return;
  return ts.isIdentifier(value) ? { identifier: value, comparison } : undefined;
}

// `if (x)` / `return !!x` / `return x != null` ... directly after `const x = ...`, with no other use of `x` in the block.
function nextGuardTest(declaration) {
  const statement = declaration.parent.parent;
  const block = statement.parent;
  if (!ts.isIdentifier(declaration.name) || !ts.isVariableStatement(statement) || !ts.isBlock(block)) return;
  const guard = block.statements[block.statements.indexOf(statement) + 1];
  if (!guard || (!ts.isIfStatement(guard) && !ts.isReturnStatement(guard)) || !guard.expression) return;
  // `return x` hands the entity on, so only the boolean forms count as an existence test there.
  const test = testedIdentifier(guard.expression, ts.isIfStatement(guard));
  if (test?.identifier.text !== declaration.name.text) return;
  let mentions = 0;
  (function count(node) {
    if (ts.isIdentifier(node) && node.text === declaration.name.text) mentions++;
    ts.forEachChild(node, count);
  })(block);
  return mentions === 2 ? test : undefined;
}

function usedOnlyByNextGuard(declaration) {
  return Boolean(nextGuardTest(declaration));
}

// A boolean is never nullish, so `x != null` must collapse to `x` once x holds the existence result.
function nullishComparisonEdits(awaited) {
  const declaration = skipParentheses(awaited).parent;
  const comparison = ts.isVariableDeclaration(declaration) && nextGuardTest(declaration)?.comparison;
  if (!comparison) return [];
  return [{ start: comparison.getStart(), end: comparison.end, text: comparison.left.getText() }];
}

// True when the awaited value is only ever tested for truthiness, so a boolean can replace the entity.
function usedOnlyAsCondition(awaited) {
  let value = skipParentheses(awaited);
  while (
    ts.isBinaryExpression(value.parent) &&
    [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken].includes(value.parent.operatorToken.kind)
  ) {
    value = skipParentheses(value.parent);
  }
  const use = value.parent;
  if (ts.isVariableDeclaration(use)) return use.initializer === value && usedOnlyByNextGuard(use);
  return (
    (ts.isPrefixUnaryExpression(use) && use.operator === ts.SyntaxKind.ExclamationToken) ||
    (ts.isIfStatement(use) && use.expression === value) ||
    (ts.isConditionalExpression(use) && use.condition === value)
  );
}

function awaitOf(call) {
  const awaited = skipParentheses(call).parent;
  if (ts.isAwaitExpression(awaited) && awaited.expression === skipParentheses(call)) return awaited;
}

function existenceFix({ finding, node }) {
  const call = calleeCall(node);
  const method = calledMethod(call);
  const replacement = method && existenceMethodByRead[method.text];
  if (!replacement || !finding.message.includes(`Repository.${replacement}()`) || call.arguments.length !== 1) return;
  const awaited = awaitOf(call);
  if (!awaited || awaited.expression !== call || !usedOnlyAsCondition(awaited)) return;
  return {
    edits: [{ start: method.getStart(), end: method.end, text: replacement }, ...nullishComparisonEdits(awaited)],
  };
}

function isWhereOnlyOptions(call) {
  if (!call.arguments.length) return true;
  const [options] = call.arguments;
  return (
    call.arguments.length === 1 &&
    ts.isObjectLiteralExpression(options) &&
    options.properties.every(
      (property) =>
        (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) &&
        property.name.text === 'where',
    )
  );
}

function projectionFix({ finding, node, text }) {
  const call = calleeCall(node);
  const method = calledMethod(call);
  const selection = /select: (\{ .+? \}) to avoid/.exec(finding.message)?.[1];
  if (method?.text !== 'find' || !selection || !isWhereOnlyOptions(call)) return;
  const select = `select: ${selection}`;
  const [options] = call.arguments;
  if (!options) return { edits: [{ start: call.arguments.pos, end: call.arguments.pos, text: `{ ${select} }` }] };
  const lastProperty = options.properties.at(-1);
  if (!lastProperty) return { edits: [{ start: options.getStart(), end: options.end, text: `{ ${select} }` }] };
  const startsOwnLine = text.slice(options.getStart(), lastProperty.getStart()).includes('\n');
  if (!startsOwnLine) return { edits: [{ start: lastProperty.end, end: lastProperty.end, text: `, ${select}` }] };
  // Multi-line literal: add the property on its own line, matching the last property's indentation and comma style.
  const indentation = indentationAt(text, lastProperty.getStart());
  const trailingComma = options.properties.hasTrailingComma;
  const insertAt = trailingComma ? text.indexOf(',', lastProperty.end) + 1 : lastProperty.end;
  const addition = `\n${indentation}${select}${trailingComma ? ',' : ''}`;
  return { edits: [{ start: insertAt, end: insertAt, text: trailingComma ? addition : `,${addition}` }] };
}

// `(await repo.find(...)).length` -> `await repo.count(...)`; parentheses stay when the surrounding syntax needs them.
function countFix({ finding, node, text }) {
  const access = node.parent;
  if (!ts.isPropertyAccessExpression(access) || access.name !== node || access.questionDotToken) return;
  const counting = countMethodByMessage.find((candidate) => finding.message.includes(`\`${candidate.marker}\``));
  const wrapped = access.expression;
  if (!counting || !ts.isParenthesizedExpression(wrapped) || !ts.isAwaitExpression(wrapped.expression)) return;
  const call = wrapped.expression.expression;
  const method = ts.isCallExpression(call) && calledMethod(call);
  if (!method || method.text !== counting.read || (counting.read !== 'findBy' && !isWhereOnlyOptions(call))) return;
  const countCall =
    text.slice(call.getStart(), method.getStart()) + counting.replacement + text.slice(method.end, call.end);
  const needsNoParentheses = ts.isVariableDeclaration(access.parent) || ts.isReturnStatement(access.parent);
  const awaitedCount = `await ${countCall}`;
  return {
    edits: [
      {
        start: access.getStart(),
        end: access.end,
        text: needsNoParentheses ? awaitedCount : `(${awaitedCount})`,
      },
    ],
  };
}

module.exports = {
  'typeorm-existence-materialization': existenceFix,
  'typeorm-wide-projection': projectionFix,
  'orm-count-materialization': countFix,
};
