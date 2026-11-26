// Memory that grows with traffic or payload size: caches that never evict, and whole files or
// bodies held in memory only to be written out again.
import { ts } from './compiler.js';
import { enclosingRequestHandler, parameterName } from './request-handlers.js';
import { hasFunctionBody } from './function-kinds.js';
import { classifyExecutionContext } from '../shared/execution-context.js';
import type {
  BinaryExpression,
  CallExpression,
  ClassDeclaration,
  Expression,
  Identifier,
  Node,
  PropertyAccessExpression,
  SignatureDeclaration,
  SourceFile,
  VariableStatement,
} from 'typescript';
import type { CheckerAdapter, PerformanceRuleContext, TypeAdapter } from '../shared/types.js';
import type { FunctionWithBody } from '../shared/types/function-summaries.js';

const CACHE_RULE_ID = 'unbounded-module-cache';
const PAYLOAD_RULE_ID = 'whole-payload-in-memory';

const CACHE_NAME = /(?:cache|memo|lookup)s?$/i;
// Name parts that mark a key as coming from a request, a tenant or a user, so its space grows with
// traffic.
const REQUEST_KEY_PARTS = new Set(
  'id ids uuid key tenant user userid workspace workspaceid session email slug token req request args input params query body'.split(
    ' ',
  ),
);
const CONTEXTUAL_KEY_REASON =
  'The key looks like it comes from configuration or code rather than from requests, so the key space may be small.';
const STARTUP_FUNCTION =
  /^(?:constructor|onModule[A-Za-z]+|onApplication[A-Za-z]+|register[A-Za-z]*|init[A-Za-z]*|bootstrap[A-Za-z]*|setup[A-Za-z]*)$/;
const LIST_CACHE_NAME = /cache|memo|history/i;
const WRITE_METHODS = new Set(['set', 'add', 'push']);
const READ_METHODS = new Set(['get', 'has']);
// Any use of these shows the collection is trimmed, measured or reset, so it may be bounded
// elsewhere.
const BOUNDING_MEMBERS = new Set(['delete', 'clear', 'size', 'length', 'shift', 'pop', 'splice', 'unshift']);
const SCOPE_OPTOUT_ARGUMENTS = /REQUEST|TRANSIENT/;
const REQUEST_SCOPED_NAMES = /^(?:res|response|reply|next|h)$/;

const FS_MODULE = /^(?:node:)?fs(?:\/promises)?$/;
const FS_READS = new Set(['readFile', 'readFileSync']);
const WHOLE_BODY_READS = new Set(['arrayBuffer', 'blob', 'text']);
const WRITE_SINKS = new Set(['writeFile', 'writeFileSync', 'appendFile', 'appendFileSync', 'write', 'end', 'send']);
const BYTE_WRAPPERS = new Set(['from']);

// What an empty module-level or class-field initializer creates.
type CollectionShape = 'object' | 'array' | 'map' | 'set';

// The node a write adds an entry through: `cache.set(key, v)` or `cache[key] = v`.
interface WriteUse {
  kind: 'write';
  node: CallExpression | BinaryExpression;
  member: string;
  /** The collection the write goes into. */
  receiver: Expression;
  /** The part of the write a finding points at. */
  anchor: Node;
  key: Expression | undefined;
}

interface PlainUse {
  kind: 'read' | 'bounded' | 'other';
}

// How one reference to the collection is used.
type CollectionUse = WriteUse | PlainUse;
type ReferencedUse = CollectionUse & { reference: Node };
type ReferencedWrite = WriteUse & { reference: Node };

type KeyVerdict = 'bounded' | 'request' | 'other';

interface CacheCandidate {
  name: string;
  shape: CollectionShape;
  references: Node[];
}

// A collection that grows: the write that does it, and whether the key looks like configuration.
interface GrowthFinding {
  write: WriteUse;
  contextual: boolean;
  shape: CollectionShape;
}

function unwrap(node: Expression): Expression;
function unwrap(node: Expression | undefined): Expression | undefined;
function unwrap(node: Expression | undefined): Expression | undefined {
  return node && ts.skipOuterExpressions(node);
}

