import { ts } from './compiler.js';
import { contextualReason, privateProcessEntries, requiredModule } from './node-fs-context.js';
import { isRequestHandler } from './request-handlers.js';
import { hasFunctionBody } from './function-kinds.js';
import type { CallExpression, MethodDeclaration, Node, SignatureDeclaration } from 'typescript';
import type { CheckerAdapter, PerformanceRuleContext, SymbolAdapter } from '../shared/types.js';
import type { FunctionWithBody } from '../shared/types/function-summaries.js';

// A built-in module whose synchronous methods block the event loop, with the rule that reports
// them.
interface BlockingModule {
  rule: string;
  advice: string;
  methods: readonly string[];
}

// Where a name comes from: a built-in module, and the method when the name is one of its exports.
interface BuiltinBinding {
  moduleName?: string;
  method?: string;
}

// A call that resolves to a blocking method of a built-in module.
interface BlockingBinding {
  moduleName: string;
  method: string;
}

const blockingModules = new Map<string, BlockingModule>([
  [
    'fs',
    {
      rule: 'node-sync-fs-in-async',
      advice: 'Await the `node:fs/promises` equivalent, for example `await readFile(path)`.',
      methods: [
        'accessSync',
        'appendFileSync',
        'chmodSync',
        'chownSync',
        'closeSync',
        'copyFileSync',
        'cpSync',
        'existsSync',
        'fchmodSync',
        'fchownSync',
        'fdatasyncSync',
        'fstatSync',
        'fsyncSync',
        'ftruncateSync',
        'futimesSync',
        'globSync',
        'lchmodSync',
        'lchownSync',
        'linkSync',
        'lstatSync',
        'lutimesSync',
        'mkdirSync',
        'mkdtempDisposableSync',
        'mkdtempSync',
        'opendirSync',
        'openSync',
        'readdirSync',
        'readFileSync',
        'readlinkSync',
        'readSync',
        'readvSync',
        'realpathSync',
        'renameSync',
        'rmdirSync',
        'rmSync',
        'statfsSync',
        'statSync',
        'symlinkSync',
        'truncateSync',
        'unlinkSync',
        'utimesSync',
        'writeFileSync',
        'writeSync',
        'writevSync',
      ],
    },
  ],
  [
    'zlib',
    {
      rule: 'node-sync-compression-in-async',
      advice: 'Use the callback form through `util.promisify`, for example `await promisify(zlib.gzip)(buffer)`.',
      methods: [
        'brotliCompressSync',
        'brotliDecompressSync',
        'deflateRawSync',
        'deflateSync',
        'gunzipSync',
        'gzipSync',
        'inflateRawSync',
        'inflateSync',
        'unzipSync',
        'zstdCompressSync',
        'zstdDecompressSync',
      ],
    },
  ],
  [
    'crypto',
    {
      rule: 'node-sync-crypto-in-async',
      advice:
        'Use the callback form through `util.promisify`, for example `await promisify(crypto.scrypt)(password, salt, keyLength)`.',
      methods: ['argon2Sync', 'generateKeyPairSync', 'pbkdf2Sync', 'scryptSync'],
    },
  ],
  [
    'child_process',
    {
      rule: 'node-sync-process-in-async',
      advice: 'Use `await promisify(execFile)(file, args)` or `spawn` with event handlers.',
      methods: ['execFileSync', 'execSync', 'spawnSync'],
    },
  ],
]);
const moduleForMethod = new Map<string, string>();
for (const [moduleName, { methods }] of blockingModules) {
  for (const method of methods) moduleForMethod.set(method, moduleName);
}

function builtinName(node: Node | undefined): string | undefined {
  if (!node || !ts.isStringLiteralLike(node)) return;
  const name = node.text.replace(/^node:/, '');
  if (blockingModules.has(name)) return name;
}

function requiredBuiltin(node: Node | undefined, checker: CheckerAdapter): string | undefined {
  return requiredModule(node, checker, builtinName);
}

