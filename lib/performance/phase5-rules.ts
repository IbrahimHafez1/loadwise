// Phase 5 performance rules:
// - unbounded-promise-all
// - mongoose-missing-lean
// - graphql-n-plus-one-resolver
// - react-context-value-recreated
// - node-event-listener-leak
// - json-stringify-in-loop
import { ts } from './compiler.js';
import { enclosingRequestHandler } from './request-handlers.js';
import { isTestSource } from './review-context.js';
import { declaredInPackage, propertyName } from './schema/ts-helpers.js';
import { classifyExecutionContext } from '../shared/execution-context.js';
import type {
  ArrowFunction,
  CallExpression,
  Expression,
  FunctionExpression,
  JsxOpeningElement,
  JsxSelfClosingElement,
  MethodDeclaration,
  Node,
  ObjectLiteralExpression,
  PropertyAccessExpression,
  SourceFile,
} from 'typescript';
import type { PerformanceRuleContext } from '../shared/types.js';

const MONGOOSE_PACKAGES = ['mongoose'];
const MONGOOSE_FIND_METHODS = new Set(['find', 'findOne', 'findById']);
const MONGOOSE_QUERY_MODIFIERS = new Set([
  'select',
  'sort',
  'limit',
  'skip',
  'where',
  'populate',
  'session',
  'exec',
  'lean',
  'collation',
  'hint',
  'maxTimeMS',
  'read',
  'batchSize',
]);
const MONGOOSE_MUTATION_METHODS = new Set(['save', 'markModified', 'remove', 'deleteOne']);
const SERIALIZATION_METHODS = new Set(['json', 'send', 'jsonp']);
const RESPONSE_RECEIVERS = /^(?:res|response|reply|ctx|c|NextResponse|Response)$/;

const ARRAY_LOOP_METHODS = new Set(['forEach', 'map', 'reduce', 'flatMap', 'filter']);
const EVENT_ADD_METHODS = new Set(['on', 'addListener', 'addEventListener']);
const EVENT_REMOVE_METHODS = new Set(['off', 'removeListener', 'removeEventListener']);
const LIFECYCLE_HOOKS = new Set(['useEffect', 'useLayoutEffect', 'onMounted', 'onBeforeMount']);
const REQUEST_SCOPED_EMITTERS = new Set([
  'req',
  '_req',
  'request',
  '_request',
  'res',
  '_res',
  'response',
  '_response',
  'reply',
  '_reply',
  'socket',
  'stream',
]);

const CONCURRENCY_LIMITER_PACKAGES = new Set([
  'p-limit',
  'p-map',
  '@supercharge/promise-pool',
  'bottleneck',
  'p-queue',
]);
const CONCURRENCY_LIMITER_NAMES = /^(?:pLimit|limit|limiter|concurrencyLimit|pMap|PromisePool)$/i;

const GQL_ROOT_TYPES = new Set(['Query', 'Mutation', 'Subscription']);
const GQL_DECORATORS = new Set(['ResolveField', 'ResolveProperty']);
const DB_HTTP_METHODS = new Set([
  'findMany',
  'findUnique',
  'findFirst',
  'findOne',
  'findById',
  'findByPk',
  'find',
  'query',
  'execute',
  'select',
  'get',
  'post',
  'put',
  'patch',
  'delete',
]);
const HTTP_RECEIVERS = new Set(['axios', 'got', 'ky', 'undici', 'http', 'https']);

function isStatementLoop(node: Node): boolean {
  return (
    ts.isForStatement(node) ||
    ts.isForOfStatement(node) ||
    ts.isForInStatement(node) ||
    ts.isWhileStatement(node) ||
    ts.isDoStatement(node)
  );
}

function isArrayIterationCallback(node: Node): boolean {
  if (!ts.isArrowFunction(node) && !ts.isFunctionExpression(node)) return false;
  const parent = node.parent;
  if (!parent || !ts.isCallExpression(parent) || !ts.isPropertyAccessExpression(parent.expression)) return false;
  return ARRAY_LOOP_METHODS.has(parent.expression.name.text) && parent.arguments[0] === node;
}

function enclosingLoop(node: Node): Node | undefined {
  let current: Node | undefined = node.parent;
  while (current) {
    if (isStatementLoop(current)) return current;
    if (isArrayIterationCallback(current)) return current.parent;
    if (ts.isFunctionLike(current)) return undefined;
    current = current.parent;
  }
  return undefined;
}