function isEmptyCollection(initializer: Expression | undefined): CollectionShape | undefined {
  const value = unwrap(initializer);
  if (!value) return;
  if (ts.isObjectLiteralExpression(value) && value.properties.length === 0) return 'object';
  if (ts.isArrayLiteralExpression(value) && value.elements.length === 0) return 'array';
  if (ts.isNewExpression(value) && ts.isIdentifier(value.expression) && !value.arguments?.length) {
    if (value.expression.text === 'Map') return 'map';
    if (value.expression.text === 'Set') return 'set';
  }
}

function isLiteralKey(key: Expression | undefined): boolean {
  const value = unwrap(key);
  return !value || ts.isStringLiteralLike(value) || ts.isNumericLiteral(value);
}

function isAssignmentTarget(access: Node): boolean {
  const parent = access.parent;
  return (
    ts.isBinaryExpression(parent) &&
    parent.left === access &&
    parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
    parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment
  );
}

// Classifies one reference to the collection as a read, a growing write, a bounding use, or an
// escape.
function classifyUse(reference: Node): CollectionUse {
  const parent = reference.parent;
  if (ts.isPropertyAccessExpression(parent) && parent.expression === reference) {
    const member = parent.name.text;
    if (BOUNDING_MEMBERS.has(member)) return { kind: 'bounded' };
    const call = parent.parent;
    const isCall = ts.isCallExpression(call) && call.expression === parent;
    if (isCall && WRITE_METHODS.has(member)) {
      return isLiteralKey(call.arguments[0])
        ? { kind: 'read' }
        : {
            kind: 'write',
            node: call,
            member,
            receiver: parent.expression,
            anchor: parent.name,
            key: call.arguments[0],
          };
    }
    return { kind: READ_METHODS.has(member) ? 'read' : 'other' };
  }
  if (ts.isElementAccessExpression(parent) && parent.expression === reference) {
    if (ts.isDeleteExpression(parent.parent)) return { kind: 'bounded' };
    const assignment = parent.parent;
    if (!isAssignmentTarget(parent) || !ts.isBinaryExpression(assignment)) return { kind: 'read' };
    return isLiteralKey(parent.argumentExpression)
      ? { kind: 'other' }
      : {
          kind: 'write',
          node: assignment,
          member: 'element',
          receiver: parent.expression,
          anchor: parent,
          key: parent.argumentExpression,
        };
  }
  if (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.InKeyword) return { kind: 'read' };
  return { kind: 'bounded' };
}

function nearestFunction(node: Node): SignatureDeclaration | undefined {
  return ts.findAncestor(node.parent, ts.isFunctionLike);
}

function startsWithin(root: Node, node: Node): boolean {
  return node.pos >= root.pos && node.end <= root.end;
}

// `const hit = cache.get(key); if (hit) return hit;` or `return cache.get(key)`: the function
// answers from the collection and fills it on a miss, which is what makes it a cache rather than a
// registry.
function returnsCachedRead(functionNode: SignatureDeclaration, reads: readonly Node[]): boolean {
  const body = 'body' in functionNode ? functionNode.body : undefined;
  if (!body) return false;
  const bound = new Set<string>();
  const returned: Expression[] = [];
  (function visit(node: Node): void {
    if (ts.isFunctionLike(node) && node !== functionNode) return;
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const initializer = node.initializer;
      if (reads.some((read) => startsWithin(initializer, read))) bound.add(node.name.text);
    }
    if (ts.isReturnStatement(node) && node.expression) returned.push(node.expression);
    ts.forEachChild(node, visit);
  })(body);
  return returned.some(
    (expression) => reads.some((read) => startsWithin(expression, read)) || mentionsAny(expression, bound),
  );
}

function functionName(functionNode: SignatureDeclaration | undefined): string {
  if (!functionNode) return '';
  if (ts.isConstructorDeclaration(functionNode)) return 'constructor';
  return functionNode.name && ts.isIdentifier(functionNode.name) ? functionNode.name.text : '';
}

// Registries are filled while the application starts, not per request.
function isStartupWork(node: Node): boolean {
  return STARTUP_FUNCTION.test(functionName(nearestFunction(node)));
}

