'use strict';

// Three correctness rules about outside data and streams that fail at runtime: `.pipe()` without error handling,
// `JSON.parse` of outside input outside a try block, and request numbers used with no NaN or range check.
const fs = require('node:fs');
const path = require('node:path');
const { syntax: ts } = require('./compiler.cjs');
const { calleeName } = require('./call-syntax.cjs');
const { enclosingRequestHandler, isFastifyHandler, parameterName } = require('./request-handlers.cjs');
const { traceInputs, requestInputOf, chainRoot } = require('./request-inputs.cjs');
const { isTestSource, isToolingSource } = require('./review-context.cjs');

const PIPE_RULE = 'stream-pipe-unhandled-error';
const PARSE_RULE = 'json-parse-unguarded';
const NUMBER_RULE = 'request-number-unvalidated';

const PIPE_MESSAGE =
  '`.pipe()` does not forward errors: if the source or destination stream errors and nothing listens for `error`, the process crashes or the file descriptor and socket leak. Use `await pipeline(source, ...destinations)` from `node:stream/promises`, or attach an `error` handler to every stream.';
const PARSE_MESSAGE =
  '`JSON.parse` throws on malformed input, and this value comes from outside the process with no try/catch around the parse. Wrap the parse in try/catch and answer or skip the bad input, or validate it with a schema parser that returns an error instead of throwing.';
const NUMBER_MESSAGE =
  'This number is parsed from request input and used without a check, so `abc` becomes `NaN` and a huge or negative value passes straight through to the query or calculation. Check `Number.isFinite` (or `Number.isInteger`) and the allowed range before using it, or validate the input with a schema.';

const STREAM_FACTORY =
  /^(?:create\w*Stream|createGzip|createGunzip|createDeflate|createInflate|createDeflateRaw|createInflateRaw|createUnzip|createBrotliCompress|createBrotliDecompress|createCipheriv|createDecipheriv|createHash|createHmac)$/;
const STREAM_NAME = /stream$|^(?:readable|writable|duplex|transform|gzip|gunzip|upstream)$/i;
const REQUEST_STREAM_NAME = /^(?:req|request|res|response|reply)$/;
const ERROR_LISTENER_METHODS = new Set(['on', 'once', 'addListener', 'prependListener']);
const COMPLETION_HELPERS = new Set(['pipeline', 'finished', 'eos', 'pump', 'endOfStream']);
const RXJS_MODULE = /^rxjs(?:\/|$)/;
const OBSERVABLE_TYPES = /^(?:Observable|Subject|BehaviorSubject|ReplaySubject|AsyncSubject|ConnectableObservable)$/;
const NODE_TYPES_PACKAGES = ['@types/node'];

const REQUEST_MEMBERS = new Set(['body', 'query', 'params', 'headers', 'cookies', 'signedCookies']);
const REQUEST_DECORATORS = new Set(['Body', 'Query', 'Param', 'Headers']);
const REQUEST_OBJECT = /^req(?:uest)?$/;
const MESSAGE_ROOT = /msg|message|event|record|job|payload|delivery|envelope/i;
const MESSAGE_MEMBERS = new Set(['data', 'value', 'content', 'body']);
const READ_FILE = /^readFile(?:Sync)?$/;
const BROWSER_STORAGE = new Set(['localStorage', 'sessionStorage']);
const STRING_CONVERSIONS = new Set(['toString', 'trim', 'String']);
const MAX_ALIAS_DEPTH = 3;

const NUMBER_PARSERS = new Set(['Number', 'parseInt', 'parseFloat', 'Number.parseInt', 'Number.parseFloat']);
const NUMBER_CHECKS = new Set([
  'isNaN',
  'isFinite',
  'Number.isNaN',
  'Number.isFinite',
  'Number.isInteger',
  'Number.isSafeInteger',
  'Math.min',
  'Math.max',
]);
const CLAMP_CALL = /clamp/i;
const SINK_METHODS = new Set(['slice', 'splice', 'limit', 'skip', 'take', 'offset', 'at', 'repeat', 'fill']);
const SINK_PROPERTIES = new Set(['limit', 'skip', 'take', 'offset', 'first', 'last', 'top', 'perPage', 'pageSize']);
const QUERY_METHODS =
  /^(?:find\w*|query|execute|raw|where\w*|update\w*|delete\w*|destroy|count|aggregate|paginate|get(?:By\w*)?|select\w*|insert\w*|upsert|create\w*)$/;
