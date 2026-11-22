'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { syntax: ts } = require('./compiler.cjs');
const { runsOnlyInSchemaTooling } = require('./schema-tooling.cjs');

const cliCommandDirectory = /\/src\/commands\//;
// Scripts, dev tooling, end-to-end suites and boot-time folders run once, not per request; a loop in them can still be heavy.
const toolingPath = /(?:^|\/)(?:scripts?|tools?|tooling|bin|cli|e2e|startup|docker)\//;
// Folders and files named as one-off tasks stay contextual even when the call sits in a loop.
const oneOffTaskPath =
  /(?:^|\/)(?:[\w.-]*(?:release|generator|scaffold)[\w.-]*|create-[\w-]+)\/|(?:^|\/)(?:export|generate|make|backup|migrate|seed|release)[A-Z_.-][^/]*$/;
const applicationType = /^(?:Nest\w*Application|INestApplication\w*)$/;
const projectRootMarkers = ['package.json', 'tsconfig.json', 'jsconfig.json'];
const rootRelativePaths = new Map();
const unitRunners = new Set(['node:test', 'vitest', '@jest/globals', 'mocha']);
const serialRegistrations = new Set(['it', 'test', 'before', 'after', 'beforeAll', 'afterAll']);
const promiseCombinators = new Set(['all', 'allSettled', 'any', 'race']);
// Nest lifecycle hooks that run once before the application serves traffic.
const startupHooks = new Set(['onModuleInit', 'onApplicationBootstrap']);
const processEntries = new WeakMap();
const detachedWork = new WeakMap();

function requiredModule(node, checker, identify) {
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

function functionsEndingInProcessExit(source) {
  const entries = new Set();
  for (const item of source.statements) {
    if (!ts.isFunctionDeclaration(item) || !item.name) continue;
    const last = item.body?.statements.at(-1);
    if (
      last &&
      ts.isExpressionStatement(last) &&
      ts.isCallExpression(last.expression) &&
      isProperty(last.expression.expression, 'process', 'exit')
    )
      entries.add(item.name.text);
  }
  return entries;
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
        exitsAtEnd ??= functionsEndingInProcessExit(source);
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

// `const bootstrap = async () => {…}; void bootstrap();`: a private top-level function the module runs once on load.
function isConstProcessEntry(owner) {
  const declaration = owner.parent;
  if (!(ts.isArrowFunction(owner) || ts.isFunctionExpression(owner)) || !ts.isVariableDeclaration(declaration)) {
    return false;
  }
  const statement = declaration.parent.parent;
  if (
    declaration.initializer !== owner ||
    !ts.isIdentifier(declaration.name) ||
    !(declaration.parent.flags & ts.NodeFlags.Const) ||
    !ts.isVariableStatement(statement) ||
    !ts.isSourceFile(statement.parent) ||
    statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
  )
    return false;
  const name = declaration.name.text;
  const invocations = statement.parent.statements.filter((item) => {
    if (!ts.isExpressionStatement(item)) return false;
    let call = ts.skipOuterExpressions(item.expression);
    if (ts.isVoidExpression(call) || ts.isAwaitExpression(call)) call = ts.skipOuterExpressions(call.expression);
    if (
      ts.isCallExpression(call) &&
      ts.isPropertyAccessExpression(call.expression) &&
      ['catch', 'then', 'finally'].includes(call.expression.name.text)
    )
      call = call.expression.expression;
    return ts.isCallExpression(call) && ts.isIdentifier(call.expression) && call.expression.text === name;
  });
  if (invocations.length !== 1) return false;
  // Any other mention (an export list, a route registration, a second call) means it may run again.
  let mentions = 0;
  (function count(node) {
    if (
      ts.isIdentifier(node) &&
      node.text === name &&
      !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node)
    )
      mentions++;
    ts.forEachChild(node, count);
  })(statement.parent);
  return mentions === 2;
}

function hasMarker(directory, markers) {
  return markers.some((marker) => fs.existsSync(path.join(directory, marker)));
}

function ancestorWith(directory, markers) {
  for (let current = directory; ; current = path.dirname(current)) {
    if (hasMarker(current, markers)) return current;
    if (path.dirname(current) === current) return;
  }
}

function toForwardSlashes(file) {
  return file.split(path.sep).join('/');
}

function computeRootRelativePath(fileName) {
  const absolute = path.resolve(fileName);
  const directory = path.dirname(absolute);
  const repositoryRoot = ancestorWith(directory, ['.git']);
  if (repositoryRoot) return toForwardSlashes(path.relative(repositoryRoot, absolute));
  const fromWorkingDirectory = path.relative(process.cwd(), absolute);
  if (!fromWorkingDirectory.startsWith('..') && !path.isAbsolute(fromWorkingDirectory)) {
    return toForwardSlashes(fromWorkingDirectory);
  }
  const packageRoot = ancestorWith(directory, projectRootMarkers);
  return packageRoot ? toForwardSlashes(path.relative(packageRoot, absolute)) : path.basename(absolute);
}

// The file's path inside its repository (or the directory being scanned), so the folders above the project never count.
function rootRelativePath(fileName) {
  if (!rootRelativePaths.has(fileName)) rootRelativePaths.set(fileName, computeRootRelativePath(fileName));
  return rootRelativePaths.get(fileName);
}

function pathContext(call, isRepeated) {
  const relative = rootRelativePath(call.getSourceFile().fileName);
  if (cliCommandDirectory.test(`/${relative}`)) {
    return 'Runs in a CLI command under src/commands rather than a request path; assess only if it shares a process with request handling.';
  }
  if (oneOffTaskPath.test(relative) || (!isRepeated(call) && toolingPath.test(relative))) {
    return 'Runs in a script, tooling or boot-time file rather than a request path; assess only if it shares a process with request handling.';
  }
}

function inPromiseCombinator(call, owner) {
  for (let parent = call.parent; parent !== owner; parent = parent.parent) {
    if (
      ts.isCallExpression(parent) &&
      ts.isPropertyAccessExpression(parent.expression) &&
      ts.isIdentifier(parent.expression.expression) &&
      parent.expression.expression.text === 'Promise' &&
      promiseCombinators.has(parent.expression.name.text)
    )
      return true;
  }
  return false;
}

function isDebugFlag(expression) {
  const flag = ts.skipOuterExpressions(expression);
  return (
    ts.isPropertyAccessExpression(flag) &&
    /(?:^|_)DEBUG(?:_|$)/.test(flag.name.text) &&
    isProperty(flag.expression, 'process', 'env')
  );
}

function debugFlagReason(call, owner) {
  for (let child = call, parent = call.parent; parent !== owner; child = parent, parent = parent.parent) {
    if (ts.isIfStatement(parent) && child === parent.thenStatement && isDebugFlag(parent.expression)) {
      return 'Synchronous work runs only when the debug environment flag is enabled; check deployments using that flag.';
    }
  }
}

function isStartupHook(owner) {
  return ts.isMethodDeclaration(owner) && ts.isIdentifier(owner.name) && startupHooks.has(owner.name.text);
}

// A function that receives the Nest application wires it up once, before it serves traffic.
function configuresApplication(owner) {
  return owner.parameters.some((parameter) => parameter.type && applicationType.test(parameter.type.getText()));
}

function isPrivateEntryDeclaration(owner) {
  return (
    ts.isFunctionDeclaration(owner) &&
    !!owner.name &&
    ts.isSourceFile(owner.parent) &&
    !owner.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) &&
    privateProcessEntries(owner.parent).has(owner.name.text)
  );
}

