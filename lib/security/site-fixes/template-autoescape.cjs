'use strict';

// Rule id -> build({ finding, node, sourceFile, text, load }) => { edits, note } | undefined; see lib/performance/site-fix.cjs.
const { ts, ancestor, replaceNode } = require('../../performance/site-fixes/helpers.cjs');

// Option name -> the value that keeps HTML escaping on.
const escapingValues = { autoescape: 'true', noEscape: 'false' };
const disablingKeywords = { autoescape: ts.SyntaxKind.FalseKeyword, noEscape: ts.SyntaxKind.TrueKeyword };
const note =
  'Every value this engine renders is HTML-escaped again, so a template that prints trusted markup, or HTML escaped earlier, shows visible tags or doubled entities. Check each view, and mark trusted values individually (`| safe` in nunjucks and swig, triple braces in Handlebars).';

function autoescapeFix({ node }) {
  const property = node && ancestor(node, ts.isPropertyAssignment);
  if (!property || !ts.isIdentifier(property.name) || !Object.hasOwn(escapingValues, property.name.text)) return;
  const option = property.name.text;
  const value = ts.skipOuterExpressions(property.initializer);
  if (value.kind !== disablingKeywords[option]) return;
  return { edits: [replaceNode(value, escapingValues[option])], requiresReview: true, note };
}

module.exports = { 'template-autoescape-disabled': autoescapeFix };
