'use strict';

// open-redirect: a response redirect whose target site a link can choose.
const { syntax: ts } = require('../../performance/compiler.cjs');
const { importedFrom } = require('../bindings.cjs');
const {
  strip,
  propertyValue,
  isResponseReceiver,
  isGlobalIdentifier,
  hopReason,
  hasValidationEvidence,
  isHostHeader,
} = require('./shared.cjs');
const { createUrlControl } = require('./url-control.cjs');

const ruleId = 'open-redirect';
const message = (label) =>
  `The redirect target comes from \`${label}\`, so a link to this endpoint can send users to any site. Accept only relative paths (\`/\` but not \`//\`) or hosts from an allowlist.`;
const refererReason =
  "The target is the Referer header, which the user's own browser sets; confirm no page lets others choose it.";
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
  if (method === 'writeHead')
    for (const argument of call.arguments.slice(1))
      for (const name of ['Location', 'location']) {
        const value = propertyValue(argument, name);
        if (value) return value;
      }
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

function reportTarget(node, target, context) {
  const control = createUrlControl(context)(target);
  if (!control || control.part === 'path') return;
  const { trace } = control;
  // The victim's browser sends its own Host header, so a host taken from it cannot point elsewhere.
  if (isHostHeader(trace)) return;
  const isTainted = (expression) => Boolean(context.taint.trace(expression, 'redirect'));
  if (hasValidationEvidence(node, target, isTainted, context.checker)) return;
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
