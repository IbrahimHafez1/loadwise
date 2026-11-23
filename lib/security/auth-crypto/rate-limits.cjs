'use strict';

// auth-route-without-rate-limit: a credential endpoint is registered with no rate limiter in sight.
const { syntax: ts } = require('../../performance/compiler.cjs');
const { importedFrom } = require('../bindings.cjs');
const { unwrap, methodName } = require('../exposure/literals.cjs');

const ruleId = 'auth-route-without-rate-limit';
const message =
  'This login or credential endpoint has no rate limit, so attackers can try passwords and one-time codes without end (brute force, credential stuffing). Limit attempts per IP and per account with express-rate-limit, @nestjs/throttler or @fastify/rate-limit. A limit enforced by a gateway or proxy is fine: dismiss this with a review comment.';
const elsewhereReason =
  'A rate-limit package is used in a module this route is connected to by imports; confirm it covers this route (a gateway or proxy limit is also fine).';

const limiterPackages = [
  'express-rate-limit',
  'rate-limiter-flexible',
  'express-slow-down',
  '@fastify/rate-limit',
  'fastify-rate-limit',
  'hono-rate-limiter',
  '@nestjs/throttler',
];
const limiterModules = new Set(limiterPackages);
const limiterImport = new RegExp(`['"](?:${limiterPackages.map((name) => name.replace('/', '\\/')).join('|')})['"]`);
const limiterName = /rate-?limit|limiter|slow-?down|throttl/i;
// `app.use(limiter)`, `app.use('/api', rateLimit(...))`, `fastify.register(rateLimit)` in a file that imports a limiter.
const globalUse =
  /\.(?:use|register)\(\s*(?:['"`][^'"`]*['"`]\s*,\s*)?(?:await\s+)?[\w.]*(?:ratelimit|limiter|slowdown|throttl)/i;
const nestGlobalGuard = /APP_GUARD[\s\S]{0,120}Throttler|Throttler[\s\S]{0,120}APP_GUARD/;

const credentialPath =
  /(?<![a-z])(?:login|sign-?in|auth\/token|token|register|sign-?up|forgot-?password|reset-?password|password\/reset|verify-otp|otp|2fa|mfa)(?![a-z])/i;
const registrationMethods = new Set(['post', 'put', 'all']);
const nestMethodDecorators = new Set(['Post', 'Put', 'All']);
// Receivers that send requests rather than register routes.
const clientReceiver =
  /^(?:axios|https?|\w*client|api|request|agent|fetch|got|ky|superagent|supertest|cy|page|session)$/i;
const dataArgument = /^(?:body|data|payload|credentials|creds|params|form|user|dto)$/i;
const testFile = /(?:\.(?:test|spec)\.[cm]?[jt]sx?$|[\\/]__tests__[\\/])/;
const nestGuardDecorator = /^@(?:Throttle\b|UseGuards\([^)]*(?:Throttl|RateLimit|Limiter))/;

const programSummaries = new WeakMap();

const isProjectSource = (source) => !source.isDeclarationFile && !/[\\/]node_modules[\\/]/.test(source.fileName);

// Files each project file imports, as resolved by the program, plus the reverse edges.
function buildImportGraph(program, sources) {
  const imports = new Map();
  const importedBy = new Map();
  const options = program.getCompilerOptions();
  for (const source of sources) {
    for (const importNode of source.imports ?? []) {
      const mode = ts.getModeForUsageLocation(source, importNode, options);
      const target = program.getResolvedModule?.(source, importNode.text, mode)?.resolvedModule?.resolvedFileName;
      if (!target) continue;
      if (!imports.has(source.fileName)) imports.set(source.fileName, new Set());
      if (!importedBy.has(target)) importedBy.set(target, new Set());
      imports.get(source.fileName).add(target);
      importedBy.get(target).add(source.fileName);
    }
  }
  return { imports, importedBy };
}

function reachableFrom(start, edges) {
  const seen = new Set([start]);
  const queue = [start];
  while (queue.length) {
    for (const next of edges.get(queue.pop()) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  return seen;
}

// Cheap text scan, cached per program: which project files import a limiter, does one apply it, and how files import each other.
function summarizeProgram(program) {
  if (!program.getSourceFiles) return { limiterFiles: new Set(), applied: false, graph: undefined };
  if (!programSummaries.has(program)) {
    const sources = program.getSourceFiles().filter(isProjectSource);
    const limiterSources = sources.filter((source) => limiterImport.test(source.text));
    programSummaries.set(program, {
      limiterFiles: new Set(limiterSources.map((source) => source.fileName)),
      applied: limiterSources.some((source) => globalUse.test(source.text) || nestGlobalGuard.test(source.text)),
      graph: limiterSources.length ? buildImportGraph(program, sources) : undefined,
    });
  }
  return programSummaries.get(program);
}

// A limiter file counts as connected when it is the route's file, one the route's file imports, or app setup that imports it.
function limiterIsConnected(summary, routeFile) {
  if (!summary.limiterFiles.size) return false;
  const { imports, importedBy } = summary.graph;
  const connected = new Set([...reachableFrom(routeFile, imports), ...reachableFrom(routeFile, importedBy)]);
  return [...summary.limiterFiles].some((file) => connected.has(file));
}

function propertyNameOf(property) {
  return property.name && (ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name))
    ? property.name.text
    : undefined;
}

function isLimiter(expression, context, depth = 0) {
  const node = unwrap(expression);
  if (!node || depth > 3) return false;
  if (ts.isArrayLiteralExpression(node)) return node.elements.some((element) => isLimiter(element, context, depth + 1));
  if (ts.isObjectLiteralExpression(node)) return objectHasLimiter(node, context, depth + 1);
  if (ts.isCallExpression(node) || ts.isNewExpression(node)) return isLimiter(node.expression, context, depth + 1);
  if (ts.isPropertyAccessExpression(node))
    return limiterName.test(node.name.text) || isLimiter(node.expression, context, depth + 1);
  if (!ts.isIdentifier(node)) return false;
  if (limiterName.test(node.text) || limiterModules.has(importedFrom(node, context.checker)?.module)) return true;
  const declaration = context.checker.getSymbolAtLocation(node)?.valueDeclaration;
  return Boolean(
    declaration && ts.isVariableDeclaration(declaration) && isLimiter(declaration.initializer, context, depth + 1),
  );
}

// Fastify route options: `{ config: { rateLimit: { max: 5 } } }`.
function objectHasLimiter(object, context, depth) {
  return object.properties.some((property) => {
    const name = propertyNameOf(property);
    if (name && limiterName.test(name)) return true;
    return ts.isPropertyAssignment(property) && isLimiter(property.initializer, context, depth);
  });
}

function isHandler(argument) {
  const node = unwrap(argument);
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isPropertyAccessExpression(node)) return true;
  return ts.isIdentifier(node) && !dataArgument.test(node.text);
}

function receiverName(receiver) {
  const node = unwrap(receiver);
  if (ts.isIdentifier(node)) return node.text;
  return ts.isPropertyAccessExpression(node) ? node.name.text : undefined;
}

function pathOf(argument) {
  const node = unwrap(argument);
  return node && ts.isStringLiteralLike(node) ? node.text : undefined;
}

// { path, handlers } of `app.post('/login', ...)` or `router.route('/login').post(...)`, else undefined.
function routeRegistration(call, context) {
  const method = methodName(call);
  if (!registrationMethods.has(method)) return;
  const receiver = unwrap(unwrap(call.expression).expression);
  if (ts.isCallExpression(receiver)) {
    if (methodName(receiver) !== 'route') return;
    return { path: pathOf(receiver.arguments[0]), handlers: [...call.arguments] };
  }
  const name = receiverName(receiver);
  if (!name || clientReceiver.test(name) || importedFrom(receiver, context.checker)?.module === 'axios') return;
  const [path, ...handlers] = call.arguments;
  return { path: pathOf(path), handlers };
}

function checkRoute(call, context) {
  const registration = routeRegistration(call, context);
  if (!registration?.path || !credentialPath.test(registration.path)) return;
  const { handlers } = registration;
  if (!handlers.length || !isHandler(handlers[handlers.length - 1])) return;
  if (handlers.some((handler) => isLimiter(handler, context))) return;
  reportUnlimited(call, context);
}

function reportUnlimited(node, context) {
  const summary = summarizeProgram(context.program);
  if (summary.applied) return;
  if (limiterIsConnected(summary, node.getSourceFile().fileName))
    context.report(node, ruleId, message, elsewhereReason);
  else context.report(node, ruleId, message);
}

function decoratorsOf(node) {
  return ts.canHaveDecorators(node) ? (ts.getDecorators(node) ?? []) : [];
}

function hasNestLimiter(node) {
  return decoratorsOf(node).some((decorator) => nestGuardDecorator.test(decorator.getText()));
}

function controllerPath(classNode) {
  for (const decorator of decoratorsOf(classNode)) {
    const expression = decorator.expression;
    if (
      ts.isCallExpression(expression) &&
      ts.isIdentifier(expression.expression) &&
      expression.expression.text === 'Controller'
    )
      return pathOf(expression.arguments[0]) ?? '';
  }
  return '';
}

// `@Post('login')` on a controller method.
function checkNestRoute(call, context) {
  const decorator = call.parent;
  const method = decorator.parent;
  const callee = unwrap(call.expression);
  if (!ts.isIdentifier(callee) || !nestMethodDecorators.has(callee.text)) return;
  if (importedFrom(callee, context.checker)?.module !== '@nestjs/common' || !ts.isMethodDeclaration(method)) return;
  const classNode = method.parent;
  const fullPath = `${controllerPath(classNode)}/${pathOf(call.arguments[0]) ?? ''}`;
  if (!credentialPath.test(fullPath) || hasNestLimiter(method) || hasNestLimiter(classNode)) return;
  reportUnlimited(call, context);
}

function checkCall(call, context) {
  if (testFile.test(call.getSourceFile().fileName)) return;
  if (call.parent && ts.isDecorator(call.parent)) checkNestRoute(call, context);
  else checkRoute(call, context);
}

module.exports = { checkCall };
