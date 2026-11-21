'use strict';

const { ts, calleeCall, freshName, replaceNode } = require('./helpers.cjs');
const { insertedIdQuery, constDeclaration } = require('../last-insert-id.cjs');

function firstElement(value, optional = false) {
  const element = ts.skipOuterExpressions(value);
  if (
    ts.isElementAccessExpression(element) &&
    Boolean(element.questionDotToken) === optional &&
    ts.isNumericLiteral(element.argumentExpression) &&
    element.argumentExpression.text === '0'
  )
    return ts.skipOuterExpressions(element.expression);
}

// Every reference has to be accounted for before changing the shape of a result or row.
function usedElsewhere(block, declaration, use) {
  function visit(node) {
    if (ts.isIdentifier(node)) return node.text === declaration.text && node !== declaration && node !== use;
    return ts.forEachChild(node, (child) => visit(child) || undefined);
  }
  return visit(block);
}

function insertIdOrLookup(site, initializer, result, rowAccess = '') {
  const text = initializer.getText();
  const start = result.getStart() - initializer.getStart();
  const query = '(' + site.declaration.initializer.getText() + ')';
  const original = text.slice(0, start) + query + text.slice(start + result.getWidth());
  const fallback = rowAccess ? '(' + original + ')' + rowAccess : original;
  return result.getText() + '?.[0]?.insertId ?? ' + fallback;
}

function extractedId(site, extracted) {
  const block = site.statement.parent;
  const value = ts.skipOuterExpressions(extracted.initializer);
  if (ts.isPropertyAccessExpression(value) && !ts.isOptionalChain(value) && value.name.text === site.alias) {
    const row = firstElement(value.expression);
    const result = row && firstElement(row);
    if (result)
      return {
        result,
        edits: [replaceNode(extracted.initializer, insertIdOrLookup(site, extracted.initializer, result))],
      };
  }
  // Keep a separate first-row binding and the caller's exact conversion/fallback.
  const row = firstElement(value, true);
  const result = row && firstElement(row);
  if (!result || extracted.type || !ts.isIdentifier(extracted.name)) return;
  const next = constDeclaration(block.statements[block.statements.indexOf(site.next) + 1]);
  const convert = next?.initializer;
  if (
    !convert ||
    !ts.isCallExpression(convert) ||
    convert.arguments.length !== 1 ||
    convert.expression.getText() !== 'Number'
  )
    return;
  const fallback = convert.arguments[0];
  if (!ts.isBinaryExpression(fallback) || fallback.operatorToken.kind !== ts.SyntaxKind.QuestionQuestionToken) return;
  const access = fallback.left;
  if (!ts.isPropertyAccessExpression(access) || !access.questionDotToken || access.name.text !== site.alias) return;
  if (
    !ts.isIdentifier(access.expression) ||
    access.expression.text !== extracted.name.text ||
    usedElsewhere(block, extracted.name, access.expression)
  )
    return;
  const id = freshName(extracted.getSourceFile(), extracted.name.text + 'Id');
  if (!id) return;
  return {
    result,
    edits: [
      replaceNode(extracted.name, id),
      replaceNode(extracted.initializer, insertIdOrLookup(site, extracted.initializer, result, '?.' + site.alias)),
      replaceNode(access, id),
    ],
  };
}

function insertResultFix({ node, text }) {
  const call = calleeCall(node);
  const site = call && insertedIdQuery(call);
  if (!site) return;
  const extracted = constDeclaration(site.next);
  if (!extracted?.initializer) return;
  const read = extractedId(site, extracted);
  const result = read?.result;
  if (!result || !ts.isIdentifier(result) || result.text !== site.declaration.name.text) return;
  if (usedElsewhere(site.statement.parent, site.declaration.name, result)) return;
  const leading = text.slice(site.insert.end, site.statement.getStart());
  // A sole description of the removed query is obsolete. Preserve all other comments and directives.
  if (!/^\s*(?:\/\/\s*get the last inserted id using raw sql\.?[ \t]*(?:\r?\n)\s*)?$/i.test(leading)) return;
  if (/\/\/|\/\*/.test(site.statement.getText() + extracted.initializer.getText())) return;
  return {
    edits: [
      { start: site.insert.getStart(), end: site.insert.getStart(), text: `const ${result.text} = ` },
      { start: site.insert.end, end: site.statement.end, text: '' },
      ...read.edits,
    ],
    requiresReview: true,
    note: 'Check the generated key and its type with your mysql2 settings, including custom typeCast and big-number options. The original lookup runs only when the insert response supplies no ID.',
  };
}

module.exports = { 'drizzle-last-insert-id': insertResultFix };
