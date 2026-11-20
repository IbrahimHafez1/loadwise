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

// `if (x)` / `if (!x)` directly after `const x = ...`, with no other use of `x` in the block.
function usedOnlyByNextGuard(declaration) {
  const statement = declaration.parent.parent;
  const block = statement.parent;
  if (!ts.isIdentifier(declaration.name) || !ts.isVariableStatement(statement) || !ts.isBlock(block)) return false;
  const guard = block.statements[block.statements.indexOf(statement) + 1];
  if (!guard || !ts.isIfStatement(guard)) return false;
  let condition = ts.skipOuterExpressions(guard.expression);
  if (ts.isPrefixUnaryExpression(condition) && condition.operator === ts.SyntaxKind.ExclamationToken) {
    condition = ts.skipOuterExpressions(condition.operand);
  }
  if (!ts.isIdentifier(condition) || condition.text !== declaration.name.text) return false;
  let mentions = 0;
  (function count(node) {
    if (ts.isIdentifier(node) && node.text === declaration.name.text) mentions++;
    ts.forEachChild(node, count);
  })(block);
  return mentions === 2;
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
  return { edits: [{ start: method.getStart(), end: method.end, text: replacement }] };
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
