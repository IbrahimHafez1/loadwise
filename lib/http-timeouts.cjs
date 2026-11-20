'use strict';

const { syntax: ts } = require('./compiler.cjs');

const rule = 'http-call-without-timeout';
const axiosMethods = {
  get: { optionsIndex: 1 },
  delete: { optionsIndex: 1 },
  head: { optionsIndex: 1 },
  options: { optionsIndex: 1 },
  request: { optionsIndex: 0 },
  post: { optionsIndex: 2 },
  put: { optionsIndex: 2 },
  patch: { optionsIndex: 2 },
};
const clientExtensions = /\.[jt]sx$/i;
const testFile = /(?:\/(?:__tests__|e2e)\/|\.(?:test|spec|e2e|e2e-spec|itest|e2e-test)\.[cm]?[jt]sx?$)/;
const libraryFile = /(?:\/node_modules\/|\/lib\.[\w.]*\.d\.ts$)/;

function skipParentheses(node) {
  let current = node;
  while (ts.isParenthesizedExpression(current)) current = current.expression;
  return current;
}

// Syntactic shape of a call this rule cares about: which argument holds the options and which keys count as a limit.
function describeCall(call) {
  const callee = call.expression;
  if (ts.isIdentifier(callee) && callee.text === 'fetch') {
    return { library: 'fetch', receiver: callee, optionsIndex: 1, limitKeys: ['signal'], limitProperty: 'signal' };
  }
  if (ts.isIdentifier(callee) && callee.text === 'axios') {
    const [first] = call.arguments;
    const optionsIndex = first && ts.isObjectLiteralExpression(skipParentheses(first)) ? 0 : 1;
    return {
      library: 'axios',
      receiver: callee,
      optionsIndex,
      limitKeys: ['timeout', 'signal'],
      limitProperty: 'timeout',
    };
  }
  if (
    ts.isPropertyAccessExpression(callee) &&
    ts.isIdentifier(callee.expression) &&
    callee.expression.text === 'axios' &&
    Object.hasOwn(axiosMethods, callee.name.text)
  ) {
    return {
      library: 'axios',
      receiver: callee.expression,
      optionsIndex: axiosMethods[callee.name.text].optionsIndex,
      limitKeys: ['timeout', 'signal'],
      limitProperty: 'timeout',
    };
  }
}

function hasUseClientDirective(sourceFile) {
  for (const statement of sourceFile.statements) {
    if (!ts.isExpressionStatement(statement) || !ts.isStringLiteral(statement.expression)) return false;
    if (statement.expression.text === 'use client') return true;
  }
  return false;
}

// Browser code and test files talk to their own servers; a missing timeout there is not a server hazard.
function isClientFile(sourceFile) {
  return (
    clientExtensions.test(sourceFile.fileName) ||
    testFile.test(sourceFile.fileName.replaceAll('\\', '/')) ||
    hasUseClientDirective(sourceFile)
  );
}

// The global fetch (lib.dom / undici types), not a function the project named `fetch`.
function isGlobalFetch(callee, context) {
  const symbol = context.checker.getSymbolAtLocation(callee);
  const declarations = symbol?.declarations;
  if (!declarations?.length) return true;
  return declarations.every((declaration) =>
    libraryFile.test(declaration.getSourceFile().fileName.replaceAll('\\', '/')),
  );
}

function isDefaultAxios(receiver, context) {
  return context.isPackageType(receiver, ['axios'], ['AxiosStatic']);
}

function isRequestObject(argument, context) {
  return context.checker.getTypeAtLocation(argument).getSymbol()?.name === 'Request';
}

function propertyName(property) {
  if (!property.name) return;
  if (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) return property.name.text;
}

// True when the options literal is known to lack every limit key. Spreads and computed keys make that unknowable.
function literalLacksLimit(literal, limitKeys) {
  return literal.properties.every((property) => {
    if (ts.isSpreadAssignment(property)) return false;
    if (property.name && ts.isComputedPropertyName(property.name)) return false;
    return !limitKeys.includes(propertyName(property));
  });
}

function check(node, context) {
  const target = describeCall(node);
  if (!target) return;
  const sourceFile = node.getSourceFile();
  if (node.arguments.length === 0 || node.arguments.some(ts.isSpreadElement) || isClientFile(sourceFile)) return;
  if (target.library === 'fetch') {
    if (!isGlobalFetch(target.receiver, context) || isRequestObject(node.arguments[0], context)) return;
  } else if (!isDefaultAxios(target.receiver, context) || sourceFile.text.includes('defaults.timeout')) {
    return;
  }
  const options = node.arguments[target.optionsIndex];
  if (options) {
    const literal = skipParentheses(options);
    if (!ts.isObjectLiteralExpression(literal) || !literalLacksLimit(literal, target.limitKeys)) return;
  }
  context.report(node, rule, message(target));
}

function isAwsSdkClient(node, context) {
  const declaration = context.checker.getResolvedSignature(node)?.declaration;
  const filename = declaration?.getSourceFile().fileName.replaceAll('\\', '/');
  return !!filename && filename.includes('/node_modules/@aws-sdk/client-');
}

// AWS SDK v3 clients default to no request or connection timeout, so a hung endpoint holds the caller.
function checkAwsClient(node, context) {
  const callee = node.expression;
  const name = ts.isIdentifier(callee) ? callee : ts.isPropertyAccessExpression(callee) ? callee.name : undefined;
  if (!name?.text.endsWith('Client') || isClientFile(node.getSourceFile())) return;
  const [config] = node.arguments ?? [];
  if (config) {
    const literal = skipParentheses(config);
    if (!ts.isObjectLiteralExpression(literal) || !literalLacksLimit(literal, ['requestHandler'])) return;
  }
  if (!isAwsSdkClient(node, context)) return;
  context.report(
    node,
    rule,
    `\`new ${name.text}()\` has no \`requestHandler\` timeouts, and AWS SDK v3 waits indefinitely by default, so a slow or hung endpoint holds every request that calls it and can exhaust the server's sockets. ` +
      'Pass `requestHandler: { requestTimeout: 30_000, connectionTimeout: 5_000 }` (pick limits that fit the largest expected transfer).',
  );
}

function message(target) {
  if (target.library === 'fetch') {
    return (
      '`fetch()` has no timeout, so a slow or hung upstream holds this request (and its socket) until the OS gives up, ' +
      'and a few stuck upstream calls can exhaust the server. Pass `signal: AbortSignal.timeout(10_000)` ' +
      '(pick a limit that fits this API) and handle the resulting `TimeoutError`. Skip it only for streams that are meant to stay open.'
    );
  }
  return (
    '`axios` call has no timeout (axios waits forever by default), so a slow or hung upstream holds this request ' +
    '(and its socket) until the OS gives up, and a few stuck calls can exhaust the server. Pass `timeout: 10_000` ' +
    '(pick a limit that fits this API) or set it once with `axios.create({ timeout })`. Skip it only for long-lived streams.'
  );
}

module.exports = { check, checkAwsClient, describeCall, skipParentheses };
