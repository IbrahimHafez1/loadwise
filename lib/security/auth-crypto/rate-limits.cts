// auth-route-without-rate-limit: a credential endpoint is registered with no rate limiter in sight.
import { loadSyntax } from '../../performance/compiler.cjs';
import { importedFrom } from '../bindings.cjs';
import { unwrap, methodName } from '../exposure/literals.cjs';
import { isProjectSource } from '../taint/summaries.cjs';
import type {
  CallExpression,
  Decorator,
  Expression,
  Node,
  ObjectLiteralElementLike,
  ObjectLiteralExpression,
  ResolutionMode,
  SourceFile,
} from 'typescript';
import type { CheckerAdapter, ProgramAdapter, SecurityRuleContext } from '../../shared/types.cjs';
const ts = loadSyntax();

const ruleId = 'auth-route-without-rate-limit';
const message =
  'This login or credential endpoint has no rate limit, so attackers can try passwords and one-time codes without end (brute force, credential stuffing). Limit attempts per IP and per account with express-rate-limit, @nestjs/throttler or @fastify/rate-limit. A limit enforced by a gateway or proxy is fine: dismiss this with a review comment.';
const elsewhereReason =
  'A rate-limit package is used in a module this route is connected to by imports; confirm it covers this route (a gateway or proxy limit is also fine).';
