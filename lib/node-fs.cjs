'use strict';

const { syntax: ts } = require('./compiler.cjs');

const blockingModules = new Map([
  [
    'fs',
    {
      rule: 'node-sync-fs-in-async',
      advice: 'Use asynchronous filesystem I/O on this path.',
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
      advice: 'Use asynchronous compression or decompression on this path.',
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
      advice: 'Use the asynchronous crypto operation on this path.',
      methods: ['argon2Sync', 'generateKeyPairSync', 'pbkdf2Sync', 'scryptSync'],
    },
  ],
  [
    'child_process',
    {
      rule: 'node-sync-process-in-async',
      advice: 'Use an asynchronous child process API on this path.',
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

function requiredModule(node, checker, identify = builtinName) {
  if (
    !node ||
    !ts.isCallExpression(node) ||
    !ts.isIdentifier(node.expression) ||
    node.expression.text !== 'require' ||
    node.arguments.length !== 1
  )
    return;
  const moduleName = identify(node.arguments[0]);
  if (!moduleName) return;

  // The global Node require may have no declaration in a plain JS project.
  const declarations = checker.getSymbolAtLocation(node.expression)?.declarations ?? [];
  if (
    declarations.every(
      (declaration) =>
        declaration.getSourceFile().isDeclarationFile &&
        /[/\\]node_modules[/\\]@types[/\\]node[/\\]/.test(declaration.getSourceFile().fileName),
    )
  )
    return moduleName;
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
  const moduleName = requiredModule(variable.initializer, checker);
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

const maxPendingCalls = 256;

const unitRunners = new Set(['node:test', 'vitest', '@jest/globals', 'mocha']);
const serialRegistrations = new Set(['it', 'test', 'before', 'after', 'beforeAll', 'afterAll']);
const promiseCombinators = new Set(['all', 'allSettled', 'any', 'race']);
const processEntries = new WeakMap();
const detachedWork = new WeakMap();

function unitRunner(specifier) {
  if (specifier && ts.isStringLiteralLike(specifier) && unitRunners.has(specifier.text)) return specifier.text;
}

function hasRegistrationOptions(call) {
  if (call.arguments.length !== 2) return call.arguments.length > 2;
  const first = ts.skipOuterExpressions(call.arguments[0]);
  return !ts.isStringLiteralLike(first) && !ts.isTemplateExpression(first);
}

function concurrentRegistration(expression) {
  while (ts.isCallExpression(expression) || ts.isPropertyAccessExpression(expression)) {
    if (ts.isPropertyAccessExpression(expression) && ['concurrent', 'parallel'].includes(expression.name.text))
      return true;
    expression = expression.expression;
  }
  return false;
}

function serialTestBody(owner, checker) {
  const registration = owner.parent;
  if (
    !ts.isCallExpression(registration) ||
    !ts.isIdentifier(registration.expression) ||
    hasRegistrationOptions(registration) ||
    registration.arguments.at(-1) !== owner
  )
    return false;
  const declaration = checker.getSymbolAtLocation(registration.expression)?.declarations?.[0];
  if (!declaration) return false;
  let runner, name;
  if (ts.isImportSpecifier(declaration) || ts.isImportClause(declaration)) {
    runner = unitRunner(ts.findAncestor(declaration, ts.isImportDeclaration)?.moduleSpecifier);
    name = ts.isImportSpecifier(declaration) ? (declaration.propertyName ?? declaration.name).text : 'default';
  } else if (ts.isBindingElement(declaration) && ts.isObjectBindingPattern(declaration.parent)) {
    const variable = declaration.parent.parent;
    if (!ts.isVariableDeclaration(variable) || !(variable.parent.flags & ts.NodeFlags.Const)) return false;
    runner = requiredModule(variable.initializer, checker, unitRunner);
    name = (declaration.propertyName ?? declaration.name).text;
  } else if (
    ts.isVariableDeclaration(declaration) &&
    declaration.parent.flags & ts.NodeFlags.Const &&
    requiredModule(declaration.initializer, checker, unitRunner) === 'node:test'
  ) {
    runner = 'node:test';
    name = 'default';
  } else if (
    declaration.getSourceFile().isDeclarationFile &&
    /[/\\]node_modules[/\\]@types[/\\](?:jest|mocha)[/\\]/.test(declaration.getSourceFile().fileName)
  ) {
    runner = 'global';
    name = registration.expression.text;
  }
  if (!(runner && (serialRegistrations.has(name) || (runner === 'node:test' && name === 'default')))) return false;
  // A nested test inherits the enclosing suite's concurrency configuration.
  for (let parent = registration.parent; parent; parent = parent.parent) {
    if (ts.isCallExpression(parent) && (hasRegistrationOptions(parent) || concurrentRegistration(parent.expression)))
      return false;
  }
  return true;
}

function isProperty(node, receiver, property) {
  return (
    ts.isPropertyAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === receiver &&
    node.name.text === property
  );
}

function commonJsMainGuard(test) {
  if (!ts.isBinaryExpression(test) || test.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken) return false;
  return (
    (isProperty(test.left, 'require', 'main') && ts.isIdentifier(test.right) && test.right.text === 'module') ||
    (isProperty(test.right, 'require', 'main') && ts.isIdentifier(test.left) && test.left.text === 'module')
  );
}

function setsProcessStatus(node) {
  if (ts.isCallExpression(node) && isProperty(node.expression, 'process', 'exit')) return true;
  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    isProperty(node.left, 'process', 'exitCode')
  )
    return true;
  return ts.forEachChild(node, setsProcessStatus);
}

function privateProcessEntries(source) {
  if (processEntries.has(source)) return processEntries.get(source);
  const entries = new Map();
  let exitsAtEnd;
  function inspect(statement, guarded) {
    if (ts.isBlock(statement)) {
      for (const child of statement.statements) inspect(child, guarded);
    } else if (ts.isIfStatement(statement) && commonJsMainGuard(statement.expression)) {
      inspect(statement.thenStatement, true);
    } else if (ts.isExpressionStatement(statement)) {
      let call = ts.skipOuterExpressions(statement.expression);
      if (ts.isVoidExpression(call) || ts.isAwaitExpression(call)) call = ts.skipOuterExpressions(call.expression);
      if (!ts.isCallExpression(call)) return;
      if (
        ts.isPropertyAccessExpression(call.expression) &&
        call.expression.name.text === 'catch' &&
        ts.isCallExpression(call.expression.expression)
      ) {
        if (!guarded && !call.arguments.some(setsProcessStatus)) return;
        call = call.expression.expression;
      } else if (!guarded) {
        // A CLI can terminate inside main itself, with no top-level catch handler.
        if (!ts.isIdentifier(call.expression)) return;
        if (!exitsAtEnd) {
          exitsAtEnd = new Set();
          for (const item of source.statements) {
            if (!ts.isFunctionDeclaration(item) || !item.name) continue;
            const last = item.body?.statements.at(-1);
            if (
              last &&
              ts.isExpressionStatement(last) &&
              ts.isCallExpression(last.expression) &&
              isProperty(last.expression.expression, 'process', 'exit')
            )
              exitsAtEnd.add(item.name.text);
          }
        }
        if (!exitsAtEnd.has(call.expression.text)) return;
      }
      if (ts.isIdentifier(call.expression)) entries.set(call.expression.text, call.expression);
    }
  }
  for (const statement of source.statements) inspect(statement, false);
  // Shared/exported handlers can serve traffic even if the module also invokes them at startup.
  function discardShared(node) {
    if (!entries.size) return;
    if (
      ts.isIdentifier(node) &&
      entries.has(node.text) &&
      entries.get(node.text) !== node &&
      !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) &&
      !(ts.isPropertyAssignment(node.parent) && node.parent.name === node) &&
      !(ts.isFunctionDeclaration(node.parent) && node.parent.name === node)
    )
      entries.delete(node.text);
    ts.forEachChild(node, discardShared);
  }
  if (entries.size) discardShared(source);
  processEntries.set(source, entries);
  return entries;
}

function firstDetachedCall(owner) {
  if (detachedWork.has(owner)) return detachedWork.get(owner);
  function find(node) {
    if (ts.isFunctionLike(node)) return;
    if (ts.isVoidExpression(node) && ts.isCallExpression(ts.skipOuterExpressions(node.expression))) return node;
    return ts.forEachChild(node, find);
  }
  const offset = find(owner.body)?.pos ?? Infinity;
  detachedWork.set(owner, offset);
  return offset;
}

function contextualReason(call, { checker, isRepeated }) {
  const owner = asyncOwner(call);
  for (let parent = call.parent; parent !== owner; parent = parent.parent) {
    if (
      ts.isCallExpression(parent) &&
      ts.isPropertyAccessExpression(parent.expression) &&
      ts.isIdentifier(parent.expression.expression) &&
      parent.expression.expression.text === 'Promise' &&
      promiseCombinators.has(parent.expression.name.text)
    )
      return;
  }
  if (
    ts.isFunctionDeclaration(owner) &&
    owner.name &&
    ts.isSourceFile(owner.parent) &&
    !owner.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) &&
    privateProcessEntries(owner.parent).has(owner.name.text) &&
    call.pos < firstDetachedCall(owner) &&
    !isRepeated(call)
  ) {
    return 'One operation directly in a private process entry point; assess startup cost or concurrent work.';
  }
  if (
    (ts.isFunctionExpression(owner) || ts.isArrowFunction(owner)) &&
    serialTestBody(owner, checker) &&
    !isRepeated(call)
  ) {
    return 'One operation directly in a unit-test body or suite hook; assess test-worker contention.';
  }
}

function reportBlockingCall(call, binding, context) {
  if (!binding?.method || moduleForMethod.get(binding.method) !== binding.moduleName) return;
  const { rule, advice } = blockingModules.get(binding.moduleName);
  context.report(
    call,
    rule,
    `${binding.moduleName}.${binding.method} blocks the event loop inside this async function. ${advice}`,
    contextualReason(call, context),
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

function checkNodeBlockingCall(call, context, pending) {
  const { checker } = context;
  const target = call.expression;
  if (ts.isIdentifier(target)) {
    if (!asyncOwner(call)) return;
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
  if (!moduleForMethod.has(method) || !asyncOwner(call)) return;
  const receiver = target.expression;
  const origin = ts.isIdentifier(receiver)
    ? builtinBinding(checker.getSymbolAtLocation(receiver), checker)
    : { moduleName: requiredModule(receiver, checker) };
  if (origin && !origin.method) reportBlockingCall(call, { moduleName: origin.moduleName, method }, context);
}

module.exports = { checkNodeBlockingCall, flushBlockingCalls };