function isUnitTestBody(owner, checker) {
  return (ts.isFunctionExpression(owner) || ts.isArrowFunction(owner)) && serialTestBody(owner, checker);
}

const entryPointReason =
  'One operation directly in a private process entry point; assess startup cost or concurrent work.';

// Reasons that only hold for a single operation, so a call inside a loop never qualifies.
function singleOperationReason(call, { checker, program }, moduleName, owner) {
  if (configuresApplication(owner)) {
    return 'Runs once while the application is configured; assess startup time rather than request latency.';
  }
  const beforeDetachedWork = call.pos < firstDetachedCall(owner);
  if (moduleName === 'fs' && beforeDetachedWork && runsOnlyInSchemaTooling(owner, program, checker)) {
    return 'Only called from the project’s configured schema-generation branch; assess tooling time.';
  }
  if ((isPrivateEntryDeclaration(owner) || isConstProcessEntry(owner)) && beforeDetachedWork) return entryPointReason;
  if (isUnitTestBody(owner, checker)) {
    return 'One operation directly in a unit-test body or suite hook; assess test-worker contention.';
  }
}

function ownerContext(call, context, moduleName, owner) {
  if (inPromiseCombinator(call, owner)) return;
  const debugReason = debugFlagReason(call, owner);
  if (debugReason) return debugReason;
  if (isStartupHook(owner)) {
    return 'Runs once from an application startup hook; assess boot time rather than request latency.';
  }
  if (!context.isRepeated(call)) return singleOperationReason(call, context, moduleName, owner);
}

// Why a blocking call is probably not on a request path, when the code shows it; `owner` is its async function, if any.
function contextualReason(call, context, moduleName, owner) {
  return pathContext(call, context.isRepeated) ?? (owner ? ownerContext(call, context, moduleName, owner) : undefined);
}

module.exports = { contextualReason, privateProcessEntries, requiredModule, rootRelativePath };