function memoizes(write: WriteUse, uses: readonly ReferencedUse[]): boolean {
  const functionNode = nearestFunction(write.node);
  if (!functionNode) return false;
  const reads = uses
    .filter((use) => use.kind === 'read' && nearestFunction(use.reference) === functionNode)
    .map((use) => use.reference);
  return reads.length > 0 && returnsCachedRead(functionNode, reads);
}

function isBoundedType(type: TypeAdapter): boolean {
  if (type.isUnion()) return (type.types ?? []).every(isBoundedType);
  const bounded =
    ts.TypeFlags.BooleanLike |
    ts.TypeFlags.EnumLike |
    ts.TypeFlags.StringLiteral |
    ts.TypeFlags.NumberLiteral |
    ts.TypeFlags.Null |
    ts.TypeFlags.Undefined;
  return !!(type.flags & bounded);
}

function nameParts(text: string): string[] {
  return text
    .replaceAll(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/);
}

function derivesFromRequest(key: Expression, checker: CheckerAdapter): boolean {
  const declaration = ts.isIdentifier(key) ? checker.getSymbolAtLocation(key)?.valueDeclaration : undefined;
  const initializer = declaration && ts.isVariableDeclaration(declaration) ? declaration.initializer : undefined;
  const text = key.getText() + (initializer ? ' ' + initializer.getText() : '');
  return nameParts(text).some((part) => REQUEST_KEY_PARTS.has(part));
}

function collectionKeyIsBounded(write: WriteUse, checker: CheckerAdapter): boolean {
  const collectionType = checker.getTypeAtLocation(write.receiver);
  const typeArgs = checker.getTypeArguments(collectionType);
  return typeArgs.length > 0 && isBoundedType(typeArgs[0]);
}

// 'bounded' when the key's type admits only a few values; otherwise 'request' or 'other' by where
// the key comes from.
function keyVerdict(write: WriteUse, checker: CheckerAdapter): KeyVerdict {
  const key = write.member === 'push' ? undefined : write.key;
  if (!key) return 'request';
  if (isBoundedType(checker.getTypeAtLocation(key)) || collectionKeyIsBounded(write, checker)) return 'bounded';
  return derivesFromRequest(key, checker) ? 'request' : 'other';
}

// The first write that grows an unevicted collection, or undefined when the collection looks
// bounded or is no cache.
function growingWrite(
  references: readonly Node[],
  shape: CollectionShape,
  name: string,
  checker: CheckerAdapter,
): { write: WriteUse; contextual: boolean } | undefined {
  const uses: ReferencedUse[] = references.map((reference) => ({ reference, ...classifyUse(reference) }));
  if (uses.some((use) => use.kind === 'bounded')) return;
  const writes = uses.filter(
    (use): use is ReferencedWrite =>
      use.kind === 'write' && Boolean(nearestFunction(use.node)) && !isStartupWork(use.node),
  );
  if (!writes.length) return;
  const listOnly = shape === 'array';
  if (writes.some((write) => (write.member === 'push') !== listOnly)) return;
  if (listOnly && !LIST_CACHE_NAME.test(name)) return;
  const isNamedCache = CACHE_NAME.test(name) && uses.some((use) => use.kind === 'read');
  if (!listOnly && !isNamedCache && !writes.some((write) => memoizes(write, uses))) return;
  const judged = writes
    .map((write) => ({ write, verdict: keyVerdict(write, checker) }))
    .filter((entry) => entry.verdict !== 'bounded')
    .sort((left, right) => left.write.node.pos - right.write.node.pos);
  const chosen = judged.find((entry) => entry.verdict === 'request') ?? judged[0];
  return chosen && { write: chosen.write, contextual: chosen.verdict === 'other' };
}

function identifierReferences(scope: Node, name: string, declaration?: Node): Identifier[] {
  const references: Identifier[] = [];
  (function visit(node: Node): void {
    if (ts.isIdentifier(node) && node.text === name && node !== declaration) references.push(node);
    ts.forEachChild(node, visit);
  })(scope);
  return references;
}

function thisReferences(classNode: ClassDeclaration, name: string): PropertyAccessExpression[] {
  const references: PropertyAccessExpression[] = [];
  (function visit(node: Node): void {
    if (
      ts.isPropertyAccessExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ThisKeyword &&
      node.name.text === name
    ) {
      references.push(node);
    }
    ts.forEachChild(node, visit);
  })(classNode);
  return references;
}