const COMPARISONS = new Set([
  ts.SyntaxKind.LessThanToken,
  ts.SyntaxKind.LessThanEqualsToken,
  ts.SyntaxKind.GreaterThanToken,
  ts.SyntaxKind.GreaterThanEqualsToken,
]);
const ARITHMETIC = new Set([
  ts.SyntaxKind.PlusToken,
  ts.SyntaxKind.MinusToken,
  ts.SyntaxKind.AsteriskToken,
  ts.SyntaxKind.SlashToken,
  ts.SyntaxKind.PercentToken,
  ts.SyntaxKind.AsteriskAsteriskToken,
]);

function enclosingFunction(node) {
  return ts.findAncestor(node.parent, ts.isFunctionLike);
}

function functionBody(node) {
  return enclosingFunction(node)?.body ?? node.getSourceFile();
}

function forEachInScope(scope, visit) {
  (function walk(node) {
    visit(node);
    ts.forEachChild(node, walk);
  })(scope);
}

function isMethodCall(node, names) {
  return (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    (typeof names === 'string' ? node.expression.name.text === names : names.has(node.expression.name.text))
  );
}

function importsModule(sourceFile, pattern) {
  return [...sourceFile.text.matchAll(/(?:from\s+|require\(\s*)['"]([^'"]+)['"]/g)].some((match) =>
    pattern.test(match[1]),
  );
}

function typeSymbolName(node, context) {
  try {
    return context.checker.getTypeAtLocation(node)?.getSymbol()?.name;
  } catch {
    return undefined;
  }
}

function isNodeType(node, context) {
  try {
    return context.isPackageType(node, NODE_TYPES_PACKAGES);
  } catch {
    return false;
  }
}

// The value a local `const` was initialised with, so `const file = fs.createReadStream(p); file.pipe(res)` resolves.
function localInitializer(identifier) {
  const scope = functionBody(identifier);
  let found;
  forEachInScope(scope, (node) => {
    if (found || !ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name)) return;
    if (node.name.text === identifier.text && node.initializer) found = node.initializer;
  });
  return found && ts.skipOuterExpressions(found);
}

// ---- stream-pipe-unhandled-error ----

function pipeStages(call) {
  const stages = [];
  let current = call;
  while (isMethodCall(current, 'pipe')) {
    stages.unshift(current.arguments[0]);
    current = ts.skipOuterExpressions(current.expression.expression);
  }
  return { source: current, stages };
}

function isStreamFactoryCall(node) {
  const value = ts.skipOuterExpressions(node);
  return ts.isCallExpression(value) && STREAM_FACTORY.test(calleeName(value) ?? '');
}

function isRequestStream(node) {
  const value = ts.skipOuterExpressions(node);
  if (!ts.isIdentifier(value) || !REQUEST_STREAM_NAME.test(value.text)) return false;
  const owner = enclosingFunction(value);
  return !!owner?.parameters.some((parameter) => parameterName(parameter) === value.text);
}

// 'clear' when the code shows a Node stream, 'name' when only its name suggests one.
function streamEvidence(node, context) {
  const value = ts.skipOuterExpressions(node);
  if (isStreamFactoryCall(value) || isRequestStream(value) || isNodeType(value, context)) return 'clear';
  if (ts.isIdentifier(value)) {
    const initializer = localInitializer(value);
    if (initializer && (isStreamFactoryCall(initializer) || isMethodCall(initializer, 'pipe'))) return 'clear';
    if (STREAM_NAME.test(value.text)) return 'name';
  }
  if (ts.isPropertyAccessExpression(value) && STREAM_NAME.test(value.name.text)) return 'name';
}

