// Three correctness rules about outside data and streams that fail at runtime: `.pipe()` without
// error handling,
// `JSON.parse` of outside input outside a try block, and request numbers used with no NaN or range
// check.
import { ts } from './compiler.js';
import { calleeName } from './call-syntax.js';
import { expressMajor, FIRST_EXPRESS_MAJOR_FORWARDING_REJECTIONS } from './async-errors.js';
import {
  enclosingRequestHandler,
  isFastifyHandler,
  isFunctionLikeDeclaration,
  parameterName,
} from './request-handlers.js';
import { traceInputs, requestInputOf, chainRoot } from './request-inputs.js';
import { createJsonParseContext } from './json-parse-context.js';
import { isTestSource, isToolingSource } from './review-context.js';
import type {
  BindingElement,
  CallExpression,
  ElementAccessExpression,
  Expression,
  FunctionDeclaration,
  FunctionLikeDeclaration,
  Identifier,
  Node,
  ParameterDeclaration,
  PrefixUnaryExpression,
  PropertyAccessExpression,
  SignatureDeclaration,
  SourceFile,
  VariableDeclaration,
} from 'typescript';
import type { PerformanceRuleContext } from '../shared/types.js';
import type { FunctionWithBody } from '../shared/types/function-summaries.js';
import type { MethodCall } from './types/method-call.js';
import type { RequestHandlerFunction } from './types/request-handler.js';
import type { InputSourceOf } from './types/request-input.js';

/**
 * What kind of outside data a value is: a file next to the code, a read file, a call, the
 * environment, a request or a message.
 */
type OutsideInputKind = 'local-file' | 'file' | 'call' | 'env' | 'request' | 'message';

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

function enclosingFunction(node: Node): SignatureDeclaration | undefined {
  return ts.findAncestor(node.parent, ts.isFunctionLike);
}

function functionBody(node: Node): Node {
  const owner = enclosingFunction(node);
  return (owner && isFunctionLikeDeclaration(owner) ? owner.body : undefined) ?? node.getSourceFile();
}

function forEachInScope(scope: Node, visit: (node: Node) => void): void {
  (function walk(node: Node): void {
    visit(node);
    ts.forEachChild(node, walk);
  })(scope);
}

function isMethodCall(node: Node, names: string | ReadonlySet<string>): node is MethodCall {
  return (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    (typeof names === 'string' ? node.expression.name.text === names : names.has(node.expression.name.text))
  );
}

function importsModule(sourceFile: SourceFile, pattern: RegExp): boolean {
  return [...sourceFile.text.matchAll(/(?:from\s+|require\(\s*)['"]([^'"]+)['"]/g)].some((match) =>
    pattern.test(match[1]),
  );
}

function typeSymbolName(node: Node, context: PerformanceRuleContext): string | undefined {
  try {
    return context.checker.getTypeAtLocation(node)?.getSymbol()?.name;
  } catch {
    return undefined;
  }
}

function isNodeType(node: Node, context: PerformanceRuleContext): boolean {
  try {
    return context.isPackageType(node, NODE_TYPES_PACKAGES);
  } catch {
    return false;
  }
}

// The value a local `const` was initialised with, so `const file = fs.createReadStream(p);
// file.pipe(res)` resolves.
function localInitializer(identifier: Identifier): Expression | undefined {
  const scope = functionBody(identifier);
  let found: Expression | undefined;
  forEachInScope(scope, (node: Node) => {
    if (found || !ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name)) return;
    if (node.name.text === identifier.text && node.initializer) found = node.initializer;
  });
  return found && ts.skipOuterExpressions(found);
}

// ---- stream-pipe-unhandled-error ----

function pipeStages(call: MethodCall): { source: Expression; stages: Expression[] } {
  const stages: Expression[] = [];
  let current: Expression = call;
  while (isMethodCall(current, 'pipe')) {
    stages.unshift(current.arguments[0]);
    current = ts.skipOuterExpressions(current.expression.expression);
  }
  return { source: current, stages };
}

function isStreamFactoryCall(node: Node): boolean {
  const value = ts.skipOuterExpressions(node);
  return ts.isCallExpression(value) && STREAM_FACTORY.test(calleeName(value) ?? '');
}

function isRequestStream(node: Node): boolean {
  const value = ts.skipOuterExpressions(node);
  if (!ts.isIdentifier(value) || !REQUEST_STREAM_NAME.test(value.text)) return false;
  const owner = enclosingFunction(value);
  return !!owner?.parameters.some((parameter: ParameterDeclaration) => parameterName(parameter) === value.text);
}