function decoratorCalls(classNode: ClassDeclaration): Expression[] {
  return (ts.getDecorators(classNode) ?? []).map((decorator) => decorator.expression);
}

// A singleton service lives for the process; request- and transient-scoped ones are rebuilt and
// drop their fields.
function isSingletonService(classNode: ClassDeclaration): boolean {
  const injectable = decoratorCalls(classNode).find(
    (expression: Expression) =>
      (ts.isCallExpression(expression) ? expression.expression : expression).getText() === 'Injectable',
  );
  return !!injectable && !SCOPE_OPTOUT_ARGUMENTS.test(injectable.getText());
}

function isExported(statement: VariableStatement): boolean {
  return !!statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
}

const reportedCaches = new WeakSet<Node>();

function reportGrowth(context: PerformanceRuleContext, write: WriteUse, label: string, contextual: boolean): void {
  if (reportedCaches.has(write.node)) return;
  reportedCaches.add(write.node);
  const target = write.receiver;
  const runtime = classifyExecutionContext(write.node.getSourceFile(), context.program).runtime;
  const reason = contextual
    ? CONTEXTUAL_KEY_REASON
    : runtime === 'browser'
      ? 'Runs in a browser module whose cache lives for the current page/tab session rather than a shared server process.'
      : undefined;
  context.report(
    write.anchor,
    CACHE_RULE_ID,
    `${label} \`${target.getText()}\` only grows: nothing in this file deletes, clears or size-checks it, so a long-lived process keeps every entry it was given until memory runs out. Bound it with an LRU or TTL (\`lru-cache\`, or evict when \`size\` passes a cap). Ignore if the key space is small and fixed.`,
    reason,
  );
}

function moduleLevelCaches(sourceFile: SourceFile): CacheCandidate[] {
  const caches: CacheCandidate[] = [];
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement) || isExported(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name)) continue;
      const shape = isEmptyCollection(declaration.initializer);
      if (shape) {
        caches.push({
          name: declaration.name.text,
          shape,
          references: identifierReferences(sourceFile, declaration.name.text, declaration.name),
        });
      }
    }
  }
  return caches;
}

function serviceFieldCaches(sourceFile: SourceFile): CacheCandidate[] {
  const caches: CacheCandidate[] = [];
  (function visit(node: Node): void {
    if (ts.isClassDeclaration(node) && isSingletonService(node)) {
      for (const member of node.members) {
        if (!ts.isPropertyDeclaration(member) || !ts.isIdentifier(member.name)) continue;
        const shape = isEmptyCollection(member.initializer);
        if (shape) {
          caches.push({ name: member.name.text, shape, references: thisReferences(node, member.name.text) });
        }
      }
    }
    ts.forEachChild(node, visit);
  })(sourceFile);
  return caches;
}

const cacheCandidates = new WeakMap<SourceFile, GrowthFinding[]>();

function candidatesOf(sourceFile: SourceFile, checker: CheckerAdapter): GrowthFinding[] {
  const known = cacheCandidates.get(sourceFile);
  if (known) return known;
  const found = [...moduleLevelCaches(sourceFile), ...serviceFieldCaches(sourceFile)].flatMap(
    (candidate): GrowthFinding[] => {
      const growth = growingWrite(candidate.references, candidate.shape, candidate.name, checker);
      return growth ? [{ write: growth.write, contextual: growth.contextual, shape: candidate.shape }] : [];
    },
  );
  cacheCandidates.set(sourceFile, found);
  return found;
}

const SHAPE_LABELS: Record<CollectionShape, string> = {
  map: 'Map',
  set: 'Set',
  object: 'Object cache',
  array: 'Array',
};

function checkCacheWrite(node: Node, context: PerformanceRuleContext): void {
  const candidate = candidatesOf(node.getSourceFile(), context.checker).find((entry) => entry.write.node === node);
  if (candidate) reportGrowth(context, candidate.write, SHAPE_LABELS[candidate.shape], candidate.contextual);
}

// ---------------------------------------------------------------- whole payloads