function blockingModuleOf(moduleName: string): BlockingModule {
  const found = blockingModules.get(moduleName);
  if (!found) throw new Error('Unknown blocking module: ' + moduleName);
  return found;
}

function builtinBinding(symbol: SymbolAdapter | undefined, checker: CheckerAdapter): BuiltinBinding | undefined {
  const declaration = symbol?.declarations?.[0];
  if (!declaration) return undefined;

  if (ts.isImportClause(declaration) || ts.isImportSpecifier(declaration) || ts.isNamespaceImport(declaration)) {
    const statement = ts.findAncestor(declaration, ts.isImportDeclaration);
    const moduleName = builtinName(statement?.moduleSpecifier);
    if (!moduleName || statement?.importClause?.isTypeOnly || ('isTypeOnly' in declaration && declaration.isTypeOnly)) {
      return undefined;
    }
    if (ts.isImportSpecifier(declaration)) {
      const name = (declaration.propertyName ?? declaration.name).text;
      return { moduleName, method: name === 'default' ? undefined : name };
    }
    return { moduleName };
  }

  if (
    ts.isImportEqualsDeclaration(declaration) &&
    !declaration.isTypeOnly &&
    ts.isExternalModuleReference(declaration.moduleReference)
  ) {
    const moduleName = builtinName(declaration.moduleReference.expression);
    if (moduleName) return { moduleName };
  }

  const destructured = ts.isBindingElement(declaration) && ts.isObjectBindingPattern(declaration.parent);
  const variable = destructured ? declaration.parent.parent : declaration;
  if (!ts.isVariableDeclaration(variable) || !(variable.parent.flags & ts.NodeFlags.Const)) return undefined;
  const moduleName = requiredBuiltin(variable.initializer, checker);
  if (!moduleName) return;
  if (!destructured) return { moduleName };
  const key = declaration.propertyName ?? declaration.name;
  if (ts.isIdentifier(key) || ts.isStringLiteralLike(key)) return { moduleName, method: key.text };
}

function isImmediatelyInvoked(node: Node): boolean {
  if (!(ts.isArrowFunction(node) || ts.isFunctionExpression(node)) || node.asteriskToken) return false;
  let expression: Node = node;
  while (ts.isParenthesizedExpression(expression.parent)) expression = expression.parent;
  return ts.isCallExpression(expression.parent) && expression.parent.expression === expression;
}

function asyncOwner(call: CallExpression): FunctionWithBody | false {
  for (let child: Node = call, parent: Node | undefined = call.parent; parent; child = parent, parent = parent.parent) {
    // An instance field runs when the instance is constructed, possibly much later.
    if (
      ts.isPropertyDeclaration(parent) &&
      parent.initializer === child &&
      !parent.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword)
    )
      return false;
    if (
      !hasFunctionBody(parent) ||
      (parent.body !== child && !parent.parameters.some((parameter) => parameter === child))
    ) {
      continue;
    }
    if (parent.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)) return parent;
    if (!isImmediatelyInvoked(parent)) return false;
  }
  return false;
}

// A plain (req, res) handler or route method runs a sync file call on every request, just like an
// async one.
function syncRequestHandler(call: CallExpression): FunctionWithBody | undefined {
  for (let child: Node = call, parent: Node | undefined = call.parent; parent; child = parent, parent = parent.parent) {
    if (!ts.isFunctionLike(parent)) continue;
    if (!hasFunctionBody(parent) || parent.body !== child) return;
    return isRequestHandler(parent) &&
      !parent.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)
      ? parent
      : undefined;
  }
}

function blockingOwner(call: CallExpression): FunctionWithBody | false | undefined {
  return asyncOwner(call) || syncRequestHandler(call);
}

