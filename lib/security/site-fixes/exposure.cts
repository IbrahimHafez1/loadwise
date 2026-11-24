// Rule id -> build({ finding, node, sourceFile, text, load }) => { edits, note } | undefined; see
// lib/performance/site-fix.cjs.
import {
  ts,
  ancestor,
  calleeCall,
  addProperty,
  addOptionsArgument,
  replaceNode,
  requireReview,
} from '../../performance/site-fixes/helpers.cjs';
import { buildFix as corsOriginRegexFix } from '../exposure/cors-origin-regex.cjs';
import { unwrap, findProperty, isFullyLiteral, isFalse, isTrue } from '../exposure/literals.cjs';
import type { FixResult, SiteFixBuilder, SiteFixInput } from '../../shared/types.cjs';

const cookieMethods = new Set(['cookie', 'setCookie']);
const nonProductionCheck = "process.env.NODE_ENV !== 'production'";
const whitelistReview = {
  note: 'With whitelist enabled, DTO properties that carry no validation decorator are stripped from the request. Check each DTO before applying.',
  requiresReview: true,
};

function cookieFix({ node, text }: SiteFixInput): FixResult | undefined {
  if (!node || text === undefined) return;
  const call = calleeCall(node);
  const callee = call && unwrap(call.expression);
  if (!call || !callee || !ts.isPropertyAccessExpression(callee) || !cookieMethods.has(callee.name.text)) return;
  const options = call.arguments[2] && unwrap(call.arguments[2]);
  if (!options && call.arguments.length === 2) return { edits: [addOptionsArgument(call, 'httpOnly: true', text)] };
  if (!options || !ts.isObjectLiteralExpression(options) || !isFullyLiteral(options)) return;
  if (findProperty(options, 'httpOnly')) return;
  return { edits: [addProperty(options, 'httpOnly: true', text)] };
}

function validationPipeFix({ node, text }: SiteFixInput): FixResult | undefined {
  if (!node || text === undefined) return;
  const pipe = ancestor(node, ts.isNewExpression);
  if (!pipe || !pipe.arguments) return;
  if (!pipe.arguments.length) {
    const insertAt = pipe.end - 1;
    return { edits: [{ start: insertAt, end: insertAt, text: '{ whitelist: true }' }], ...whitelistReview };
  }
  const options = unwrap(pipe.arguments[0]);
  if (!ts.isObjectLiteralExpression(options) || !isFullyLiteral(options)) return;
  const whitelist = findProperty(options, 'whitelist');
  if (!whitelist) return { edits: [addProperty(options, 'whitelist: true', text)], ...whitelistReview };
  if (!isFalse(whitelist.value)) return;
  return { edits: [replaceNode(whitelist.value, 'true')], ...whitelistReview };
}

function graphqlFix({ node }: SiteFixInput): FixResult | undefined {
  if (!node) return;
  const property = ancestor(node, ts.isPropertyAssignment);
  const value = property && unwrap(property.initializer);
  if (!value || !isTrue(value)) return;
  return { edits: [replaceNode(value, nonProductionCheck)] };
}

const builders: Record<string, SiteFixBuilder> = {
  'cookie-missing-security-flags': requireReview(
    'httpOnly hides the cookie from browser scripts, so client code that reads it stops working.',
    cookieFix,
  ),
  'cors-origin-regex-unanchored': requireReview(
    'Anchoring the pattern changes which origins the server accepts.',
    corsOriginRegexFix,
  ),
  'graphql-introspection-enabled': requireReview(
    'Introspection is switched off in production, which breaks tooling that queries the schema there.',
    graphqlFix,
  ),
  'nest-validation-without-whitelist': validationPipeFix,
};

export default builders;
