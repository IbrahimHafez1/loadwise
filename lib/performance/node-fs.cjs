'use strict';

const { syntax: ts } = require('./compiler.cjs');
const { contextualReason, privateProcessEntries, requiredModule } = require('./node-fs-context.cjs');
const { isRequestHandler } = require('./request-handlers.cjs');

const blockingModules = new Map([
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
const moduleForMethod = new Map();
for (const [moduleName, { methods }] of blockingModules) {
  for (const method of methods) moduleForMethod.set(method, moduleName);
}

function builtinName(node) {
  if (!node || !ts.isStringLiteralLike(node)) return;
  const name = node.text.replace(/^node:/, '');
  if (blockingModules.has(name)) return name;
}

function requiredBuiltin(node, checker) {
  return requiredModule(node, checker, builtinName);
}

function builtinBinding(symbol, checker) {
  const declaration = symbol?.declarations?.[0];
  if (!declaration) return undefined;

  if (ts.isImportClause(declaration) || ts.isImportSpecifier(declaration) || ts.isNamespaceImport(declaration)) {
    const statement = ts.findAncestor(declaration, ts.isImportDeclaration);
    const moduleName = builtinName(statement?.moduleSpecifier);
    if (!moduleName || statement.importClause.isTypeOnly || declaration.isTypeOnly) {
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

function isImmediatelyInvoked(node) {
  if (!(ts.isArrowFunction(node) || ts.isFunctionExpression(node)) || node.asteriskToken) return false;
  let expression = node;
  while (ts.isParenthesizedExpression(expression.parent)) expression = expression.parent;
  return ts.isCallExpression(expression.parent) && expression.parent.expression === expression;
}

function asyncOwner(call) {
  for (let child = call, parent = call.parent; parent; child = parent, parent = parent.parent) {
    // An instance field runs when the instance is constructed, possibly much later.
    if (
      ts.isPropertyDeclaration(parent) &&
      parent.initializer === child &&
      !parent.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword)
    )
      return false;
    if (!ts.isFunctionLike(parent) || (parent.body !== child && !parent.parameters.includes(child))) continue;
    if (parent.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)) return parent;
    if (!isImmediatelyInvoked(parent)) return false;
  }
  return false;
}

// A plain (req, res) handler or route method runs a sync file call on every request, just like an async one.
function syncRequestHandler(call) {
  for (let child = call, parent = call.parent; parent; child = parent, parent = parent.parent) {
    if (!ts.isFunctionLike(parent)) continue;
    if (parent.body !== child) return;
    return isRequestHandler(parent) &&
      !parent.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)
      ? parent
      : undefined;
  }
}

function blockingOwner(call) {
  return asyncOwner(call) || syncRequestHandler(call);
}

const maxPendingCalls = 256;

function reportBlockingCall(call, binding, context) {
  if (!binding?.method || moduleForMethod.get(binding.method) !== binding.moduleName) return;
  const { rule, advice } = blockingModules.get(binding.moduleName);
  if (!asyncOwner(call)) {
    // Only file reads are reported in plain request handlers; see syncRequestHandler.
    if (binding.moduleName !== 'fs') return;
    context.report(
      call,
      rule,
      `${binding.moduleName}.${binding.method} blocks the event loop on every request to this handler. ` +
        `Do it once at startup and reuse the result, or make the handler async. ${advice}`,
      contextualReason(call, context, binding.moduleName, asyncOwner(call)),
    );
    return;
  }
  context.report(
    call,
    rule,
    `${binding.moduleName}.${binding.method} blocks the event loop inside this async function. ${advice}`,
    contextualReason(call, context, binding.moduleName, asyncOwner(call)),
  );
}

function flushBlockingCalls(calls, context) {
  const { checker } = context;
  // One compiler request resolves direct calls that may be aliased imports.
  const symbols = checker.getSymbolsAtLocations(calls.map((call) => call.expression));
  for (let index = 0; index < calls.length; index++) {
    reportBlockingCall(calls[index], builtinBinding(symbols[index], checker), context);
  }
  calls.length = 0;
}

// The blocking built-in a call resolves to, whatever function it sits in.
function blockingBinding(call, checker) {
  const target = call.expression;
  if (ts.isIdentifier(target)) {
    const binding = builtinBinding(checker.getSymbolAtLocation(target), checker);
    return binding?.method && moduleForMethod.get(binding.method) === binding.moduleName ? binding : undefined;
  }
  if (!ts.isPropertyAccessExpression(target) || !moduleForMethod.has(target.name.text)) return;
  const receiver = target.expression;
  const origin = ts.isIdentifier(receiver)
    ? builtinBinding(checker.getSymbolAtLocation(receiver), checker)
    : { moduleName: requiredBuiltin(receiver, checker) };
  const method = target.name.text;
  if (origin?.moduleName && !origin.method && moduleForMethod.get(method) === origin.moduleName) {
    return { moduleName: origin.moduleName, method };
  }
}

function isMulterDiskStorage(call, checker) {
  const callee = call.expression;
  const name = ts.isIdentifier(callee) ? callee : ts.isPropertyAccessExpression(callee) ? callee.name : undefined;
  if (name?.text !== 'diskStorage') return false;
  const filename = checker.getResolvedSignature(call)?.declaration?.getSourceFile().fileName.replaceAll('\\', '/');
  return !!filename && /\/node_modules\/(?:@types\/)?multer\//.test(filename);
}

// Blocking calls directly inside an async function are already reported by checkNodeBlockingCall.
function isAsyncFunction(node) {
  return !!node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword);
}

function forEachDirectCall(body, visit) {
  (function walk(node) {
    if (node !== body && ts.isFunctionLike(node)) return;
    if (ts.isCallExpression(node)) visit(node);
    ts.forEachChild(node, walk);
  })(body);
}

function projectFunctionBody(call, checker) {
  const declaration = checker.getResolvedSignature(call)?.declaration;
  if (!declaration || declaration.getSourceFile().isDeclarationFile) return;
  if (ts.isFunctionLike(declaration)) return declaration.body;
  const initializer = ts.isVariableDeclaration(declaration) && declaration.initializer;
  const value = initializer && ts.skipOuterExpressions(initializer);
  return value && ts.isFunctionLike(value) ? value.body : undefined;
}

// multer calls diskStorage's `destination` and `filename` once per uploaded file, on the request path,
// so blocking work there (or in a helper they call) stalls every concurrent request.
function checkUploadCallbacks(call, context) {
  const { checker } = context;
  const options = call.arguments[0] && ts.skipOuterExpressions(call.arguments[0]);
  if (!options || !ts.isObjectLiteralExpression(options) || !isMulterDiskStorage(call, checker)) return;
  for (const property of options.properties) {
    const callback = ts.isPropertyAssignment(property) ? ts.skipOuterExpressions(property.initializer) : property;
    if (!ts.isFunctionLike(callback) || !callback.body) continue;
    const where = `inside the multer \`${property.name.getText()}\` callback, once per uploaded file,`;
    forEachDirectCall(callback.body, (inner) => {
      const direct = blockingBinding(inner, checker);
      if (direct) {
        if (isAsyncFunction(callback)) return;
        reportUploadCall(inner, `${direct.moduleName}.${direct.method} runs ${where}`, direct, context);
        return;
      }
      const body = projectFunctionBody(inner, checker);
      if (!body || isAsyncFunction(body.parent)) return;
      let reached;
      forEachDirectCall(body, (nested) => (reached ??= blockingBinding(nested, checker)));
      if (!reached) return;
      const helper = `\`${inner.expression.getText()}()\``;
      reportUploadCall(inner, `${helper} runs ${reached.moduleName}.${reached.method} ${where}`, reached, context);
    });
  }
}

function reportUploadCall(call, subject, binding, context) {
  context.report(
    call,
    blockingModules.get(binding.moduleName).rule,
    `${subject} and blocks the event loop each time. Move one-time setup, such as creating the upload directory, to startup. Otherwise use the asynchronous API and invoke the multer callback when it completes.`,
  );
}

function checkNodeBlockingCall(call, context, pending) {
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
  let method;
  if (ts.isPropertyAccessExpression(target)) method = target.name.text;
  else if (ts.isElementAccessExpression(target) && ts.isStringLiteralLike(target.argumentExpression)) {
    method = target.argumentExpression.text;
  } else return;
  if (!moduleForMethod.has(method) || !blockingOwner(call)) return;
  const receiver = target.expression;
  const origin = ts.isIdentifier(receiver)
    ? builtinBinding(checker.getSymbolAtLocation(receiver), checker)
    : { moduleName: requiredBuiltin(receiver, checker) };
  if (origin && !origin.method) reportBlockingCall(call, { moduleName: origin.moduleName, method }, context);
}

module.exports = { blockingBinding, checkNodeBlockingCall, flushBlockingCalls, privateProcessEntries };