const maxPendingCalls = 256;
// Lifecycle methods a server calls once while it boots.
const startupMethodNames = new Set([
  'onModuleInit',
  'onApplicationBootstrap',
  'init',
  'initialize',
  'bootstrap',
  'start',
]);
const applicationFactories = new Set(['create', 'createApplicationContext', 'createMicroservice']);
function isMemoizingAssignment(kind: number): boolean {
  return kind === ts.SyntaxKind.QuestionQuestionEqualsToken || kind === ts.SyntaxKind.BarBarEqualsToken;
}

// `await NestFactory.create(AppModule)`: the function builds the application, so it runs once per
// boot.
function createsApplication(owner: FunctionWithBody): boolean {
  let creates = false;
  forEachDirectCall(owner.body, (call) => {
    const callee = call.expression;
    creates ||=
      ts.isPropertyAccessExpression(callee) &&
      ts.isIdentifier(callee.expression) &&
      callee.expression.text === 'NestFactory' &&
      applicationFactories.has(callee.name.text);
  });
  return creates;
}

function methodName(method: MethodDeclaration): string | undefined {
  return ts.isIdentifier(method.name) || ts.isPrivateIdentifier(method.name) ? method.name.text : undefined;
}

function isPrivateMethod(method: MethodDeclaration): boolean {
  return (
    ts.isPrivateIdentifier(method.name) ||
    !!method.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.PrivateKeyword)
  );
}

// `this.method(...)` calls of a private method, which can only come from its own class.
function ownClassCalls(method: MethodDeclaration): CallExpression[] {
  const name = methodName(method);
  const calls: CallExpression[] = [];
  (function walk(node: Node): void {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.expression.kind === ts.SyntaxKind.ThisKeyword &&
      node.expression.name.text === name
    )
      calls.push(node);
    ts.forEachChild(node, walk);
  })(method.parent);
  return calls;
}

// `this.cache ??= this.load()` runs the call once and reuses its promise afterwards.
function isMemoized(call: CallExpression): boolean {
  const assignment = ts.skipOuterExpressions(call).parent;
  return (
    ts.isBinaryExpression(assignment) &&
    isMemoizingAssignment(assignment.operatorToken.kind) &&
    ts.skipOuterExpressions(assignment.right) === call
  );
}

// A boot lifecycle method, or a private method whose every call is memoized or made from one.
// Verdicts are cached per method so a second call from the same caller reuses it; a method still
// being decided counts as false, so a call cycle never proves startup-only.
function runsOnceAtStartup(method: Node, verdicts = new Map<Node, boolean>()): boolean {
  if (!ts.isMethodDeclaration(method)) return false;
  const known = verdicts.get(method);
  if (known !== undefined) return known;
  verdicts.set(method, false);
  const name = methodName(method);
  const verdict = (name !== undefined && startupMethodNames.has(name)) || calledOnlyAtStartup(method, verdicts);
  verdicts.set(method, verdict);
  return verdict;
}

function calledOnlyAtStartup(method: MethodDeclaration, verdicts: Map<Node, boolean>): boolean {
  if (!isPrivateMethod(method)) return false;
  const calls = ownClassCalls(method);
  return (
    calls.length > 0 &&
    calls.every((call) => {
      if (isMemoized(call)) return true;
      const caller = ts.findAncestor(call.parent, ts.isFunctionLike);
      return !!caller && runsOnceAtStartup(caller, verdicts);
    })
  );
}

function startupOnlyReason(owner: FunctionWithBody): string | undefined {
  if (createsApplication(owner))
    return 'Runs in the function that creates the application, which happens once per boot rather than per request.';
  if (runsOnceAtStartup(owner))
    return 'Runs from a boot lifecycle method or a call cached after its first run, so it blocks once rather than per request; assess startup time.';
}

function blockingContext(
  call: CallExpression,
  context: PerformanceRuleContext,
  moduleName: string,
): string | undefined {
  const owner = asyncOwner(call) || undefined;
  return contextualReason(call, context, moduleName, owner) ?? (owner ? startupOnlyReason(owner) : undefined);
}