function looksLikeOperatorPipe(call, context) {
  if (importsModule(call.getSourceFile(), RXJS_MODULE)) return true;
  const receiver = call.expression.expression;
  if (OBSERVABLE_TYPES.test(typeSymbolName(receiver, context) ?? '')) return true;
  if (call.arguments.length !== 1) return true;
  const [argument] = call.arguments;
  const value = ts.skipOuterExpressions(argument);
  if (ts.isArrowFunction(value) || ts.isFunctionExpression(value)) return true;
  // `obs.pipe(map(...))`: operators are plain function calls; stream factories are the exception.
  return ts.isCallExpression(value) && ts.isIdentifier(value.expression) && !isStreamFactoryCall(value);
}

function streamNames(nodes) {
  const names = new Set();
  for (const node of nodes) {
    const root = chainRoot(node);
    if (ts.isIdentifier(root)) names.add(root.text);
  }
  return names;
}

function isErrorListener(call) {
  if (!isMethodCall(call, ERROR_LISTENER_METHODS)) return false;
  const [event] = call.arguments;
  return !!event && ts.isStringLiteralLike(event) && event.text === 'error';
}

function hasErrorHandling(call, source, stages) {
  // `src.on('error', h).pipe(dst)` or `src.pipe(dst).on('error', h)`.
  for (let node = source; ts.isCallExpression(node) || ts.isPropertyAccessExpression(node);) {
    if (ts.isCallExpression(node) && isErrorListener(node)) return true;
    node = ts.skipOuterExpressions(node.expression);
    if (ts.isPropertyAccessExpression(node)) node = ts.skipOuterExpressions(node.expression);
  }
  const chained = call.parent;
  if (ts.isPropertyAccessExpression(chained) && ts.isCallExpression(chained.parent) && isErrorListener(chained.parent))
    return true;
  const names = streamNames([source, ...stages]);
  const declared = ts.isVariableDeclaration(call.parent) && ts.isIdentifier(call.parent.name);
  if (declared) names.add(call.parent.name.text);
  let handled = false;
  forEachInScope(functionBody(call), (node) => {
    if (handled || !ts.isCallExpression(node)) return;
    if (COMPLETION_HELPERS.has(calleeName(node) ?? '')) handled = true;
    else if (isErrorListener(node)) {
      const root = chainRoot(node.expression.expression);
      handled = ts.isIdentifier(root) && names.has(root.text);
    }
  });
  return handled;
}

function checkPipe(node, context) {
  if (!isMethodCall(node, 'pipe')) return;
  // Report the whole chain once, at its outermost `.pipe()`.
  const parent = node.parent;
  if (ts.isPropertyAccessExpression(parent) && parent.name.text === 'pipe' && ts.isCallExpression(parent.parent))
    return;
  if (looksLikeOperatorPipe(node, context)) return;
  const { source, stages } = pipeStages(node);
  if (stages.some((stage) => !stage)) return;
  const evidence = [source, ...stages].map((stream) => streamEvidence(stream, context));
  if (!evidence.some(Boolean)) return;
  if (hasErrorHandling(node, source, stages)) return;
  const reason = evidence.includes('clear')
    ? undefined
    : 'Only the names suggest these are Node streams; skip this if `.pipe()` belongs to another library.';
  context.report(node, PIPE_RULE, PIPE_MESSAGE, reason);
}

// ---- json-parse-unguarded ----

function isInsideTry(node) {
  for (let child = node, parent = node.parent; parent; child = parent, parent = parent.parent) {
    if (ts.isFunctionLike(parent)) return false;
    if (ts.isTryStatement(parent) && parent.catchClause && child === parent.tryBlock) return true;
  }
  return false;
}

function isExported(declaration) {
  return !!declaration.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
}

// A private helper whose every call sits inside try/catch in the same file: the parse cannot escape unhandled, and
// the helper is usually the one place that opens the file. A shorthand export or any other reference counts as an
// unguarded caller.
function isGuardedByEveryCaller(node) {
  const helper = enclosingFunction(node);
  if (!helper || !ts.isFunctionDeclaration(helper) || !helper.name || isExported(helper)) return false;
  let callerCount = 0;
  let allGuarded = true;
  forEachInScope(node.getSourceFile(), (candidate) => {
    if (!ts.isIdentifier(candidate) || candidate.text !== helper.name.text || candidate === helper.name) return;
    let call = candidate.parent;
    if (!ts.isCallExpression(call) || call.expression !== candidate) {
      allGuarded = false;
      return;
    }
    callerCount += 1;
    while (ts.isAwaitExpression(call.parent) || ts.isParenthesizedExpression(call.parent)) call = call.parent;
    if (!isInsideTry(call)) allGuarded = false;
  });
  return callerCount > 0 && allGuarded;
}

