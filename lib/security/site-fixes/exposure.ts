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
} from '../../performance/site-fixes/helpers.js';
import { buildFix as corsOriginRegexFix } from '../exposure/cors-origin-regex.js';
import { unwrap, findProperty, isFullyLiteral, isFalse, isTrue } from '../exposure/literals.js';
import type { FixResult, SiteFixBuilder, SiteFixInput } from '../../shared/types.js';

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

function corsCredentialsOriginFix({ node }: SiteFixInput): FixResult | undefined {
  if (!node) return;
  const property = ancestor(node, ts.isPropertyAssignment);
  if (!property) return;
  const literal = unwrap(property.initializer);
  if (!literal || (!isTrue(literal) && !(ts.isStringLiteralLike(literal) && literal.text === '*'))) return;
  return {
    edits: [replaceNode(literal, "(process.env.ALLOWED_ORIGINS?.split(',') ?? [])")],
    note: 'Replaces wildcard/reflecting origin with an explicit `ALLOWED_ORIGINS` env allowlist.',
  };
}

function storagePublicAclFix({ node }: SiteFixInput): FixResult | undefined {
  if (!node) return;
  const literal = ts.isStringLiteralLike(node) ? node : ancestor(node, ts.isStringLiteralLike);
  if (!literal || !/^public-read(?:-write)?$/i.test(literal.text)) return;
  return {
    edits: [replaceNode(literal, "'private'")],
    note: "Sets ACL to `'private'` so uploaded objects are not publicly readable.",
  };
}

function secretInLogFix({ node }: SiteFixInput): FixResult | undefined {
  if (!node) return;
  const call = ts.findAncestor(node, ts.isCallExpression);
  if (!call || call.arguments.length < 1) return;
  const arg = call.arguments.find((candidate) => candidate.pos <= node.pos && node.end <= candidate.end);
  if (!arg || ts.isStringLiteralLike(arg)) return;
  return {
    edits: [replaceNode(arg, "'[REDACTED]'")],
    note: "Replaces the logged secret argument with `'[REDACTED]'`.",
  };
}

function xmlExternalEntitiesFix({ node }: SiteFixInput): FixResult | undefined {
  if (!node) return;
  const property = ancestor(node, ts.isPropertyAssignment);
  if (!property) return;
  const value = unwrap(property.initializer);
  if (!value || !isTrue(value)) return;
  return {
    edits: [replaceNode(value, 'false')],
    note: 'Disables XML external entity expansion.',
  };
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
  'cors-credentials-any-origin': requireReview(
    'Restricts CORS origins to `process.env.ALLOWED_ORIGINS`; configure that env var before deploying.',
    corsCredentialsOriginFix,
  ),
  'storage-object-public-acl': requireReview(
    'Restricts object ACL to private; use signed URLs if public downloads are needed.',
    storagePublicAclFix,
  ),
  'secret-in-log': secretInLogFix,
  'xml-external-entities': xmlExternalEntitiesFix,
  'graphql-introspection-enabled': requireReview(
    'Introspection is switched off in production, which breaks tooling that queries the schema there.',
    graphqlFix,
  ),
  'nest-validation-without-whitelist': validationPipeFix,
};

export default builders;