function importedModule(identifier: Identifier, checker: CheckerAdapter): string | undefined {
  const declaration = checker.getSymbolAtLocation(identifier)?.declarations?.[0];
  if (!declaration) return;
  const statement = ts.findAncestor(declaration, ts.isImportDeclaration);
  if (statement && ts.isStringLiteral(statement.moduleSpecifier)) return statement.moduleSpecifier.text;
  const variable = ts.isVariableDeclaration(declaration) ? unwrap(declaration.initializer) : undefined;
  if (variable && ts.isCallExpression(variable) && variable.expression.getText() === 'require') {
    const [specifier] = variable.arguments;
    return specifier && ts.isStringLiteralLike(specifier) ? specifier.text : undefined;
  }
}

function isFsRead(call: CallExpression, checker: CheckerAdapter): boolean {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) {
    const declaration = checker.getSymbolAtLocation(callee)?.declarations?.[0];
    const imported = declaration && ts.isImportSpecifier(declaration) && (declaration.propertyName ?? declaration.name);
    return !!imported && FS_READS.has(imported.text) && FS_MODULE.test(importedModule(callee, checker) ?? '');
  }
  if (!ts.isPropertyAccessExpression(callee) || !FS_READS.has(callee.name.text)) return false;
  let root: Node = unwrap(callee.expression);
  while (ts.isPropertyAccessExpression(root) && root.name.text === 'promises') root = unwrap(root.expression);
  return ts.isIdentifier(root) && FS_MODULE.test(importedModule(root, checker) ?? '');
}

function mentionsAny(node: Node, names: ReadonlySet<string>): boolean {
  let mentioned = false;
  (function visit(child: Node): void {
    if (mentioned) return;
    if (ts.isIdentifier(child) && names.has(child.text)) mentioned = true;
    else ts.forEachChild(child, visit);
  })(node);
  return mentioned;
}

// Handler parameters (minus the response objects) and locals computed from them.
function requestDerivedNames(handler: FunctionWithBody): Set<string> {
  const names = new Set(
    handler.parameters.map(parameterName).filter((name): name is string => !!name && !REQUEST_SCOPED_NAMES.test(name)),
  );
  (function visit(node: Node): void {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      mentionsAny(node.initializer, names)
    ) {
      names.add(node.name.text);
    }
    ts.forEachChild(node, visit);
  })(handler.body);
  return names;
}

function checkRequestFileRead(call: CallExpression, context: PerformanceRuleContext): void {
  const [path] = call.arguments;
  const handler = path && enclosingRequestHandler(call);
  if (
    !path ||
    !handler ||
    !hasFunctionBody(handler) ||
    !isFsRead(call, context.checker) ||
    ts.isStringLiteralLike(unwrap(path))
  )
    return;
  if (!mentionsAny(path, requestDerivedNames(handler))) return;
  context.report(
    ts.isPropertyAccessExpression(call.expression) ? call.expression.name : call.expression,
    PAYLOAD_RULE_ID,
    'This reads a whole file chosen by the request into memory, so concurrent requests for large files hold every byte at once. Stream it instead: `await pipeline(createReadStream(path), response)` (`node:stream/promises`), and cap the size with `stat` when the file must be buffered.',
  );
}

// `Buffer.from(x)` or `new Uint8Array(x)` only change how the same bytes are viewed.
function skipByteWrappers(node: Node): Node {
  let current = node;
  for (let parent: Node | undefined = current.parent; parent; current = parent, parent = parent.parent) {
    if (ts.isOuterExpression(parent) || ts.isAwaitExpression(parent)) continue;
    const isWrapperCall =
      ts.isCallExpression(parent) &&
      parent.arguments[0] === current &&
      ts.isPropertyAccessExpression(parent.expression) &&
      BYTE_WRAPPERS.has(parent.expression.name.text);
    const isViewConstruction = ts.isNewExpression(parent) && parent.arguments?.[0] === current;
    if (!isWrapperCall && !isViewConstruction) break;
  }
  return current;
}

function isWriteSink(call: CallExpression, argument: Node): boolean {
  const callee = call.expression;
  const name = ts.isPropertyAccessExpression(callee) ? callee.name.text : ts.isIdentifier(callee) ? callee.text : '';
  return WRITE_SINKS.has(name) && call.arguments.some((candidate) => candidate === argument);
}

