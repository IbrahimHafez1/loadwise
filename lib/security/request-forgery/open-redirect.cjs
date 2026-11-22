'use strict';

// open-redirect: a response redirect whose target site a link can choose.
const { syntax: ts } = require('../../performance/compiler.cjs');
const { importedFrom } = require('../bindings.cjs');
const {
  strip,
  nameText,
  propertyValue,
  isResponseReceiver,
  isGlobalIdentifier,
  hopReason,
  isRelativeRedirect,
  isProjectValidated,
  isHostHeader,
} = require('./shared.cjs');

const ruleId = 'open-redirect';
const message = (label) =>
  `The redirect target comes from \`${label}\`, so a link to this endpoint can send users to any site. Accept only relative paths (\`/\` but not \`//\`) or hosts from an allowlist.`;
const refererReason =
  "The target is the Referer header, which the user's own browser sets; confirm no page lets others choose it.";
// Project helpers that check or sanitize a URL (see lib/shared/function-summaries.cjs).
const validatedKinds = ['url'];
const refererLabel = /refer+er/i;

// Modules whose `redirect(url)` export sends a redirect response.
const redirectModules = new Set([
  '@remix-run/node',
  '@remix-run/server-runtime',
  '@remix-run/cloudflare',
  'react-router',
  'react-router-dom',
  'next/navigation',
]);
const headerSetters = new Set(['setHeader', 'header', 'set', 'append']);

function isNumeric(node, checker) {
  const value = strip(node);
  if (ts.isNumericLiteral(value)) return true;
  return Boolean(checker.getTypeAtLocation(value).flags & ts.TypeFlags.NumberLike);
}

// `res.redirect(url)`, `res.redirect(301, url)` and Fastify 5's `reply.redirect(url, 301)`.
function redirectTarget(call, checker) {
  const [first, second] = call.arguments;
  if (!first) return;
  return second && isNumeric(first, checker) ? second : first;
}

function isLocationName(node) {
  const value = strip(node);
  return Boolean(value && ts.isStringLiteralLike(value) && value.text.toLowerCase() === 'location');
}

function locationHeader(headers) {
  const literal = strip(headers);
  if (!literal || !ts.isObjectLiteralExpression(literal)) return;
  for (const property of literal.properties) {
    if (nameText(property.name)?.toLowerCase() !== 'location') continue;
    if (ts.isPropertyAssignment(property)) return property.initializer;
    if (ts.isShorthandPropertyAssignment(property)) return property.name;
  }
}

// The redirect target of a call, or undefined when the call is not a redirect.
function targetOf(call, context) {
  const callee = strip(call.expression);
  if (ts.isIdentifier(callee)) {
    const binding = importedFrom(callee, context.checker);
    return binding && redirectModules.has(binding.module) && binding.exported === 'redirect'
      ? call.arguments[0]
      : undefined;
  }
  if (!ts.isPropertyAccessExpression(callee)) return;
  const method = callee.name.text;
  const receiver = strip(callee.expression);
  if (method === 'redirect' && ts.isIdentifier(receiver)) {
    if (receiver.text === 'Response' && isGlobalIdentifier(receiver, context.checker)) return call.arguments[0];
    const binding = importedFrom(receiver, context.checker);
    if (binding?.module === 'next/server' && binding.exported === 'NextResponse') return call.arguments[0];
  }
  if (!isResponseReceiver(receiver)) return;
  if (method === 'redirect') return redirectTarget(call, context.checker);
  if (method === 'location') return call.arguments[0];
  if (headerSetters.has(method) && isLocationName(call.arguments[0])) return call.arguments[1];
  if (method === 'writeHead') return locationHeader(call.arguments.at(-1));
}