function containsMatchingNode(root: Node, predicate: (node: Node) => boolean, stopAtFunctions = true): boolean {
  let found = false;
  function visit(node: Node): void {
    if (found) return;
    if (predicate(node)) {
      found = true;
      return;
    }
    if (stopAtFunctions && node !== root && ts.isFunctionLike(node)) return;
    ts.forEachChild(node, visit);
  }
  visit(root);
  return found;
}

// --- Rule 1: unbounded-promise-all ---------------------------------------------------------------

function hasConcurrencyLimiterImport(sourceFile: SourceFile): boolean {
  for (const stmt of sourceFile.statements) {
    if (ts.isImportDeclaration(stmt) && ts.isStringLiteral(stmt.moduleSpecifier)) {
      if (CONCURRENCY_LIMITER_PACKAGES.has(stmt.moduleSpecifier.text)) return true;
    }
  }
  return false;
}

function isChunkingLoop(loopNode: Node): boolean {
  if (!isStatementLoop(loopNode)) return false;
  return containsMatchingNode(
    loopNode,
    (node) =>
      (ts.isPropertyAccessExpression(node) && node.name.text === 'slice') ||
      (ts.isIdentifier(node) && /(?:chunk|batch)/i.test(node.text)),
    false,
  );
}

function usesConcurrencyLimiter(arg: Expression, sourceFile: SourceFile): boolean {
  const hasLimiterCall = containsMatchingNode(
    arg,
    (node) =>
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      CONCURRENCY_LIMITER_NAMES.test(node.expression.text),
    false,
  );
  if (hasLimiterCall) return true;
  if (!hasConcurrencyLimiterImport(sourceFile)) return false;
  return containsMatchingNode(arg, (node) => ts.isCallExpression(node) && ts.isIdentifier(node.expression), false);
}

function isUnboundedCollection(arg: Expression): boolean {
  return containsMatchingNode(
    arg,
    (node) =>
      (ts.isIdentifier(node) && /^(?:req|request)$/.test(node.text)) ||
      (ts.isPropertyAccessExpression(node) && /^(?:findMany|find|readdir)$/.test(node.name.text)),
    false,
  );
}

const DB_QUERY_METHODS = new Set([
  'query',
  'execute',
  'findUnique',
  'findUniqueOrThrow',
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'findOne',
  'findById',
]);

function isDbQueryInMap(arg: Expression): boolean {
  if (!ts.isCallExpression(arg) || !ts.isPropertyAccessExpression(arg.expression)) return false;
  if (arg.expression.name.text !== 'map') return false;
  return containsMatchingNode(
    arg,
    (node) =>
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      DB_QUERY_METHODS.has(node.expression.name.text),
    false,
  );
}

function checkUnboundedPromiseAll(
  call: CallExpression,
  sourceFile: SourceFile,
  context: PerformanceRuleContext,
  cliReason?: string,
): void {
  const callee = ts.skipOuterExpressions(call.expression);
  if (
    !ts.isPropertyAccessExpression(callee) ||
    !ts.isIdentifier(callee.expression) ||
    callee.expression.text !== 'Promise' ||
    callee.name.text !== 'all' ||
    call.arguments.length === 0
  ) {
    return;
  }
  const arg = ts.skipOuterExpressions(call.arguments[0]);
  if (ts.isArrayLiteralExpression(arg)) return;
  const loop = enclosingLoop(call);
  if (loop && isChunkingLoop(loop)) return;
  if (usesConcurrencyLimiter(arg, sourceFile)) return;
  if (isDbQueryInMap(arg)) return;
  if (ts.isCallExpression(arg) && !isUnboundedCollection(arg)) return;
  const reason = cliReason;
  context.report(
    call,
    'unbounded-promise-all',
    'Promise.all runs over an unbounded collection without a concurrency limit, risking memory spikes or downstream saturation.',
    reason,
  );
}

// --- Rule 2: mongoose-missing-lean ---------------------------------------------------------------

function hasMongooseImport(sourceFile: SourceFile): boolean {
  return sourceFile.statements.some(
    (stmt) =>
      ts.isImportDeclaration(stmt) &&
      ts.isStringLiteral(stmt.moduleSpecifier) &&
      stmt.moduleSpecifier.text === 'mongoose',
  );
}

function isMongooseReadCall(
  call: CallExpression,
  callee: PropertyAccessExpression,
  sourceFile: SourceFile,
  context: PerformanceRuleContext,
): boolean {
  if (!MONGOOSE_FIND_METHODS.has(callee.name.text)) return false;
  if (declaredInPackage(callee, context.checker, MONGOOSE_PACKAGES)) return true;
  if (!hasMongooseImport(sourceFile)) return false;
  const firstArg = call.arguments[0];
  if (firstArg && (ts.isArrowFunction(firstArg) || ts.isFunctionExpression(firstArg))) return false;
  return true;
}

