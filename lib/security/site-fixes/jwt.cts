// Rule id -> build({ finding, node, sourceFile, text, load }) => { edits, note } | undefined; see
// lib/performance/site-fix.cjs.
import { calleeName } from '../../performance/call-syntax.cjs';
import { ts, ancestor, calleeCall, addProperty, addOptionsArgument } from '../../performance/site-fixes/helpers.cjs';
import { removeListItem } from './list-edits.cjs';
import type { CallExpression, ObjectLiteralExpression } from 'typescript';
import type { FixResult, SiteFixBuilder, SiteFixInput } from '../../shared/types.cjs';

const expiryPlaceholder = "expiresIn: '15m'";
const expiryNote =
  'The 15 minute lifetime is a placeholder: set it from how long this token may stay valid, and check that clients refresh or re-authenticate when it ends. Tokens already issued keep their old lifetime. Only an object-literal payload is edited: jsonwebtoken rejects `expiresIn` for a string payload.';
const noneNote =
  'Unsigned tokens are no longer accepted by this algorithm list. Check that nothing still issues or sends tokens with the none algorithm.';
const jsonwebtokenImport = /from\s+['"]jsonwebtoken['"]|require\(\s*['"]jsonwebtoken['"]\s*\)/;
const nestJwtImport = /from\s+['"]@nestjs\/jwt['"]|require\(\s*['"]@nestjs\/jwt['"]\s*\)/;
const jsonwebtokenOptionsIndex = 2;
const nestOptionsIndex = 1;

function isPlainLiteral(literal: ObjectLiteralExpression) {
  return literal.properties.every(
    (property) => !ts.isSpreadAssignment(property) && !(property.name && ts.isComputedPropertyName(property.name)),
  );
}

// Which library signs here decides which argument holds the options; a file using both is left
// alone.
function optionsIndexFor(call: CallExpression, text: string) {
  const usesJsonwebtoken = jsonwebtokenImport.test(text);
  const usesNest = nestJwtImport.test(text);
  if (usesJsonwebtoken === usesNest) return;
  const name = calleeName(call);
  if (usesJsonwebtoken) return name === 'sign' ? jsonwebtokenOptionsIndex : undefined;
  return name === 'sign' || name === 'signAsync' ? nestOptionsIndex : undefined;
}

function expiryFix({ node, text }: SiteFixInput): FixResult | undefined {
  if (text === undefined) return;
  const call = node && calleeCall(node);
  const optionsIndex = call && optionsIndexFor(call, text);
  if (!call || optionsIndex === undefined || call.arguments.length < optionsIndex) return;
  const payload = ts.skipOuterExpressions(call.arguments[0]);
  if (!ts.isObjectLiteralExpression(payload) || !isPlainLiteral(payload)) return;
  const result = { requiresReview: true, note: expiryNote };
  if (call.arguments.length === optionsIndex)
    return { ...result, edits: [addOptionsArgument(call, expiryPlaceholder, text)] };
  const options = ts.skipOuterExpressions(call.arguments[optionsIndex]);
  if (call.arguments.length > optionsIndex + 1) return;
  if (ts.isObjectLiteralExpression(options) && isPlainLiteral(options))
    return { ...result, edits: [addProperty(options, expiryPlaceholder, text)] };
  if (optionsIndex === jsonwebtokenOptionsIndex && (ts.isArrowFunction(options) || ts.isFunctionExpression(options))) {
    const at = options.getStart();
    return { ...result, edits: [{ start: at, end: at, text: `{ ${expiryPlaceholder} }, ` }] };
  }
}

// Only the `algorithms: [..., 'none']` form is mechanical: a signing call needs a real algorithm
// that matches its key.
function noneFix({ node }: SiteFixInput): FixResult | undefined {
  if (!node) return;
  const literal = ancestor(node, ts.isStringLiteralLike);
  const list = literal?.parent;
  if (!literal || !list || !ts.isArrayLiteralExpression(list)) return;
  const property = list.parent;
  if (!ts.isPropertyAssignment(property) || property.name.getText() !== 'algorithms') return;
  const edit = removeListItem(list.elements, literal);
  return edit && { edits: [edit], note: noneNote };
}

const builders: Record<string, SiteFixBuilder> = {
  'jwt-none-algorithm': noneFix,
  'jwt-sign-without-expiry': expiryFix,
};

export default builders;