function hasRequestDecorator(parameter) {
  return !!parameter.modifiers?.some(
    (modifier) =>
      ts.isDecorator(modifier) &&
      ts.isCallExpression(modifier.expression) &&
      ts.isIdentifier(modifier.expression.expression) &&
      REQUEST_DECORATORS.has(modifier.expression.expression.text),
  );
}

function declaringParameter(identifier) {
  for (let scope = enclosingFunction(identifier); scope; scope = enclosingFunction(scope)) {
    const parameter = scope.parameters.find((item) => parameterName(item) === identifier.text);
    if (parameter) return parameter;
  }
}

function firstMember(access) {
  let current = access;
  while (ts.isPropertyAccessExpression(current.expression) || ts.isElementAccessExpression(current.expression))
    current = current.expression;
  if (ts.isPropertyAccessExpression(current)) return current.name.text;
}

function isRequestRead(value) {
  const root = chainRoot(value);
  if (!ts.isIdentifier(root)) return false;
  const parameter = declaringParameter(root);
  if (!parameter) return false;
  if (hasRequestDecorator(parameter)) return true;
  const isMember = ts.isPropertyAccessExpression(value) || ts.isElementAccessExpression(value);
  return isMember && REQUEST_OBJECT.test(root.text) && REQUEST_MEMBERS.has(firstMember(value));
}

function isMessagePayload(value) {
  if (!ts.isPropertyAccessExpression(value) || !MESSAGE_MEMBERS.has(value.name.text)) return false;
  const root = chainRoot(value);
  return ts.isIdentifier(root) && MESSAGE_ROOT.test(root.text);
}

function isOutsideCall(call) {
  const callee = ts.skipOuterExpressions(call.expression);
  const name = calleeName(call) ?? '';
  if (READ_FILE.test(name)) return true;
  if (!ts.isPropertyAccessExpression(callee)) return false;
  const receiver = ts.skipOuterExpressions(callee.expression);
  if (name === 'getItem') return ts.isIdentifier(receiver) && BROWSER_STORAGE.has(receiver.text);
  // `await response.text()` on a fetch Response.
  return name === 'text' && call.arguments.length === 0 && ts.isAwaitExpression(call.parent);
}

// A file the tool ships next to its own code, such as `path.join(path.resolve(__dirname, '..'), 'package.json')`,
// is not outside input: it is as trustworthy as the code that reads it. Every other path part must be a literal, so
// `path.join(__dirname, 'uploads', name)` still counts as outside input.
function isBundledPath(node, depth = 0) {
  const value = ts.skipOuterExpressions(node);
  if (ts.isIdentifier(value)) {
    if (value.text === '__dirname') return true;
    const initializer = depth < MAX_ALIAS_DEPTH ? localInitializer(value) : undefined;
    return !!initializer && isBundledPath(initializer, depth + 1);
  }
  if (!ts.isCallExpression(value)) return false;
  const parts = value.arguments;
  return (
    parts.some((part) => isBundledPath(part, depth)) &&
    parts.every((part) => ts.isStringLiteralLike(part) || isBundledPath(part, depth))
  );
}