// A NestJS handler decorated with `@Redirect()` redirects to the `url` it returns.
function nestRedirectTarget(statement, context) {
  const value = statement.expression && strip(statement.expression);
  if (!value || !ts.isObjectLiteralExpression(value)) return;
  const method = ts.findAncestor(statement, ts.isFunctionLike);
  if (!method || !ts.isMethodDeclaration(method)) return;
  const decorated = (ts.getDecorators(method) ?? []).some((decorator) => {
    const call = decorator.expression;
    if (!ts.isCallExpression(call) || !ts.isIdentifier(call.expression)) return false;
    const binding = importedFrom(call.expression, context.checker);
    return binding?.module === '@nestjs/common' && binding.exported === 'Redirect';
  });
  return decorated ? propertyValue(value, 'url') : undefined;
}

// A path that starts with one `/` and a literal character that is not `/` or `\` cannot leave the site.
const fixedPathStart = /^\/[^/\\]/;
const leadingSlashStrip = /^\^(?:\\\/|\[\\?\/\\\\\])\+/;
const dependencyPath = /[\\/]node_modules[\\/]/;

function stripsLeadingSlashes(node) {
  const call = strip(node);
  if (!ts.isCallExpression(call) || !ts.isPropertyAccessExpression(call.expression)) return false;
  if (call.expression.name.text !== 'replace' && call.expression.name.text !== 'replaceAll') return false;
  const pattern = call.arguments[0] && strip(call.arguments[0]);
  return pattern?.kind === ts.SyntaxKind.RegularExpressionLiteral && leadingSlashStrip.test(pattern.text.slice(1));
}

// Whether the expression always starts with a fixed single `/` path segment, or `'/' + x.replace(/^\/+/, '')`.
function startsWithFixedPath(node) {
  const value = strip(node);
  if (ts.isStringLiteralLike(value)) return fixedPathStart.test(value.text);
  if (ts.isTemplateExpression(value)) return fixedPathStart.test(value.head.text);
  if (!ts.isBinaryExpression(value) || value.operatorToken.kind !== ts.SyntaxKind.PlusToken) return false;
  const left = strip(value.left);
  const isBareSlash = ts.isStringLiteralLike(left) && left.text === '/';
  return startsWithFixedPath(left) || (isBareSlash && stripsLeadingSlashes(value.right));
}

function returnedExpressions(declaration) {
  if (!declaration.body) return [];
  if (!ts.isBlock(declaration.body)) return [declaration.body];
  const found = [];
  (function visit(node) {
    if (ts.isReturnStatement(node)) found.push(node.expression);
    if (!ts.isFunctionLike(node)) ts.forEachChild(node, visit);
  })(declaration.body);
  return found;
}

// `res.redirect(formatPath(next))`: a same-project helper whose every return is a fixed-prefix path (one hop).
function isFixedPathHelperCall(target, context) {
  const call = strip(target);
  if (!ts.isCallExpression(call)) return false;
  const declaration = context.checker.getResolvedSignature(call)?.declaration;
  if (!declaration || !ts.isFunctionLike(declaration)) return false;
  const file = declaration.getSourceFile();
  if (file.isDeclarationFile || dependencyPath.test(file.fileName)) return false;
  const returned = returnedExpressions(declaration);
  return returned.length > 0 && returned.every((expression) => expression && startsWithFixedPath(expression));
}

function reportTarget(node, target, context) {
  if (isFixedPathHelperCall(target, context)) return;
  const control = context.taint.urlControl(target);
  if (!control || (control.part === 'path' && !control.rawPathname)) return;
  const { trace } = control;
  // The victim's browser sends its own Host header, so a host taken from it cannot point elsewhere.
  if (isHostHeader(trace)) return;
  if (isRelativeRedirect(node, target, context) || isProjectValidated(node, target, validatedKinds, context)) return;
  const reason = hopReason(trace) ?? (refererLabel.test(trace.label) ? refererReason : undefined);
  context.report(node, ruleId, message(trace.label), reason, { taint: trace });
}

function checkRedirectCall(call, context) {
  const target = targetOf(call, context);
  if (target) reportTarget(call, target, context);
}

function checkNestRedirect(statement, context) {
  const target = nestRedirectTarget(statement, context);
  if (target) reportTarget(statement, target, context);
}

module.exports = { ruleId, checkRedirectCall, checkNestRedirect };