function reportBlockingCall(
  call: CallExpression,
  binding: BuiltinBinding | undefined,
  context: PerformanceRuleContext,
): void {
  const moduleName = binding?.moduleName;
  if (!binding?.method || moduleName === undefined || moduleForMethod.get(binding.method) !== moduleName) return;
  const { rule, advice } = blockingModuleOf(moduleName);
  if (!asyncOwner(call)) {
    // Only file reads are reported in plain request handlers; see syncRequestHandler.
    if (moduleName !== 'fs') return;
    context.report(
      call,
      rule,
      `${moduleName}.${binding.method} blocks the event loop on every request to this handler. ` +
        `Do it once at startup and reuse the result, or make the handler async. ${advice}`,
      blockingContext(call, context, moduleName),
    );
    return;
  }
  context.report(
    call,
    rule,
    `${moduleName}.${binding.method} blocks the event loop inside this async function. ${advice}`,
    blockingContext(call, context, moduleName),
  );
}

function flushBlockingCalls(calls: CallExpression[], context: PerformanceRuleContext): void {
  const { checker } = context;
  // One compiler request resolves direct calls that may be aliased imports.
  const targets = calls.map((call) => call.expression);
  const symbols = checker.getSymbolsAtLocations
    ? checker.getSymbolsAtLocations(targets)
    : targets.map((target) => checker.getSymbolAtLocation(target));
  for (let index = 0; index < calls.length; index++) {
    reportBlockingCall(calls[index], builtinBinding(symbols[index], checker), context);
  }
  calls.length = 0;
}

// The blocking built-in a call resolves to, whatever function it sits in.
function blockingBinding(call: CallExpression, checker: CheckerAdapter): BlockingBinding | undefined {
  const target = call.expression;
  if (ts.isIdentifier(target)) {
    const { moduleName, method } = builtinBinding(checker.getSymbolAtLocation(target), checker) ?? {};
    return moduleName && method && moduleForMethod.get(method) === moduleName ? { moduleName, method } : undefined;
  }
  if (!ts.isPropertyAccessExpression(target) || !moduleForMethod.has(target.name.text)) return;
  const receiver = target.expression;
  const origin: BuiltinBinding | undefined = ts.isIdentifier(receiver)
    ? builtinBinding(checker.getSymbolAtLocation(receiver), checker)
    : { moduleName: requiredBuiltin(receiver, checker) };
  const method = target.name.text;
  if (origin?.moduleName && !origin.method && moduleForMethod.get(method) === origin.moduleName) {
    return { moduleName: origin.moduleName, method };
  }
}

function isMulterDiskStorage(call: CallExpression, checker: CheckerAdapter): boolean {
  const callee = call.expression;
  const name = ts.isIdentifier(callee) ? callee : ts.isPropertyAccessExpression(callee) ? callee.name : undefined;
  if (name?.text !== 'diskStorage') return false;
  const filename = checker.getResolvedSignature(call)?.declaration?.getSourceFile().fileName.replaceAll('\\', '/');
  return !!filename && /\/node_modules\/(?:@types\/)?multer\//.test(filename);
}

// Blocking calls directly inside an async function are already reported by checkNodeBlockingCall.
function isAsyncFunction(node: Node): boolean {
  return (
    ts.canHaveModifiers(node) &&
    !!ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)
  );
}

function forEachDirectCall(body: Node, visit: (call: CallExpression) => void): void {
  (function walk(node: Node): void {
    if (node !== body && ts.isFunctionLike(node)) return;
    if (ts.isCallExpression(node)) visit(node);
    ts.forEachChild(node, walk);
  })(body);
}

function bodyOf(declaration: SignatureDeclaration): Node | undefined {
  return 'body' in declaration ? declaration.body : undefined;
}

function projectFunctionBody(call: CallExpression, checker: CheckerAdapter): Node | undefined {
  const declaration = checker.getResolvedSignature(call)?.declaration;
  if (!declaration || declaration.getSourceFile().isDeclarationFile) return;
  if (ts.isFunctionLike(declaration)) return bodyOf(declaration);
  const initializer = ts.isVariableDeclaration(declaration) && declaration.initializer;
  const value = initializer && ts.skipOuterExpressions(initializer);
  return value && ts.isFunctionLike(value) ? bodyOf(value) : undefined;
}