function isEnvRead(value) {
  const text = value.getText();
  return /^process\.env(?:\.|\[)/.test(text);
}

// Which kind of outside input `value` is, following string conversions and local aliases.
function outsideInput(node, depth = 0) {
  const value = ts.skipOuterExpressions(node);
  if (ts.isAwaitExpression(value)) return outsideInput(value.expression, depth);
  if (ts.isBinaryExpression(value) && value.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)
    return outsideInput(value.left, depth);
  if (ts.isCallExpression(value)) {
    const name = calleeName(value);
    if (STRING_CONVERSIONS.has(name)) {
      const inner = ts.isPropertyAccessExpression(value.expression) ? value.expression.expression : value.arguments[0];
      return inner && outsideInput(inner, depth);
    }
    if (READ_FILE.test(name) && value.arguments[0] && isBundledPath(value.arguments[0])) return undefined;
    return isOutsideCall(value) ? (READ_FILE.test(name) ? 'file' : 'call') : undefined;
  }
  if (isEnvRead(value)) return 'env';
  if (isRequestRead(value)) return 'request';
  if (isMessagePayload(value)) return 'message';
  if (ts.isIdentifier(value) && depth < MAX_ALIAS_DEPTH) {
    const initializer = localInitializer(value);
    return initializer && outsideInput(initializer, depth + 1);
  }
}

const packageJsonByDirectory = new Map();

function expressRange(directory) {
  if (packageJsonByDirectory.has(directory)) return packageJsonByDirectory.get(directory);
  let range;
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
    range = manifest.dependencies?.express ?? manifest.devDependencies?.express ?? null;
  } catch {
    const parent = path.dirname(directory);
    range = parent === directory ? null : expressRange(parent);
  }
  packageJsonByDirectory.set(directory, range);
  return range;
}

function usesExpress5(sourceFile) {
  const range = expressRange(path.dirname(path.resolve(sourceFile.fileName)));
  return typeof range === 'string' && /^\D*5/.test(range);
}

function isAsync(fn) {
  return !!fn.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword);
}

function parseContext(node, kind) {
  const handler = enclosingRequestHandler(node);
  if (handler) {
    if (ts.isMethodDeclaration(handler) || isFastifyHandler(handler))
      return 'The framework turns this throw into a 500 response, so the process survives; a 400 for bad input is still clearer.';
    if (usesExpress5(node.getSourceFile()))
      return 'Express 5 turns this throw into a 500 response, so the process survives; a 400 for bad input is still clearer.';
    if (!isAsync(handler))
      return 'Express catches a synchronous throw in a handler and answers 500; a 400 for bad input is still clearer.';
    return undefined;
  }
  if (!enclosingFunction(node) && (kind === 'file' || kind === 'env'))
    return 'This parse runs once at startup, where failing fast on a malformed file or variable may be intended.';
  if (isToolingSource(node.getSourceFile()))
    return 'This parse runs in operator tooling, where failing fast on a malformed file may be intended.';
}

function checkJsonParse(node, context) {
  if (!ts.isCallExpression(node) || node.arguments.length === 0) return;
  const callee = ts.skipOuterExpressions(node.expression);
  const isParse =
    ts.isPropertyAccessExpression(callee) &&
    callee.name.text === 'parse' &&
    ts.isIdentifier(callee.expression) &&
    callee.expression.text === 'JSON';
  if (!isParse || isInsideTry(node) || isTestSource(node.getSourceFile().fileName)) return;
  if (isGuardedByEveryCaller(node)) return;
  const kind = outsideInput(node.arguments[0]);
  if (!kind) return;
  context.report(node, PARSE_RULE, PARSE_MESSAGE, parseContext(node, kind));
}

// ---- request-number-unvalidated ----

function parsedInput(node) {
  if (ts.isCallExpression(node) && NUMBER_PARSERS.has(ts.skipOuterExpressions(node.expression).getText()))
    return node.arguments[0];
  const isUnaryPlus = ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.PlusToken;
  if (isUnaryPlus && !ts.isNumericLiteral(node.operand)) return node.operand;
}

// Nest `@Query('page', ParseIntPipe)` and DTO class parameters are validated before the handler runs.
function isValidatedParameter(parameter) {
  const hasPipe = parameter.modifiers?.some(
    (modifier) =>
      ts.isDecorator(modifier) && ts.isCallExpression(modifier.expression) && modifier.expression.arguments.length > 1,
  );
  return hasPipe || (!!parameter.type && ts.isTypeReferenceNode(parameter.type));
}

// Request reads that skipped validation: `@Query('page') page: string` counts, a DTO class parameter does not.
function rawRequestSource(handler) {
  const base = requestInputOf(handler);
  return (parameter, node) => {
    if (hasRequestDecorator(parameter)) return isValidatedParameter(parameter) ? undefined : {};
    return base(parameter, node);
  };
}

function isRawRequestNumber(input, handler) {
  const sources = traceInputs(input, handler, rawRequestSource(handler));
  return sources.length > 0 && sources.every((source) => !source.schema);
}