// 'clear' when the code shows a Node stream, 'name' when only its name suggests one.
function streamEvidence(node: Node, context: PerformanceRuleContext): 'clear' | 'name' | undefined {
  const value = ts.skipOuterExpressions(node);
  if (isStreamFactoryCall(value) || isRequestStream(value) || isNodeType(value, context)) return 'clear';
  if (ts.isIdentifier(value)) {
    const initializer = localInitializer(value);
    if (initializer && (isStreamFactoryCall(initializer) || isMethodCall(initializer, 'pipe'))) return 'clear';
    if (STREAM_NAME.test(value.text)) return 'name';
  }
  if (ts.isPropertyAccessExpression(value) && STREAM_NAME.test(value.name.text)) return 'name';
}

function looksLikeOperatorPipe(call: MethodCall, context: PerformanceRuleContext): boolean {
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

function streamNames(nodes: readonly Expression[]): Set<string> {
  const names = new Set<string>();
  for (const node of nodes) {
    const root = chainRoot(node);
    if (ts.isIdentifier(root)) names.add(root.text);
  }
  return names;
}

function isErrorListener(call: CallExpression): call is MethodCall {
  if (!isMethodCall(call, ERROR_LISTENER_METHODS)) return false;
  const [event] = call.arguments;
  return !!event && ts.isStringLiteralLike(event) && event.text === 'error';
}

function hasErrorHandling(call: MethodCall, source: Expression, stages: readonly Expression[]): boolean {
  // `src.on('error', h).pipe(dst)` or `src.pipe(dst).on('error', h)`.
  for (let node: Expression = source; ts.isCallExpression(node) || ts.isPropertyAccessExpression(node);) {
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
  forEachInScope(functionBody(call), (node: Node) => {
    if (handled || !ts.isCallExpression(node)) return;
    if (COMPLETION_HELPERS.has(calleeName(node) ?? '')) handled = true;
    else if (isErrorListener(node)) {
      const root = chainRoot(node.expression.expression);
      handled = ts.isIdentifier(root) && names.has(root.text);
    }
  });
  return handled;
}

function completionReason(source: Expression): string | undefined {
  if (surfacesErrorsThroughCompletion(source))
    return 'The source stream hands back an awaited completion function inside try/catch, so its failures are caught there; destination errors still need a listener.';
}

const COMPLETION_PROMISE_NAME = /^(?:complete|completed|completion|done|finished|finalize)$/;

// `const { archive, complete } = await build()`: the producer hands back its stream together with a
// completion function, and the code awaits that function inside try/catch right after piping, so
// stream failures surface there.
function surfacesErrorsThroughCompletion(source: Expression): boolean {
  const value = ts.skipOuterExpressions(source);
  if (!ts.isIdentifier(value)) return false;
  const declaration = ts.findAncestor(localDeclaration(value), ts.isVariableDeclaration);
  if (!declaration || !ts.isObjectBindingPattern(declaration.name)) return false;
  const completionNames = declaration.name.elements.flatMap((element) =>
    ts.isIdentifier(element.name) && COMPLETION_PROMISE_NAME.test(element.name.text) ? [element.name.text] : [],
  );
  if (completionNames.length === 0) return false;
  let awaitedInTry = false;
  forEachInScope(functionBody(value), (node: Node) => {
    if (
      ts.isAwaitExpression(node) &&
      ts.isCallExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      completionNames.includes(node.expression.expression.text) &&
      isInsideTry(node)
    )
      awaitedInTry = true;
  });
  return awaitedInTry;
}

function localDeclaration(identifier: Identifier): BindingElement | undefined {
  let found: BindingElement | undefined;
  forEachInScope(functionBody(identifier), (node: Node) => {
    if (!found && ts.isBindingElement(node) && ts.isIdentifier(node.name) && node.name.text === identifier.text)
      found = node;
  });
  return found;
}

function checkPipe(node: CallExpression, context: PerformanceRuleContext): void {
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
    ? completionReason(source)
    : 'Only the names suggest these are Node streams; skip this if `.pipe()` belongs to another library.';
  context.report(node, PIPE_RULE, PIPE_MESSAGE, reason);
}

// ---- json-parse-unguarded ----

function isInsideTry(node: Node): boolean {
  for (let child: Node = node, parent: Node | undefined = node.parent; parent; child = parent, parent = parent.parent) {
    if (ts.isFunctionLike(parent)) return false;
    if (ts.isTryStatement(parent) && parent.catchClause && child === parent.tryBlock) return true;
  }
  return false;
}

function isExported(declaration: FunctionDeclaration): boolean {
  return !!declaration.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
}

// A private helper whose every call sits inside try/catch in the same file: the parse cannot escape
// unhandled, and the helper is usually the one place that opens the file. A shorthand export or any
// other reference counts as an unguarded caller.
function isGuardedByEveryCaller(node: Node): boolean {
  const helper = enclosingFunction(node);
  if (!helper || !ts.isFunctionDeclaration(helper) || !helper.name || isExported(helper)) return false;
  const helperName = helper.name;
  let callerCount = 0;
  let allGuarded = true;
  forEachInScope(node.getSourceFile(), (candidate) => {
    if (!ts.isIdentifier(candidate) || candidate.text !== helperName.text || candidate === helperName) return;
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

function hasRequestDecorator(parameter: ParameterDeclaration): boolean {
  return !!parameter.modifiers?.some(
    (modifier) =>
      ts.isDecorator(modifier) &&
      ts.isCallExpression(modifier.expression) &&
      ts.isIdentifier(modifier.expression.expression) &&
      REQUEST_DECORATORS.has(modifier.expression.expression.text),
  );
}

function declaringParameter(identifier: Identifier): ParameterDeclaration | undefined {
  for (let scope = enclosingFunction(identifier); scope; scope = enclosingFunction(scope)) {
    const parameter = scope.parameters.find((item) => parameterName(item) === identifier.text);
    if (parameter) return parameter;
  }
}

function firstMember(access: PropertyAccessExpression | ElementAccessExpression): string | undefined {
  let current: PropertyAccessExpression | ElementAccessExpression = access;
  while (ts.isPropertyAccessExpression(current.expression) || ts.isElementAccessExpression(current.expression))
    current = current.expression;
  if (ts.isPropertyAccessExpression(current)) return current.name.text;
}

function isRequestRead(value: Expression): boolean {
  const root = chainRoot(value);
  if (!ts.isIdentifier(root)) return false;
  const parameter = declaringParameter(root);
  if (!parameter) return false;
  if (hasRequestDecorator(parameter)) return true;
  if (!ts.isPropertyAccessExpression(value) && !ts.isElementAccessExpression(value)) return false;
  const member = firstMember(value);
  return REQUEST_OBJECT.test(root.text) && member !== undefined && REQUEST_MEMBERS.has(member);
}

function isMessagePayload(value: Expression): boolean {
  if (!ts.isPropertyAccessExpression(value) || !MESSAGE_MEMBERS.has(value.name.text)) return false;
  const root = chainRoot(value);
  return ts.isIdentifier(root) && MESSAGE_ROOT.test(root.text);
}

function isOutsideCall(call: CallExpression): boolean {
  const callee = ts.skipOuterExpressions(call.expression);
  const name = calleeName(call) ?? '';
  if (READ_FILE.test(name)) return true;
  if (!ts.isPropertyAccessExpression(callee)) return false;
  const receiver = ts.skipOuterExpressions(callee.expression);
  if (name === 'getItem') return ts.isIdentifier(receiver) && BROWSER_STORAGE.has(receiver.text);
  // `await response.text()` on a fetch Response.
  return name === 'text' && call.arguments.length === 0 && ts.isAwaitExpression(call.parent);
}

// A file the tool ships next to its own code, such as `path.join(path.resolve(import.meta.dirname, '..'),
// 'package.json')`, is not outside input: it is as trustworthy as the code that reads it. Every
// other path part must be a literal, so
// `path.join(import.meta.dirname, 'uploads', name)` still counts as outside input.
function isBundledPath(node: Node, depth = 0): boolean {
  const value = ts.skipOuterExpressions(node);
  if (ts.isIdentifier(value)) {
    if (value.text === '__dirname' || value.text === 'import.meta.dirname') return true;
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

const PATH_BUILDERS = new Set(['join', 'resolve', 'normalize']);
const DIRECTORY_LISTINGS = new Set(['readdir', 'readdirSync']);

// `await readdir("fixed/folder")` or `readdirSync(...)`, with the folder itself project-local.
function isLocalDirectoryListing(node: Node, depth: number): boolean {
  let value = ts.skipOuterExpressions(node);
  while (ts.isAwaitExpression(value)) value = ts.skipOuterExpressions(value.expression);
  if (ts.isIdentifier(value) && depth < MAX_ALIAS_DEPTH) {
    const initializer = localInitializer(value);
    return !!initializer && isLocalDirectoryListing(initializer, depth + 1);
  }
  return (
    ts.isCallExpression(value) &&
    DIRECTORY_LISTINGS.has(calleeName(value) ?? '') &&
    !!value.arguments[0] &&
    isProjectLocalPath(value.arguments[0], depth)
  );
}

// A file name taken from the listing of a fixed folder: `files.map((name) => ...)` over
// `readdir("fixed/")`.
function isListedFileName(identifier: Identifier, depth: number): boolean {
  const parameter = declaringParameter(identifier);
  const callback = parameter?.parent;
  const call = callback?.parent;
  if (!callback || !call || !ts.isCallExpression(call) || call.arguments[0] !== callback) return false;
  if (callback.parameters[0] !== parameter || !ts.isPropertyAccessExpression(call.expression)) return false;
  return isLocalDirectoryListing(call.expression.expression, depth + 1);
}

// A path built only from literals, `import.meta.dirname`, `process.cwd()` and the file names of a fixed
// folder: it is read from the project's own disk, and no request can steer it.
function isProjectLocalPath(node: Node, depth = 0): boolean {
  const value = ts.skipOuterExpressions(node);
  if (
    ts.isStringLiteralLike(value) ||
    value.getText() === '__dirname' ||
    value.getText() === 'import.meta.dirname' ||
    value.getText() === 'process.cwd()'
  )
    return true;
  if (ts.isBinaryExpression(value) && value.operatorToken.kind === ts.SyntaxKind.PlusToken)
    return isProjectLocalPath(value.left, depth) && isProjectLocalPath(value.right, depth);
  if (ts.isTemplateExpression(value))
    return value.templateSpans.every((span) => isProjectLocalPath(span.expression, depth));
  if (ts.isCallExpression(value))
    return (
      PATH_BUILDERS.has(calleeName(value) ?? '') && value.arguments.every((part) => isProjectLocalPath(part, depth))
    );
  if (!ts.isIdentifier(value) || depth >= MAX_ALIAS_DEPTH) return false;
  const initializer = localInitializer(value);
  if (initializer) return isProjectLocalPath(initializer, depth + 1);
  return isListedFileName(value, depth);
}

function isEnvRead(value: Node): boolean {
  const text = value.getText();
  return /^process\.env(?:\.|\[)/.test(text);
}

// Which kind of outside input `value` is, following string conversions and local aliases.
function outsideInput(node: Expression, depth = 0): OutsideInputKind | undefined {
  const value = ts.skipOuterExpressions(node);
  if (ts.isAwaitExpression(value)) return outsideInput(value.expression, depth);
  if (ts.isBinaryExpression(value) && value.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)
    return outsideInput(value.left, depth);
  if (ts.isCallExpression(value)) {
    const name = calleeName(value) ?? '';
    if (STRING_CONVERSIONS.has(name)) {
      const inner = ts.isPropertyAccessExpression(value.expression) ? value.expression.expression : value.arguments[0];
      return inner && outsideInput(inner, depth);
    }
    if (READ_FILE.test(name) && value.arguments[0] && isBundledPath(value.arguments[0])) return undefined;
    if (READ_FILE.test(name) && value.arguments[0] && isProjectLocalPath(value.arguments[0])) return 'local-file';
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

function usesExpress5(context: PerformanceRuleContext, sourceFile: SourceFile): boolean {
  const major = expressMajor(context.program, sourceFile.fileName);
  return major !== undefined && major >= FIRST_EXPRESS_MAJOR_FORWARDING_REJECTIONS;
}

function isAsync(fn: FunctionLikeDeclaration): boolean {
  return !!fn.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword);
}

const { localManifestReason, isCommandCallback, isResponseJsonWrapper } = createJsonParseContext({
  READ_FILE,
  STRING_CONVERSIONS,
  MAX_ALIAS_DEPTH,
  PATH_BUILDERS,
  localInitializer,
  enclosingFunction,
  isMethodCall,
});

function parseContext(
  node: CallExpression,
  kind: OutsideInputKind,
  context: PerformanceRuleContext,
): string | undefined {
  if (kind === 'local-file')
    return "This parse reads a file from the project's own folder, not request data, so a malformed file is a deployment fault rather than bad input.";
  if (isResponseJsonWrapper(node))
    return 'This `json()` method mirrors `Response.json()`, which throws on malformed bodies by contract; callers are expected to handle it.';
  const manifestReason = localManifestReason(node);
  if (manifestReason) return manifestReason;
  if (isCommandCallback(node))
    return 'This parse runs in a command-line command callback, where failing on a malformed file may be intended.';
  const handler = enclosingRequestHandler(node);
  if (handler) {
    if (ts.isMethodDeclaration(handler) || isFastifyHandler(handler))
      return 'The framework turns this throw into a 500 response, so the process survives; a 400 for bad input is still clearer.';
    if (usesExpress5(context, node.getSourceFile()))
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

function checkJsonParse(node: CallExpression, context: PerformanceRuleContext): void {
  if (node.arguments.length === 0) return;
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
  context.report(node, PARSE_RULE, PARSE_MESSAGE, parseContext(node, kind, context));
}

// ---- request-number-unvalidated ----

function parsedInput(node: Node): Expression | undefined {
  if (ts.isCallExpression(node) && NUMBER_PARSERS.has(ts.skipOuterExpressions(node.expression).getText()))
    return node.arguments[0];
  const isUnaryPlus = ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.PlusToken;
  if (isUnaryPlus && !ts.isNumericLiteral(node.operand)) return node.operand;
}

// Nest `@Query('page', ParseIntPipe)` and DTO class parameters are validated before the handler
// runs.
function isValidatedParameter(parameter: ParameterDeclaration): boolean {
  const hasPipe = parameter.modifiers?.some(
    (modifier) =>
      ts.isDecorator(modifier) && ts.isCallExpression(modifier.expression) && modifier.expression.arguments.length > 1,
  );
  return !!hasPipe || (!!parameter.type && ts.isTypeReferenceNode(parameter.type));
}

// Request reads that skipped validation: `@Query('page') page: string` counts, a DTO class
// parameter does not.
function rawRequestSource(handler: FunctionWithBody): InputSourceOf {
  const base = requestInputOf(handler);
  return (parameter, node) => {
    if (hasRequestDecorator(parameter)) return isValidatedParameter(parameter) ? undefined : {};
    return base(parameter, node);
  };
}

function isRawRequestNumber(input: Expression, handler: RequestHandlerFunction): boolean {
  const sources = traceInputs(input, handler, rawRequestSource(handler));
  return sources.length > 0 && sources.every((source) => !source.schema);
}

// Walks up from a use of the number through wrappers; true when it lands in a query, a size call,
// an index or arithmetic whose result is kept.
function reachesSink(use: Node): boolean {
  let child: Node = use;
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
      if (!parent.arguments.some((argument) => argument === child)) return false;
      const name = calleeName(parent) ?? '';
      return SINK_METHODS.has(name) || (ts.isPropertyAccessExpression(parent.expression) && QUERY_METHODS.test(name));
    }
    return false;
  }
  return false;
}

function isGuardOf(node: Node, name: string): boolean {
  const mentions = (expression: Node): boolean => {
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

function namedResultReachesSink(declaration: VariableDeclaration): boolean {
  const declaredName = declaration.name;
  if (!ts.isIdentifier(declaredName)) return false;
  const name = declaredName.text;
  const scope = functionBody(declaration);
  let firstSink: Node | undefined;
  forEachInScope(scope, (node: Node) => {
    const isUse = ts.isIdentifier(node) && node.text === name && node !== declaredName;
    if (isUse && node.pos > declaration.end && reachesSink(node) && (!firstSink || node.pos < firstSink.pos))
      firstSink = node;
  });
  if (!firstSink) return false;
  const sinkPosition = firstSink.pos;
  let guarded = false;
  forEachInScope(scope, (node: Node) => {
    if (!guarded && node.pos > declaration.end && node.pos < sinkPosition && isGuardOf(node, name)) guarded = true;
  });
  return !guarded;
}

function checkRequestNumber(node: CallExpression | PrefixUnaryExpression, context: PerformanceRuleContext): void {
  const input = parsedInput(node);
  if (!input) return;
  const handler = enclosingRequestHandler(node);
  if (!handler || !isRawRequestNumber(input, handler)) return;
  let outer: Node = node;
  while (ts.isParenthesizedExpression(outer.parent)) outer = outer.parent;
  const parent = outer.parent;
  // `Number(x) || 1` replaces NaN with the fallback.
  if (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.BarBarToken) return;
  const declared = ts.isVariableDeclaration(parent) && parent.initializer === outer && ts.isIdentifier(parent.name);
  const unchecked = declared ? namedResultReachesSink(parent) : reachesSink(outer);
  if (!unchecked) return;
  context.report(node, NUMBER_RULE, NUMBER_MESSAGE);
}

function check(node: Node, context: PerformanceRuleContext): void {
  if (ts.isPrefixUnaryExpression(node)) return checkRequestNumber(node, context);
  if (!ts.isCallExpression(node)) return;
  checkPipe(node, context);
  checkJsonParse(node, context);
  checkRequestNumber(node, context);
}

export { check };
