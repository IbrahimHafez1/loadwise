'use strict';

// Rule id -> build({ finding, node, sourceFile, text, load }) => { edits, note } | undefined; see lib/performance/site-fix.cjs.
const { ts, textOf, replaceNode } = require('../../performance/site-fixes/helpers.cjs');

const equalityNote =
  '`$eq` matches the value literally, so an object sent by a caller no longer acts as query operators. A scalar value matches exactly as before.';

// The filter property whose value starts at the reported node: `email: req.body.email` or the shorthand `{ email }`.
function filterProperty(node, sourceFile) {
  for (let current = node; current?.parent; current = current.parent) {
    const parent = current.parent;
    if (ts.isPropertyAssignment(parent) && parent.initializer === current) return parent;
    if (ts.isShorthandPropertyAssignment(parent) && parent.name === current) return parent;
    if (parent.getStart(sourceFile) !== current.getStart(sourceFile)) return;
  }
}

function wrapInEquality({ node, sourceFile }) {
  const property = node && filterProperty(node, sourceFile);
  if (!property || !ts.isObjectLiteralExpression(property.parent)) return;
  if (textOf(property.name).replace(/['"]/g, '').startsWith('$')) return;
  if (ts.isShorthandPropertyAssignment(property)) {
    const name = textOf(property.name);
    return { edits: [replaceNode(property, `${name}: { $eq: ${name} }`)], note: equalityNote };
  }
  return { edits: [replaceNode(property.initializer, `{ $eq: ${textOf(property.initializer)} }`)], note: equalityNote };
}

module.exports = { 'nosql-operator-injection': wrapInEquality };
