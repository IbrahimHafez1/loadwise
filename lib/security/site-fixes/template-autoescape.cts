// Rule id -> build({ finding, node, sourceFile, text, load }) => { edits, note } | undefined; see
// lib/performance/site-fix.cjs.
import { ts, ancestor, replaceNode } from '../../performance/site-fixes/helpers.cjs';
import type { FixResult, SiteFixBuilder, SiteFixInput } from '../../shared/types.cjs';

type EscapeOption = 'autoescape' | 'noEscape';

// Option name -> the value that keeps HTML escaping on.
const escapingValues: Record<EscapeOption, string> = { autoescape: 'true', noEscape: 'false' };
const disablingKeywords: Record<EscapeOption, number> = {
  autoescape: ts.SyntaxKind.FalseKeyword,
  noEscape: ts.SyntaxKind.TrueKeyword,
};
const note =
  'Every value this engine renders is HTML-escaped again, so a template that prints trusted markup, or HTML escaped earlier, shows visible tags or doubled entities. Check each view, and mark trusted values individually (`| safe` in nunjucks and swig, triple braces in Handlebars).';

function isEscapeOption(name: string): name is EscapeOption {
  return Object.hasOwn(escapingValues, name);
}

function autoescapeFix({ node }: SiteFixInput): FixResult | undefined {
  const property = node && ancestor(node, ts.isPropertyAssignment);
  if (!property || !ts.isIdentifier(property.name) || !isEscapeOption(property.name.text)) return;
  const option = property.name.text;
  const value = ts.skipOuterExpressions(property.initializer);
  if (value.kind !== disablingKeywords[option]) return;
  return { edits: [replaceNode(value, escapingValues[option])], requiresReview: true, note };
}

const builders: Record<string, SiteFixBuilder> = { 'template-autoescape-disabled': autoescapeFix };

export default builders;