// True when the value is only handed to a write call, directly or through a local that is never
// used otherwise.
function isOnlyWrittenOut(value: Node, scope: Node): boolean {
  const outer = skipByteWrappers(value);
  const parent = outer.parent;
  if (ts.isCallExpression(parent)) return isWriteSink(parent, outer);
  if (!ts.isVariableDeclaration(parent) || parent.initializer !== outer || !ts.isIdentifier(parent.name)) return false;
  const uses = identifierReferences(scope, parent.name.text, parent.name);
  return (
    uses.length > 0 &&
    uses.every((use) => {
      const useOuter = skipByteWrappers(use);
      return ts.isCallExpression(useOuter.parent) && isWriteSink(useOuter.parent, useOuter);
    })
  );
}

function isFetchResponse(receiver: Expression, checker: CheckerAdapter): boolean {
  return checker.getTypeAtLocation(receiver).getSymbol()?.name === 'Response';
}

function checkDownloadedBody(
  call: CallExpression,
  access: PropertyAccessExpression,
  context: PerformanceRuleContext,
): void {
  if (
    !WHOLE_BODY_READS.has(access.name.text) ||
    call.arguments.length ||
    !isFetchResponse(access.expression, context.checker)
  ) {
    return;
  }
  const scope = ts.findAncestor(call, hasFunctionBody)?.body;
  if (!scope || !isOnlyWrittenOut(call, scope)) return;
  context.report(
    access.name,
    PAYLOAD_RULE_ID,
    `\`${access.name.text}()\` buffers the whole download in memory only to write it out again. Stream it: \`await pipeline(Readable.fromWeb(response.body), createWriteStream(path))\` (\`node:stream\`, \`node:stream/promises\`).`,
  );
}

function pushesFromStream(pushCall: CallExpression): boolean {
  for (let node: Node | undefined = pushCall.parent; node; node = node.parent) {
    if (ts.isForOfStatement(node) && node.awaitModifier) return true;
    const isDataListener =
      ts.isFunctionLike(node) &&
      ts.isCallExpression(node.parent) &&
      ts.isPropertyAccessExpression(node.parent.expression) &&
      node.parent.expression.name.text === 'on' &&
      ts.isStringLiteralLike(node.parent.arguments[0]) &&
      node.parent.arguments[0].text === 'data';
    if (isDataListener) return true;
  }
  return false;
}

function accumulatesStream(chunks: Identifier, scope: Node): boolean {
  return identifierReferences(scope, chunks.text).some((use) => {
    const access = use.parent;
    const call = access.parent;
    return (
      ts.isPropertyAccessExpression(access) &&
      access.name.text === 'push' &&
      ts.isCallExpression(call) &&
      pushesFromStream(call)
    );
  });
}

function isBufferConcat(access: Node): boolean {
  return (
    ts.isPropertyAccessExpression(access) && access.name.text === 'concat' && access.expression.getText() === 'Buffer'
  );
}

function checkBufferedStream(
  call: CallExpression,
  access: PropertyAccessExpression,
  context: PerformanceRuleContext,
): void {
  const [chunks] = call.arguments;
  const chunkList = chunks && unwrap(chunks);
  if (!isBufferConcat(access) || !chunkList || !ts.isIdentifier(chunkList)) return;
  const scope = ts.findAncestor(call, hasFunctionBody)?.body;
  if (!scope || !accumulatesStream(chunkList, scope) || !isOnlyWrittenOut(call, scope)) return;
  context.report(
    access.name,
    PAYLOAD_RULE_ID,
    'The stream is collected into one Buffer only to be written out again, so memory use equals the payload size. Connect the streams instead: `await pipeline(source, destination)` (`node:stream/promises`).',
  );
}

function check(node: CallExpression, context: PerformanceRuleContext): void {
  const access = node.expression;
  if (ts.isPropertyAccessExpression(access)) {
    if (WRITE_METHODS.has(access.name.text)) checkCacheWrite(node, context);
    checkDownloadedBody(node, access, context);
    checkBufferedStream(node, access, context);
  }
  checkRequestFileRead(node, context);
}

function checkAssignment(node: BinaryExpression, context: PerformanceRuleContext): void {
  if (ts.isElementAccessExpression(node.left)) checkCacheWrite(node, context);
}

export { check, checkAssignment };