// multer calls diskStorage's `destination` and `filename` once per uploaded file, on the request
// path, so blocking work there (or in a helper they call) stalls every concurrent request. The
// first blocking built-in call made directly in a body, or undefined.
function firstBlockingBinding(body: Node, checker: CheckerAdapter): BlockingBinding | undefined {
  const found: BlockingBinding[] = [];
  forEachDirectCall(body, (nested) => {
    if (found.length > 0) return;
    const binding = blockingBinding(nested, checker);
    if (binding) found.push(binding);
  });
  return found[0];
}

function checkUploadCallbacks(call: CallExpression, context: PerformanceRuleContext): void {
  const { checker } = context;
  const options = call.arguments[0] && ts.skipOuterExpressions(call.arguments[0]);
  if (!options || !ts.isObjectLiteralExpression(options) || !isMulterDiskStorage(call, checker)) return;
  for (const property of options.properties) {
    const callback = ts.isPropertyAssignment(property) ? ts.skipOuterExpressions(property.initializer) : property;
    if (!ts.isFunctionLike(callback)) continue;
    const callbackBody = bodyOf(callback);
    if (!callbackBody) continue;
    const where = `inside the multer \`${property.name?.getText()}\` callback, once per uploaded file,`;
    forEachDirectCall(callbackBody, (inner) => {
      const direct = blockingBinding(inner, checker);
      if (direct) {
        if (isAsyncFunction(callback)) return;
        reportUploadCall(inner, `${direct.moduleName}.${direct.method} runs ${where}`, direct, context);
        return;
      }
      const body = projectFunctionBody(inner, checker);
      if (!body || isAsyncFunction(body.parent)) return;
      const reached = firstBlockingBinding(body, checker);
      if (!reached) return;
      const helper = `\`${inner.expression.getText()}()\``;
      reportUploadCall(inner, `${helper} runs ${reached.moduleName}.${reached.method} ${where}`, reached, context);
    });
  }
}

function reportUploadCall(
  call: CallExpression,
  subject: string,
  binding: BlockingBinding,
  context: PerformanceRuleContext,
): void {
  context.report(
    call,
    blockingModuleOf(binding.moduleName).rule,
    `${subject} and blocks the event loop each time. Move one-time setup, such as creating the upload directory, to startup. Otherwise use the asynchronous API and invoke the multer callback when it completes.`,
  );
}

function checkNodeBlockingCall(
  call: CallExpression,
  context: PerformanceRuleContext,
  pending?: CallExpression[],
): void {
  const { checker } = context;
  checkUploadCallbacks(call, context);
  const target = call.expression;
  if (ts.isIdentifier(target)) {
    if (!blockingOwner(call)) return;
    if (pending) {
      pending.push(call);
      if (pending.length === maxPendingCalls) flushBlockingCalls(pending, context);
    } else {
      reportBlockingCall(call, builtinBinding(checker.getSymbolAtLocation(target), checker), context);
    }
    return;
  }
  let method: string;
  if (ts.isPropertyAccessExpression(target)) method = target.name.text;
  else if (ts.isElementAccessExpression(target) && ts.isStringLiteralLike(target.argumentExpression)) {
    method = target.argumentExpression.text;
  } else return;
  if (!moduleForMethod.has(method) || !blockingOwner(call)) return;
  const receiver = target.expression;
  const origin: BuiltinBinding | undefined = ts.isIdentifier(receiver)
    ? builtinBinding(checker.getSymbolAtLocation(receiver), checker)
    : { moduleName: requiredBuiltin(receiver, checker) };
  if (origin && !origin.method) reportBlockingCall(call, { moduleName: origin.moduleName, method }, context);
}

export { blockingBinding, checkNodeBlockingCall, flushBlockingCalls, privateProcessEntries };
