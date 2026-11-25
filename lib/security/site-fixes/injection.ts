// Rule id -> build({ finding, node, sourceFile, text, load }) => { edits, note } | undefined; see
// lib/performance/site-fix.cjs.
import { ts, textOf, replaceNode, requireReview } from '../../performance/site-fixes/helpers.js';
import type { Node, PropertyAssignment, ShorthandPropertyAssignment, SourceFile } from 'typescript';
import type { FixResult, SiteFixBuilder, SiteFixInput } from '../../shared/types.js';

const equalityNote =
  '`$eq` matches the value literally, so an object sent by a caller no longer acts as query operators. A scalar value matches exactly as before.';

// The filter property whose value starts at the reported node: `email: req.body.email` or the
// shorthand `{ email }`.
function filterProperty(
  node: Node,
  sourceFile: SourceFile,
): PropertyAssignment | ShorthandPropertyAssignment | undefined {
  for (let current: Node = node; current?.parent; current = current.parent) {
    const parent = current.parent;
    if (ts.isPropertyAssignment(parent) && parent.initializer === current) return parent;
    if (ts.isShorthandPropertyAssignment(parent) && parent.name === current) return parent;
    if (parent.getStart(sourceFile) !== current.getStart(sourceFile)) return;
  }
}

function wrapInEquality({ node, sourceFile }: SiteFixInput): FixResult | undefined {
  const property = node && sourceFile && filterProperty(node, sourceFile);
  if (!property || !ts.isObjectLiteralExpression(property.parent)) return;
  if (textOf(property.name).replaceAll(/['"]/g, '').startsWith('$')) return;
  if (ts.isShorthandPropertyAssignment(property)) {
    const name = textOf(property.name);
    return { edits: [replaceNode(property, `${name}: { $eq: ${name} }`)], note: equalityNote };
  }
  return { edits: [replaceNode(property.initializer, `{ $eq: ${textOf(property.initializer)} }`)], note: equalityNote };
}

const builders: Record<string, SiteFixBuilder> = {
  'nosql-operator-injection': requireReview(
    'A caller that sends query operators in this field now matches nothing, so intended operator use breaks.',
    wrapInEquality,
  ),
};

export default builders;