function unwrapQueryChain(call: CallExpression): { outer: Node; hasLean: boolean } {
  let current: Node = call;
  let hasLean = false;
  while (current.parent) {
    if (!ts.isPropertyAccessExpression(current.parent) || current.parent.expression !== current) break;
    const nextCall = current.parent.parent;
    if (!nextCall || !ts.isCallExpression(nextCall) || nextCall.expression !== current.parent) break;
    const method = current.parent.name.text;
    if (method === 'lean') hasLean = true;
    if (!MONGOOSE_QUERY_MODIFIERS.has(method)) break;
    current = nextCall;
  }
  let outer: Node = current;
  while (outer.parent && (ts.isAwaitExpression(outer.parent) || ts.isParenthesizedExpression(outer.parent))) {
    outer = outer.parent;
  }
  return { outer, hasLean };
}

function isJsonSerializationCall(node: Node, argNode: Node): boolean {
  if (!ts.isCallExpression(node) || !node.arguments.some((arg) => arg === argNode)) return false;
  const callee = ts.skipOuterExpressions(node.expression);
  if (!ts.isPropertyAccessExpression(callee)) return false;
  if (ts.isIdentifier(callee.expression) && callee.expression.text === 'JSON' && callee.name.text === 'stringify') {
    return true;
  }
  return (
    SERIALIZATION_METHODS.has(callee.name.text) &&
    ts.isIdentifier(callee.expression) &&
    RESPONSE_RECEIVERS.test(callee.expression.text)
  );
}

function isDirectReadReturnOrSerialize(outer: Node): boolean {
  const parent = outer.parent;
  if (!parent) return false;
  if (ts.isReturnStatement(parent) && parent.expression === outer) return true;
  if (ts.isArrowFunction(parent) && parent.body === outer) return true;
  if (ts.isExpression(outer) && isJsonSerializationCall(parent, outer)) return true;
  return false;
}