// Walks up from a use of the number through wrappers; true when it lands in a query, a size call, an index or
// arithmetic whose result is kept.
function reachesSink(use) {
  let child = use;
  for (let parent = use.parent; parent; child = parent, parent = parent.parent) {
    if (ts.isParenthesizedExpression(parent) || ts.isAsExpression(parent) || ts.isNonNullExpression(parent)) continue;
    if (ts.isElementAccessExpression(parent)) return parent.argumentExpression === child;
    if (ts.isBinaryExpression(parent)) {
      if (ARITHMETIC.has(parent.operatorToken.kind)) return !ts.isExpressionStatement(parent.parent);
      return false;
    }
    if (ts.isPropertyAssignment(parent) || ts.isShorthandPropertyAssignment(parent)) {
      if (ts.isIdentifier(parent.name) && SINK_PROPERTIES.has(parent.name.text)) return true;
      continue;
    }
    if (ts.isObjectLiteralExpression(parent) || ts.isArrayLiteralExpression(parent) || ts.isSpreadElement(parent))
      continue;
    if (ts.isCallExpression(parent)) {
      if (!parent.arguments.includes(child)) return false;
      const name = calleeName(parent) ?? '';
      return SINK_METHODS.has(name) || (ts.isPropertyAccessExpression(parent.expression) && QUERY_METHODS.test(name));
    }
    return false;
  }
  return false;
}

function isGuardOf(node, name) {
  const mentions = (expression) => {
    let found = false;
    forEachInScope(expression, (child) => {
      if (ts.isIdentifier(child) && child.text === name) found = true;
    });
    return found;
  };
  if (ts.isCallExpression(node)) {
    const text = ts.skipOuterExpressions(node.expression).getText();
    return (NUMBER_CHECKS.has(text) || CLAMP_CALL.test(text)) && node.arguments.some(mentions);
  }
  if (ts.isBinaryExpression(node)) {
    const kind = node.operatorToken.kind;
    const isAssignment = kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(node.left) && node.left.text === name;
    return isAssignment || (COMPARISONS.has(kind) && (mentions(node.left) || mentions(node.right)));
  }
  // `if (!page) ...` rejects NaN as well as 0.
  return (
    ts.isPrefixUnaryExpression(node) &&
    node.operator === ts.SyntaxKind.ExclamationToken &&
    ts.isIdentifier(node.operand) &&
    node.operand.text === name
  );
}

function namedResultReachesSink(declaration) {
  const name = declaration.name.text;
  const scope = functionBody(declaration);
  let firstSink;
  forEachInScope(scope, (node) => {
    const isUse = ts.isIdentifier(node) && node.text === name && node !== declaration.name;
    if (isUse && node.pos > declaration.end && reachesSink(node) && (!firstSink || node.pos < firstSink.pos))
      firstSink = node;
  });
  if (!firstSink) return false;
  let guarded = false;
  forEachInScope(scope, (node) => {
    if (!guarded && node.pos > declaration.end && node.pos < firstSink.pos && isGuardOf(node, name)) guarded = true;
  });
  return !guarded;
}

function checkRequestNumber(node, context) {
  const input = parsedInput(node);
  if (!input) return;
  const handler = enclosingRequestHandler(node);
  if (!handler || !isRawRequestNumber(input, handler)) return;
  let outer = node;
  while (ts.isParenthesizedExpression(outer.parent)) outer = outer.parent;
  const parent = outer.parent;
  // `Number(x) || 1` replaces NaN with the fallback.
  if (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.BarBarToken) return;
  const declared = ts.isVariableDeclaration(parent) && parent.initializer === outer && ts.isIdentifier(parent.name);
  const unchecked = declared ? namedResultReachesSink(parent) : reachesSink(outer);
  if (!unchecked) return;
  context.report(node, NUMBER_RULE, NUMBER_MESSAGE);
}

function check(node, context) {
  if (ts.isPrefixUnaryExpression(node)) return checkRequestNumber(node, context);
  if (!ts.isCallExpression(node)) return;
  checkPipe(node, context);
  checkJsonParse(node, context);
  checkRequestNumber(node, context);
}

module.exports = { check };
