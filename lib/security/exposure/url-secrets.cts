// secret-in-url-query: a credential is read from, or sent in, a URL query string.
import { loadSyntax } from '../../performance/compiler.cjs';
import { enclosingRequestHandler } from '../../performance/request-handlers.cjs';
import { unwrap, nameText, methodName, objectLiteralOf, findProperty } from './literals.cjs';
import type { CallExpression, Expression, Node, PropertyAccessExpression } from 'typescript';
import type { CheckerAdapter, SecurityRuleContext } from '../../shared/types.cjs';
const ts = loadSyntax();

const ruleId = 'secret-in-url-query';
const message =
  'A credential is passed in a URL query string, so it ends up in access logs, browser history and the Referer header. Send it in a header or the request body.';
const linkTokenReason =
  'Single-use link tokens (reset, verify, invite, unsubscribe) are normally carried in the URL. Confirm this is not a long-lived credential.';
const thirdPartyReason =
  'Some third-party APIs (for example Google Maps) only accept their key in the query string. Restrict the key to your domain or IP.';
// Compared after lower-casing and dropping `_` and `-`, so `api_key`, `apiKey` and `api-key` match
// alike.
const credentialNames = new Set([
  'password',
  'passwd',
  'pwd',
  'secret',
  'clientsecret',
  'apikey',
  'accesstoken',
  'authtoken',
  'token',
]);
const linkTokenHandlerPattern = /reset|verif|confirm|invit|unsubscribe|activat|magic|redeem/i;
const requestFunctions = new Set([
  'fetch',
  'axios',
  'got',
  'ky',
  'get',
  'post',
  'put',
  'patch',
  'delete',
  'head',
  'request',
]);
const thirdPartyHostPattern = /googleapis\.com|maps\.google|mapbox\.com|openweathermap\.org/i;
const queryNamePattern = /[?&]([\w-]+)=$/;
const searchParamsReaders = new Set(['get', 'getAll']);

function normalize(name: string) {
  return name.toLowerCase().replaceAll(/[_-]/g, '');
}

function isCredentialName(name: string) {
  return credentialNames.has(normalize(name));
}

// The handler's name, decorators and route path: the words that say what a `token` parameter is
// for.
function handlerPurposeText(handler: Node) {
  const parts = [(ts.isFunctionLike(handler) ? handler.name?.getText() : undefined) ?? ''];
  if (ts.isMethodDeclaration(handler)) for (const modifier of handler.modifiers ?? []) parts.push(modifier.getText());
  const route = ts.isCallExpression(handler.parent) ? handler.parent.arguments[0] : undefined;
  if (route && ts.isStringLiteralLike(route)) parts.push(route.text);
  return parts.join(' ');
}

function incomingReason(handler: Node, credentialName: string) {
  if (normalize(credentialName) !== 'token') return;
  return linkTokenHandlerPattern.test(handlerPurposeText(handler)) ? linkTokenReason : undefined;
}

function reportIncoming(node: Node, credentialName: string, context: SecurityRuleContext) {
  const handler = enclosingRequestHandler(node);
  if (!isCredentialName(credentialName) || !handler) return;
  context.report(node, ruleId, message, incomingReason(handler, credentialName));
}

// `req.query.password`
function checkPropertyAccess(node: PropertyAccessExpression, context: SecurityRuleContext) {
  const receiver = unwrap(node.expression);
  if (!ts.isPropertyAccessExpression(receiver) || receiver.name.text !== 'query') return;
  reportIncoming(node, node.name.text, context);
}

// `@Query('password') password: string` on a controller parameter.
function checkQueryDecorator(call: CallExpression, context: SecurityRuleContext) {
  const callee = unwrap(call.expression);
  const [name] = call.arguments;
  if (!ts.isIdentifier(callee) || callee.text !== 'Query' || !name || !ts.isStringLiteralLike(name)) return;
  const decorator = call.parent;
  if (!ts.isDecorator(decorator) || !ts.isParameter(decorator.parent)) return;
  reportIncoming(call, name.text, context);
}

// `url.searchParams.get('token')` inside a request handler.
function checkSearchParamsRead(call: CallExpression, context: SecurityRuleContext) {
  const callee = unwrap(call.expression);
  const [name] = call.arguments;
  if (!ts.isPropertyAccessExpression(callee) || !searchParamsReaders.has(callee.name.text)) return;
  if (!name || !ts.isStringLiteralLike(name)) return;
  const receiver = unwrap(callee.expression);
  const receiverName = ts.isPropertyAccessExpression(receiver) ? receiver.name.text : receiver.getText();
  if (receiverName === 'searchParams') reportIncoming(call, name.text, context);
}

function isLiteralValue(expression: Expression) {
  const node = unwrap(expression);
  return ts.isStringLiteralLike(node) || ts.isNumericLiteral(node);
}

// The URL as alternating pieces: literal text, then an expression, so `?token=${x}` and `'?token='
// + x` read alike.
interface TextPiece {
  text: string;
  value?: undefined;
}

interface ValuePiece {
  value: Expression;
  text?: undefined;
}

type UrlPiece = TextPiece | ValuePiece;

function urlPieces(expression: Expression): UrlPiece[] {
  const node = unwrap(expression);
  if (ts.isTemplateExpression(node)) {
    const pieces: UrlPiece[] = [{ text: node.head.text }];
    for (const span of node.templateSpans) pieces.push({ value: span.expression }, { text: span.literal.text });
    return pieces;
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken)
    return [...urlPieces(node.left), ...urlPieces(node.right)];
  return ts.isStringLiteralLike(node) ? [{ text: node.text }] : [{ value: node }];
}

// True when a non-literal value follows `?name=` or `&name=` for a credential name in the URL text.
function hasCredentialInUrl(urlExpression: Expression) {
  let precedingText = '';
  for (const piece of urlPieces(urlExpression)) {
    if (piece.text !== undefined) {
      precedingText += piece.text;
      continue;
    }
    const name = queryNamePattern.exec(precedingText)?.[1];
    if (name && !isLiteralValue(piece.value) && isCredentialName(name)) return true;
    precedingText += ' ';
  }
  return false;
}

function hasCredentialInParams(optionsExpression: Expression, checker: CheckerAdapter) {
  const options = objectLiteralOf(optionsExpression, checker);
  const params = options && objectLiteralOf(findProperty(options, 'params')?.value, checker);
  if (!params) return false;
  return params.properties.some((property) => {
    if (!ts.isPropertyAssignment(property)) return false;
    const name = nameText(property.name);
    return !!name && isCredentialName(name) && !isLiteralValue(property.initializer);
  });
}

function isRequestCall(call: CallExpression) {
  const callee = unwrap(call.expression);
  const name = ts.isIdentifier(callee) ? callee.text : methodName(call);
  return name !== undefined && requestFunctions.has(name);
}

// `fetch(`${base}?api_key=${key}`)`, `axios.get(url, { params: { api_key: key } })`.
function checkOutgoingRequest(call: CallExpression, context: SecurityRuleContext) {
  if (!isRequestCall(call)) return;
  const [target, options] = call.arguments;
  if (!target) return;
  if (!hasCredentialInUrl(target) && !hasCredentialInParams(options ?? target, context.checker)) return;
  const thirdParty = thirdPartyHostPattern.test(call.getText());
  context.report(call, ruleId, message, thirdParty ? thirdPartyReason : undefined);
}

function checkCall(call: CallExpression, context: SecurityRuleContext) {
  checkQueryDecorator(call, context);
  checkSearchParamsRead(call, context);
  checkOutgoingRequest(call, context);
}

export { checkCall, checkPropertyAccess };