function isVariableReturnedOrSerialized(varName: string, scope: Node): boolean {
  let mutated = false;
  let returnedOrSerialized = false;
  function visit(node: Node): void {
    if (mutated) return;
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === varName &&
      MONGOOSE_MUTATION_METHODS.has(node.expression.name.text)
    ) {
      mutated = true;
      return;
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(node.left) &&
      ts.isIdentifier(node.left.expression) &&
      node.left.expression.text === varName
    ) {
      mutated = true;
      return;
    }
    if (
      ts.isReturnStatement(node) &&
      node.expression &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === varName
    ) {
      returnedOrSerialized = true;
    }
    if (ts.isCallExpression(node)) {
      for (const arg of node.arguments) {
        if (ts.isIdentifier(arg) && arg.text === varName && isJsonSerializationCall(node, arg)) {
          returnedOrSerialized = true;
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(scope);
  return !mutated && returnedOrSerialized;
}

function checkMongooseMissingLean(call: CallExpression, sourceFile: SourceFile, context: PerformanceRuleContext): void {
  const callee = ts.skipOuterExpressions(call.expression);
  if (!ts.isPropertyAccessExpression(callee)) return;
  if (!isMongooseReadCall(call, callee, sourceFile, context)) return;
  const { outer, hasLean } = unwrapQueryChain(call);
  if (hasLean) return;
  if (isDirectReadReturnOrSerialize(outer)) {
    context.report(
      call,
      'mongoose-missing-lean',
      'Mongoose read query is returned or serialized without .lean(), paying full Document hydration overhead.',
    );
    return;
  }
  const decl = outer.parent;
  if (decl && ts.isVariableDeclaration(decl) && decl.initializer === outer && ts.isIdentifier(decl.name)) {
    const scope = ts.findAncestor(decl, ts.isFunctionLike) ?? sourceFile;
    if (isVariableReturnedOrSerialized(decl.name.text, scope)) {
      context.report(
        call,
        'mongoose-missing-lean',
        'Mongoose read query is returned or serialized without .lean(), paying full Document hydration overhead.',
      );
    }
  }
}

// --- Rule 3: graphql-n-plus-one-resolver ---------------------------------------------------------

function hasResolveFieldDecorator(node: MethodDeclaration): boolean {
  if (!node.modifiers) return false;
  for (const mod of node.modifiers) {
    if (!ts.isDecorator(mod)) continue;
    const expr = ts.skipOuterExpressions(mod.expression);
    if (ts.isIdentifier(expr) && GQL_DECORATORS.has(expr.text)) return true;
    if (ts.isCallExpression(expr) && ts.isIdentifier(expr.expression) && GQL_DECORATORS.has(expr.expression.text)) {
      return true;
    }
  }
  return false;
}

function isResolverMapField(fn: MethodDeclaration | FunctionExpression | ArrowFunction): boolean {
  const prop = fn.parent;
  if (!prop) return false;
  let fieldObject: ObjectLiteralExpression | undefined;
  if (ts.isMethodDeclaration(fn) && ts.isObjectLiteralExpression(prop)) {
    fieldObject = prop;
  } else if (ts.isPropertyAssignment(prop) && prop.initializer === fn && ts.isObjectLiteralExpression(prop.parent)) {
    fieldObject = prop.parent;
  }
  if (!fieldObject) return false;
  const typeProp = fieldObject.parent;
  if (!typeProp || !ts.isPropertyAssignment(typeProp) || typeProp.initializer !== fieldObject) return false;
  const typeName = propertyName(typeProp);
  if (!typeName || GQL_ROOT_TYPES.has(typeName)) return false;
  const resolverMap = typeProp.parent;
  if (!ts.isObjectLiteralExpression(resolverMap)) return false;
  const owner = resolverMap.parent;
  if (ts.isVariableDeclaration(owner) && ts.isIdentifier(owner.name) && /resolver/i.test(owner.name.text)) {
    return true;
  }
  return (
    fn.parameters.length >= 1 &&
    ts.isIdentifier(fn.parameters[0].name) &&
    /^(?:parent|root)$/.test(fn.parameters[0].name.text)
  );
}

function isGraphqlFieldResolver(node: Node): node is MethodDeclaration | FunctionExpression | ArrowFunction {
  if (ts.isMethodDeclaration(node) && hasResolveFieldDecorator(node)) return true;
  if (ts.isMethodDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)) {
    return isResolverMapField(node);
  }
  return false;
}

function usesDataLoader(fn: Node): boolean {
  return containsMatchingNode(
    fn,
    (node) =>
      (ts.isIdentifier(node) && /dataloader/i.test(node.text)) ||
      (ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        (node.expression.name.text === 'load' || node.expression.name.text === 'loadMany')),
    false,
  );
}

function isDbOrHttpCall(node: Node): node is CallExpression {
  if (!ts.isCallExpression(node)) return false;
  const callee = ts.skipOuterExpressions(node.expression);
  if (ts.isIdentifier(callee)) return callee.text === 'fetch' || callee.text === 'knex';
  if (!ts.isPropertyAccessExpression(callee)) return false;
  const method = callee.name.text;
  if (!DB_HTTP_METHODS.has(method)) return false;
  if (method === 'find' || method === 'select') {
    const firstArg = node.arguments[0];
    if (firstArg && (ts.isArrowFunction(firstArg) || ts.isFunctionExpression(firstArg))) return false;
  }
  if (ts.isIdentifier(callee.expression) && HTTP_RECEIVERS.has(callee.expression.text)) return true;
  return true;
}

function checkGraphqlNPlusOneResolver(
  node: MethodDeclaration | FunctionExpression | ArrowFunction,
  context: PerformanceRuleContext,
): void {
  if (!node.body || !isGraphqlFieldResolver(node)) return;
  if (usesDataLoader(node.body)) return;
  let queryCall: CallExpression | undefined;
  function findQuery(current: Node): void {
    if (queryCall) return;
    if (isDbOrHttpCall(current)) {
      queryCall = current;
      return;
    }
    ts.forEachChild(current, findQuery);
  }
  findQuery(node.body);
  if (queryCall) {
    context.report(
      queryCall,
      'graphql-n-plus-one-resolver',
      'GraphQL field resolver executes a database or HTTP query per parent item without DataLoader batching.',
    );
  }
}

// --- Rule 4: react-context-value-recreated -------------------------------------------------------

function checkReactContextValueRecreated(
  node: JsxOpeningElement | JsxSelfClosingElement,
  context: PerformanceRuleContext,
): void {
  if (!ts.isPropertyAccessExpression(node.tagName) || node.tagName.name.text !== 'Provider') return;
  for (const attr of node.attributes.properties) {
    if (!ts.isJsxAttribute(attr) || !ts.isIdentifier(attr.name) || attr.name.text !== 'value') continue;
    if (!attr.initializer || !ts.isJsxExpression(attr.initializer) || !attr.initializer.expression) continue;
    const expr = ts.skipOuterExpressions(attr.initializer.expression);
    if (ts.isObjectLiteralExpression(expr) || ts.isArrayLiteralExpression(expr)) {
      context.report(
        attr,
        'react-context-value-recreated',
        'Inline object or array literal in Context.Provider value creates a new reference on every render; wrap it in useMemo.',
      );
    }
  }
}

// --- Rule 5: node-event-listener-leak ------------------------------------------------------------

function hasOnceOrSignalOption(call: CallExpression): boolean {
  const options = call.arguments[2];
  if (!options) return false;
  const expr = ts.skipOuterExpressions(options);
  if (!ts.isObjectLiteralExpression(expr)) return false;
  return expr.properties.some((prop) => {
    const name = propertyName(prop);
    if (name === 'signal') return true;
    return name === 'once' && ts.isPropertyAssignment(prop) && prop.initializer.kind === ts.SyntaxKind.TrueKeyword;
  });
}

function enclosingHookCallback(node: Node): Node | undefined {
  let current: Node | undefined = node.parent;
  while (current) {
    if (
      (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) &&
      current.parent &&
      ts.isCallExpression(current.parent)
    ) {
      const hookCallee = ts.skipOuterExpressions(current.parent.expression);
      if (ts.isIdentifier(hookCallee) && LIFECYCLE_HOOKS.has(hookCallee.text)) {
        return current;
      }
    }
    current = current.parent;
  }
  return undefined;
}

function hasListenerCleanup(scope: Node): boolean {
  return containsMatchingNode(
    scope,
    (node) =>
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      EVENT_REMOVE_METHODS.has(node.expression.name.text),
    false,
  );
}

function checkNodeEventListenerLeak(call: CallExpression, context: PerformanceRuleContext): void {
  const callee = ts.skipOuterExpressions(call.expression);
  if (!ts.isPropertyAccessExpression(callee) || !EVENT_ADD_METHODS.has(callee.name.text)) return;
  if (callee.name.text === 'addEventListener' && hasOnceOrSignalOption(call)) return;
  const hook = enclosingHookCallback(call);
  const loop = enclosingLoop(call);
  const handler = enclosingRequestHandler(call);
  if (!hook && !loop && !handler) return;
  if (
    handler &&
    !loop &&
    !hook &&
    ts.isIdentifier(callee.expression) &&
    REQUEST_SCOPED_EMITTERS.has(callee.expression.text)
  ) {
    return;
  }
  const cleanupScope = hook ?? ts.findAncestor(call, ts.isFunctionLike);
  if (cleanupScope && hasListenerCleanup(cleanupScope)) return;
  context.report(
    call,
    'node-event-listener-leak',
    'Event listener registered inside a repeated or per-request context without matching cleanup leaks listeners over time.',
  );
}

// --- Rule 6: json-stringify-in-loop --------------------------------------------------------------

function checkJsonStringifyInLoop(call: CallExpression, context: PerformanceRuleContext, cliReason?: string): void {
  const callee = ts.skipOuterExpressions(call.expression);
  if (
    !ts.isPropertyAccessExpression(callee) ||
    !ts.isIdentifier(callee.expression) ||
    callee.expression.text !== 'JSON' ||
    callee.name.text !== 'stringify'
  ) {
    return;
  }
  if (!enclosingLoop(call)) return;
  context.report(
    call,
    'json-stringify-in-loop',
    'JSON.stringify runs inside a loop; serialize once outside the loop or stream the output.',
    cliReason,
  );
}

// --- Entrypoint ----------------------------------------------------------------------------------

function collectPhase5PerfFindings(sourceFile: SourceFile, context: PerformanceRuleContext): void {
  if (isTestSource(sourceFile.fileName)) return;
  const execCtx = classifyExecutionContext(sourceFile, context.program);
  const cliReason = execCtx.runtime === 'cli-tooling' ? 'CLI or build-tooling context.' : undefined;
  function visit(node: Node): void {
    if (ts.isCallExpression(node)) {
      checkUnboundedPromiseAll(node, sourceFile, context, cliReason);
      checkMongooseMissingLean(node, sourceFile, context);
      checkNodeEventListenerLeak(node, context);
      checkJsonStringifyInLoop(node, context, cliReason);
    } else if (ts.isMethodDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)) {
      checkGraphqlNPlusOneResolver(node, context);
    } else if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      checkReactContextValueRecreated(node, context);
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
}

export { collectPhase5PerfFindings };