const otherReceiverReason =
  'A rate limiter is applied to another app or router in this file; confirm this route passes through it (a gateway or proxy limit is also fine).';

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
// `app.use(limiter)`, `app.use('/api', rateLimit(...))`, `fastify.register(rateLimit)` in a file
// that imports a limiter.
const globalUse =
  /\.(?:use|register)\(\s*(?:['"`][^'"`]*['"`]\s*,\s*)?(?:await\s+)?[\w.]*(?:ratelimit|limiter|slowdown|throttl)/i;
const nestGlobalGuard = /APP_GUARD[\s\S]{0,120}Throttler|Throttler[\s\S]{0,120}APP_GUARD/;
const middlewareCall = /\.(?:use|register)\s*\(/;
const middlewareMethods = new Set(['use', 'register']);
// Router mounts followed upwards from a route's router to an app that applies a limiter.
const maxMountDepth = 4;

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

// Files that import each other, by file name.
interface ImportGraph {
  imports: Map<string, Set<string>>;
  importedBy: Map<string, Set<string>>;
}

// Where limiters are applied, keyed by the declaration of the app or router, and how routers are
// mounted on apps.
interface MiddlewareUses {
  limited: Map<Node, Set<string>>;
  mounts: Map<Node, Set<Node>>;
}

interface ProgramSummary extends MiddlewareUses {
  limiterFiles: Set<string>;
  appliedFiles: Set<string>;
  graph: ImportGraph | undefined;
}

// What the checks need of a rule context when they run outside the analyzer's per-file walk.
interface CheckerHolder {
  checker: CheckerAdapter;
}

// The TypeScript 6 program resolves modules itself; the native adapter does not.
interface ModuleResolvingProgram extends ProgramAdapter {
  getResolvedModule?(
    file: SourceFile,
    moduleName: string,
    mode: ResolutionMode,
  ): { resolvedModule?: { resolvedFileName: string } } | undefined;
}

const programSummaries = new WeakMap<ProgramAdapter, ProgramSummary>();

function setFor<Key, Item>(map: Map<Key, Set<Item>>, key: Key): Set<Item> {
  let items = map.get(key);
  if (!items) map.set(key, (items = new Set<Item>()));
  return items;
}

// Files each project file imports, as resolved by the program, plus the reverse edges. The
// TypeScript 7 program has no module resolution API, so there the checker's module symbol for the
// specifier names the file.
function buildImportGraph(program: ModuleResolvingProgram, sources: readonly SourceFile[]): ImportGraph {
  const imports = new Map<string, Set<string>>();
  const importedBy = new Map<string, Set<string>>();
  const options = program.getCompilerOptions();
  const checker = program.getTypeChecker();
  for (const source of sources) {
    for (const importNode of source.imports ?? []) {
      const target = program.getResolvedModule
        ? program.getResolvedModule(source, importNode.text, ts.getModeForUsageLocation(source, importNode, options))
            ?.resolvedModule?.resolvedFileName
        : resolvedSourceFile(checker.getSymbolAtLocation(importNode)?.declarations?.[0]);
      if (!target) continue;
      setFor(imports, source.fileName).add(target);
      setFor(importedBy, target).add(source.fileName);
    }
  }
  return { imports, importedBy };
}

function resolvedSourceFile(declaration: Node | undefined) {
  return declaration && ts.isSourceFile(declaration) ? declaration.fileName : undefined;
}

function reachableFrom(start: string, edges: ReadonlyMap<string, ReadonlySet<string>>) {
  const seen = new Set([start]);
  const queue = [start];
  for (let current = queue.pop(); current !== undefined; current = queue.pop()) {
    for (const next of edges.get(current) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  return seen;
}

// Cached per program: which project files import a limiter, which of them apply one by a text scan,
// the apps and routers a limiter is applied to, the router mounts, and how files import each other.
function summarizeProgram(program: ProgramAdapter): ProgramSummary {
  const cached = programSummaries.get(program);
  if (cached) return cached;
  const sources = (program.getSourceFiles?.() ?? program.getToolingSourceFiles?.() ?? []).filter(isProjectSource);
  const limiterSources = sources.filter((source) => limiterImport.test(source.text));
  const appliedSources = limiterSources.filter(
    (source) => globalUse.test(source.text) || nestGlobalGuard.test(source.text),
  );
  const summary: ProgramSummary = {
    limiterFiles: new Set(limiterSources.map((source) => source.fileName)),
    appliedFiles: new Set(appliedSources.map((source) => source.fileName)),
    ...middlewareUses(program, sources),
    graph: limiterSources.length ? buildImportGraph(program, sources) : undefined,
  };
  programSummaries.set(program, summary);
  return summary;
}

// `app.use(limiter)` and `fastify.register(rateLimit)` keyed by the declaration of the app or
// router they apply to, with the files they are in; `app.use('/auth', authRouter)` mounts as router
// declaration -> app declarations.
function middlewareUses(program: ProgramAdapter, sources: readonly SourceFile[]): MiddlewareUses {
  const context: CheckerHolder = { checker: program.getTypeChecker() };
  const limited = new Map<Node, Set<string>>();
  const mounts = new Map<Node, Set<Node>>();
  for (const source of sources) {
    if (!middlewareCall.test(source.text)) continue;
    (function visit(node: Node): void {
      const method = ts.isCallExpression(node) ? methodName(node) : undefined;
      const callee = ts.isCallExpression(node) ? unwrap(node.expression) : undefined;
      if (
        ts.isCallExpression(node) &&
        method !== undefined &&
        middlewareMethods.has(method) &&
        callee &&
        ts.isPropertyAccessExpression(callee)
      ) {
        const target = receiverDeclaration(callee.expression, context.checker);
        if (target) recordUse(node, target, context, limited, mounts);
      }
      ts.forEachChild(node, visit);
    })(source);
  }
  return { limited, mounts };
}

function recordUse(
  call: CallExpression,
  target: Node,
  context: CheckerHolder,
  limited: Map<Node, Set<string>>,
  mounts: Map<Node, Set<Node>>,
) {
  for (const argument of call.arguments) {
    if (isLimiter(argument, context)) {
      setFor(limited, target).add(call.getSourceFile().fileName);
      continue;
    }
    const mounted = isReference(argument) && receiverDeclaration(argument, context.checker);
    if (!mounted) continue;
    setFor(mounts, mounted).add(target);
  }
}

function isReference(argument: Expression) {
  const node = unwrap(argument);
  return ts.isIdentifier(node) || ts.isPropertyAccessExpression(node);
}

// The declaration an app or router expression names, through imports, so `app` in a route file and
// the `app` exported by the setup file compare equal.
function receiverDeclaration(expression: Expression, checker: CheckerAdapter): Node | undefined {
  const node = unwrap(expression);
  const name = ts.isIdentifier(node) ? node : ts.isPropertyAccessExpression(node) ? node.name : undefined;
  let symbol = name && checker.getSymbolAtLocation(name);
  if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
  return symbol?.valueDeclaration ?? symbol?.declarations?.[0];
}

// The route's app or router applies a limiter, or an app or router it is mounted on does.
function limitedReceiver(summary: ProgramSummary, receiver: Node) {
  const seen = new Set([receiver]);
  let current = [receiver];
  for (let depth = 0; depth <= maxMountDepth && current.length; depth++) {
    if (current.some((declaration) => summary.limited.has(declaration))) return true;
    current = current
      .flatMap((declaration) => [...(summary.mounts.get(declaration) ?? [])])
      .filter((parent) => !seen.has(parent) && seen.add(parent));
  }
  return false;
}

function appliedInFile(summary: ProgramSummary, fileName: string) {
  return [...summary.limited.values()].some((files) => files.has(fileName));
}

// A limiter file counts as connected when it is the route's file, one the route's file imports, or
// app setup that imports it.
function limiterIsConnected(summary: ProgramSummary, routeFile: string) {
  if (!summary.limiterFiles.size || !summary.graph) return false;
  const { imports, importedBy } = summary.graph;
  const connected = new Set([...reachableFrom(routeFile, imports), ...reachableFrom(routeFile, importedBy)]);
  return [...summary.limiterFiles].some((file) => connected.has(file));
}

function propertyNameOf(property: ObjectLiteralElementLike) {
  return property.name && (ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name))
    ? property.name.text
    : undefined;
}

function isLimiter(expression: Expression | undefined, context: CheckerHolder, depth = 0): boolean {
  const node = unwrap(expression);
  if (!node || depth > 3) return false;
  if (ts.isArrayLiteralExpression(node)) return node.elements.some((element) => isLimiter(element, context, depth + 1));
  if (ts.isObjectLiteralExpression(node)) return objectHasLimiter(node, context, depth + 1);
  if (ts.isCallExpression(node) || ts.isNewExpression(node)) return isLimiter(node.expression, context, depth + 1);
  if (ts.isPropertyAccessExpression(node))
    return limiterName.test(node.name.text) || isLimiter(node.expression, context, depth + 1);
  if (!ts.isIdentifier(node)) return false;
  const module = importedFrom(node, context.checker)?.module;
  if (limiterName.test(node.text) || (module !== undefined && limiterModules.has(module))) return true;
  const declaration = context.checker.getSymbolAtLocation(node)?.valueDeclaration;
  return Boolean(
    declaration && ts.isVariableDeclaration(declaration) && isLimiter(declaration.initializer, context, depth + 1),
  );
}

// Fastify route options: `{ config: { rateLimit: { max: 5 } } }`.
function objectHasLimiter(object: ObjectLiteralExpression, context: CheckerHolder, depth: number): boolean {
  return object.properties.some((property) => {
    const name = propertyNameOf(property);
    if (name && limiterName.test(name)) return true;
    return ts.isPropertyAssignment(property) && isLimiter(property.initializer, context, depth);
  });
}

function isHandler(argument: Expression) {
  const node = unwrap(argument);
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isPropertyAccessExpression(node)) return true;
  return ts.isIdentifier(node) && !dataArgument.test(node.text);
}

function receiverName(receiver: Expression) {
  const node = unwrap(receiver);
  if (ts.isIdentifier(node)) return node.text;
  return ts.isPropertyAccessExpression(node) ? node.name.text : undefined;
}

function pathOf(argument: Expression | undefined) {
  const node = unwrap(argument);
  return node && ts.isStringLiteralLike(node) ? node.text : undefined;
}

// { path, handlers, receiver } of `app.post('/login', ...)` or `router.route('/login').post(...)`,
// else undefined.
interface RouteRegistration {
  path: string | undefined;
  handlers: Expression[];
  receiver: Expression;
}

function routeRegistration(call: CallExpression, context: SecurityRuleContext): RouteRegistration | undefined {
  const method = methodName(call);
  const callee = unwrap(call.expression);
  if (!method || !registrationMethods.has(method) || !ts.isPropertyAccessExpression(callee)) return;
  const receiver = unwrap(callee.expression);
  if (ts.isCallExpression(receiver)) {
    const routeCallee = unwrap(receiver.expression);
    if (methodName(receiver) !== 'route' || !ts.isPropertyAccessExpression(routeCallee)) return;
    return { path: pathOf(receiver.arguments[0]), handlers: [...call.arguments], receiver: routeCallee.expression };
  }
  const name = receiverName(receiver);
  if (!name || clientReceiver.test(name) || importedFrom(receiver, context.checker)?.module === 'axios') return;
  const [path, ...handlers] = call.arguments;
  return { path: pathOf(path), handlers, receiver };
}

function checkRoute(call: CallExpression, context: SecurityRuleContext) {
  const registration = routeRegistration(call, context);
  if (!registration?.path || !credentialPath.test(registration.path)) return;
  const { handlers } = registration;
  if (!handlers.length || !isHandler(handlers[handlers.length - 1])) return;
  if (handlers.some((handler) => isLimiter(handler, context))) return;
  reportUnlimited(call, context, receiverDeclaration(registration.receiver, context.checker));
}

// Silent when the route's own app or router applies a limiter. A limiter applied in another file
// cannot be tied to this route's app, so the text scan of those files still accepts it; one applied
// in this file covers something else. A Nest route has no receiver, and a global throttler guard
// covers every controller.
function reportUnlimited(node: Node, context: SecurityRuleContext, receiver?: Node) {
  const summary = summarizeProgram(context.program);
  if (receiver && limitedReceiver(summary, receiver)) return;
  const fileName = node.getSourceFile().fileName;
  if ([...summary.appliedFiles].some((file) => !receiver || file !== fileName)) return;
  if (summary.appliedFiles.has(fileName) || appliedInFile(summary, fileName))
    context.report(node, ruleId, message, otherReceiverReason);
  else if (limiterIsConnected(summary, fileName)) context.report(node, ruleId, message, elsewhereReason);
  else context.report(node, ruleId, message);
}

function decoratorsOf(node: Node) {
  return ts.canHaveDecorators(node) ? (ts.getDecorators(node) ?? []) : [];
}

function hasNestLimiter(node: Node) {
  return decoratorsOf(node).some((decorator: Decorator) => nestGuardDecorator.test(decorator.getText()));
}

function controllerPath(classNode: Node) {
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
function checkNestRoute(call: CallExpression, context: SecurityRuleContext) {
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

function checkCall(call: CallExpression, context: SecurityRuleContext) {
  if (testFile.test(call.getSourceFile().fileName)) return;
  if (call.parent && ts.isDecorator(call.parent)) checkNestRoute(call, context);
  else checkRoute(call, context);
}

export { checkCall };
