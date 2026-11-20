'use strict';

// Memory that grows with traffic or payload size: caches that never evict, and whole files or bodies held in memory
// only to be written out again.
const { syntax: ts } = require('./compiler.cjs');
const { enclosingRequestHandler, parameterName } = require('./request-handlers.cjs');

const CACHE_RULE_ID = 'unbounded-module-cache';
const PAYLOAD_RULE_ID = 'whole-payload-in-memory';

const CACHE_NAME = /(?:cache|memo|lookup)s?$/i;
const STARTUP_FUNCTION =
  /^(?:constructor|onModule[A-Za-z]+|onApplication[A-Za-z]+|register[A-Za-z]*|init[A-Za-z]*|bootstrap[A-Za-z]*|setup[A-Za-z]*)$/;
const LIST_CACHE_NAME = /cache|memo|history/i;
const WRITE_METHODS = new Set(['set', 'add', 'push']);
const READ_METHODS = new Set(['get', 'has']);
// Any use of these shows the collection is trimmed, measured or reset, so it may be bounded elsewhere.
const BOUNDING_MEMBERS = new Set(['delete', 'clear', 'size', 'length', 'shift', 'pop', 'splice', 'unshift']);
const SCOPE_OPTOUT_ARGUMENTS = /REQUEST|TRANSIENT/;
const REQUEST_SCOPED_NAMES = /^(?:res|response|reply|next|h)$/;

const FS_MODULE = /^(?:node:)?fs(?:\/promises)?$/;
const FS_READS = new Set(['readFile', 'readFileSync']);
const WHOLE_BODY_READS = new Set(['arrayBuffer', 'blob', 'text']);
const WRITE_SINKS = new Set(['writeFile', 'writeFileSync', 'appendFile', 'appendFileSync', 'write', 'end', 'send']);
const BYTE_WRAPPERS = new Set(['from']);

function unwrap(node) {
  return node && ts.skipOuterExpressions(node);
}

function isEmptyCollection(initializer) {
  const value = unwrap(initializer);
  if (!value) return;
  if (ts.isObjectLiteralExpression(value) && value.properties.length === 0) return 'object';
  if (ts.isArrayLiteralExpression(value) && value.elements.length === 0) return 'array';
  if (ts.isNewExpression(value) && ts.isIdentifier(value.expression) && !value.arguments?.length) {
    if (value.expression.text === 'Map') return 'map';
    if (value.expression.text === 'Set') return 'set';
  }
}

function isLiteralKey(key) {
  const value = unwrap(key);
  return !value || ts.isStringLiteralLike(value) || ts.isNumericLiteral(value);
}

function isAssignmentTarget(access) {
  const parent = access.parent;
  return (
    ts.isBinaryExpression(parent) &&
    parent.left === access &&
    parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
    parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment
  );
}

// Classifies one reference to the collection as a read, a growing write, a bounding use, or an escape.
function classifyUse(reference) {
  const parent = reference.parent;
  if (ts.isPropertyAccessExpression(parent) && parent.expression === reference) {
    const member = parent.name.text;
    if (BOUNDING_MEMBERS.has(member)) return { kind: 'bounded' };
    const call = parent.parent;
    const isCall = ts.isCallExpression(call) && call.expression === parent;
    if (isCall && WRITE_METHODS.has(member)) {
      return isLiteralKey(call.arguments[0]) ? { kind: 'read' } : { kind: 'write', node: call, member };
    }
    return { kind: READ_METHODS.has(member) ? 'read' : 'other' };
  }
  if (ts.isElementAccessExpression(parent) && parent.expression === reference) {
    if (ts.isDeleteExpression(parent.parent)) return { kind: 'bounded' };
    if (!isAssignmentTarget(parent)) return { kind: 'read' };
    return isLiteralKey(parent.argumentExpression)
      ? { kind: 'other' }
      : { kind: 'write', node: parent.parent, member: 'element' };
  }
  if (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.InKeyword) return { kind: 'read' };
  return { kind: 'bounded' };
}

function nearestFunction(node) {
  return ts.findAncestor(node.parent, ts.isFunctionLike);
}

function startsWithin(root, node) {
  return node.pos >= root.pos && node.end <= root.end;
}

// `const hit = cache.get(key); if (hit) return hit;` or `return cache.get(key)`: the function answers from the
// collection and fills it on a miss, which is what makes it a cache rather than a registry.
function returnsCachedRead(functionNode, reads) {
  const bound = new Set();
  const returned = [];
  (function visit(node) {
    if (ts.isFunctionLike(node) && node !== functionNode) return;
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      if (reads.some((read) => startsWithin(node.initializer, read))) bound.add(node.name.text);
    }
    if (ts.isReturnStatement(node) && node.expression) returned.push(node.expression);
    ts.forEachChild(node, visit);
  })(functionNode.body);
  return returned.some(
    (expression) => reads.some((read) => startsWithin(expression, read)) || mentionsAny(expression, bound),
  );
}

function functionName(functionNode) {
  if (ts.isConstructorDeclaration(functionNode)) return 'constructor';
  return functionNode.name && ts.isIdentifier(functionNode.name) ? functionNode.name.text : '';
}

// Registries are filled while the application starts, not per request.
function isStartupWork(node) {
  return STARTUP_FUNCTION.test(functionName(nearestFunction(node)));
}

function memoizes(write, uses) {
  const functionNode = nearestFunction(write.node);
  const reads = uses
    .filter((use) => use.kind === 'read' && nearestFunction(use.reference) === functionNode)
    .map((use) => use.reference);
  return reads.length > 0 && returnsCachedRead(functionNode, reads);
}

// The first write that grows an unevicted collection, or undefined when the collection looks bounded or is no cache.
function growingWrite(references, shape, name) {
  const uses = references.map((reference) => ({ reference, ...classifyUse(reference) }));
  if (uses.some((use) => use.kind === 'bounded')) return;
  const writes = uses.filter((use) => use.kind === 'write' && nearestFunction(use.node) && !isStartupWork(use.node));
  if (!writes.length) return;
  const listOnly = shape === 'array';
  if (writes.some((write) => (write.member === 'push') !== listOnly)) return;
  if (listOnly && !LIST_CACHE_NAME.test(name)) return;
  const isNamedCache = CACHE_NAME.test(name) && uses.some((use) => use.kind === 'read');
  if (!listOnly && !isNamedCache && !writes.some((write) => memoizes(write, uses))) return;
  return writes.sort((left, right) => left.node.pos - right.node.pos)[0].node;
}

function identifierReferences(scope, name, declaration) {
  const references = [];
  (function visit(node) {
    if (ts.isIdentifier(node) && node.text === name && node !== declaration) references.push(node);
    ts.forEachChild(node, visit);
  })(scope);
  return references;
}

function thisReferences(classNode, name) {
  const references = [];
  (function visit(node) {
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

function decoratorCalls(classNode) {
  return (classNode.modifiers ?? [])
    .filter((modifier) => ts.isDecorator(modifier))
    .map((modifier) => modifier.expression);
}

// A singleton service lives for the process; request- and transient-scoped ones are rebuilt and drop their fields.
function isSingletonService(classNode) {
  const injectable = decoratorCalls(classNode).find(
    (expression) => (ts.isCallExpression(expression) ? expression.expression : expression).getText() === 'Injectable',
  );
  return !!injectable && !SCOPE_OPTOUT_ARGUMENTS.test(injectable.getText());
}

function isExported(statement) {
  return !!statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
}

function writeReceiver(write) {
  return ts.isBinaryExpression(write) ? write.left.expression : write.expression.expression;
}

const reportedCaches = new WeakSet();

function reportGrowth(context, write, label) {
  if (reportedCaches.has(write)) return;
  reportedCaches.add(write);
  const target = writeReceiver(write);
  context.report(
    ts.isBinaryExpression(write) ? write.left : write.expression.name,
    CACHE_RULE_ID,
    `${label} \`${target.getText()}\` only grows: nothing in this file deletes, clears or size-checks it, so a long-lived process keeps every entry it was given until memory runs out. Bound it with an LRU or TTL (\`lru-cache\`, or evict when \`size\` passes a cap). Ignore if the key space is small and fixed.`,
  );
}

function moduleLevelCaches(sourceFile) {
  const caches = [];
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement) || isExported(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      const shape = ts.isIdentifier(declaration.name) && isEmptyCollection(declaration.initializer);
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

function serviceFieldCaches(sourceFile) {
  const caches = [];
  (function visit(node) {
    if (ts.isClassDeclaration(node) && isSingletonService(node)) {
      for (const member of node.members) {
        const shape =
          ts.isPropertyDeclaration(member) && ts.isIdentifier(member.name) && isEmptyCollection(member.initializer);
        if (shape) {
          caches.push({ name: member.name.text, shape, references: thisReferences(node, member.name.text) });
        }
      }
    }
    ts.forEachChild(node, visit);
  })(sourceFile);
  return caches;
}

const cacheCandidates = new WeakMap();

function candidatesOf(sourceFile) {
  if (!cacheCandidates.has(sourceFile)) {
    const found = [...moduleLevelCaches(sourceFile), ...serviceFieldCaches(sourceFile)].flatMap((candidate) => {
      const write = growingWrite(candidate.references, candidate.shape, candidate.name);
      return write ? [{ write, shape: candidate.shape }] : [];
    });
    cacheCandidates.set(sourceFile, found);
  }
  return cacheCandidates.get(sourceFile);
}

const SHAPE_LABELS = { map: 'Map', set: 'Set', object: 'Object cache', array: 'Array' };

function checkCacheWrite(node, context) {
  const candidate = candidatesOf(node.getSourceFile()).find((entry) => entry.write === node);
  if (candidate) reportGrowth(context, node, SHAPE_LABELS[candidate.shape]);
}

// ---------------------------------------------------------------- whole payloads

function importedModule(identifier, checker) {
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

function isFsRead(call, checker) {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) {
    const declaration = checker.getSymbolAtLocation(callee)?.declarations?.[0];
    const imported = declaration && ts.isImportSpecifier(declaration) && (declaration.propertyName ?? declaration.name);
    return !!imported && FS_READS.has(imported.text) && FS_MODULE.test(importedModule(callee, checker) ?? '');
  }
  if (!ts.isPropertyAccessExpression(callee) || !FS_READS.has(callee.name.text)) return false;
  let root = unwrap(callee.expression);
  while (ts.isPropertyAccessExpression(root) && root.name.text === 'promises') root = unwrap(root.expression);
  return ts.isIdentifier(root) && FS_MODULE.test(importedModule(root, checker) ?? '');
}

function mentionsAny(node, names) {
  let mentioned = false;
  (function visit(child) {
    if (mentioned) return;
    if (ts.isIdentifier(child) && names.has(child.text)) mentioned = true;
    else ts.forEachChild(child, visit);
  })(node);
  return mentioned;
}

// Handler parameters (minus the response objects) and locals computed from them.
function requestDerivedNames(handler) {
  const names = new Set(
    handler.parameters.map(parameterName).filter((name) => name && !REQUEST_SCOPED_NAMES.test(name)),
  );
  (function visit(node) {
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

function checkRequestFileRead(call, context) {
  const [path] = call.arguments;
  const handler = path && enclosingRequestHandler(call);
  if (!handler || !isFsRead(call, context.checker) || ts.isStringLiteralLike(unwrap(path))) return;
  if (!mentionsAny(path, requestDerivedNames(handler))) return;
  context.report(
    ts.isPropertyAccessExpression(call.expression) ? call.expression.name : call.expression,
    PAYLOAD_RULE_ID,
    'This reads a whole file chosen by the request into memory, so concurrent requests for large files hold every byte at once. Stream it instead: `await pipeline(createReadStream(path), response)` (`node:stream/promises`), and cap the size with `stat` when the file must be buffered.',
  );
}

// `Buffer.from(x)` or `new Uint8Array(x)` only change how the same bytes are viewed.
function skipByteWrappers(node) {
  let current = node;
  for (let parent = current.parent; parent; current = parent, parent = parent.parent) {
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

function isWriteSink(call, argument) {
  const callee = call.expression;
  const name = ts.isPropertyAccessExpression(callee) ? callee.name.text : ts.isIdentifier(callee) ? callee.text : '';
  return WRITE_SINKS.has(name) && call.arguments.includes(argument);
}

// True when the value is only handed to a write call, directly or through a local that is never used otherwise.
function isOnlyWrittenOut(value, scope) {
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

function isFetchResponse(receiver, checker) {
  return checker.getTypeAtLocation(receiver).getSymbol()?.name === 'Response';
}

function checkDownloadedBody(call, access, context) {
  if (
    !WHOLE_BODY_READS.has(access.name.text) ||
    call.arguments.length ||
    !isFetchResponse(access.expression, context.checker)
  ) {
    return;
  }
  const scope = ts.findAncestor(call, ts.isFunctionLike)?.body;
  if (!scope || !isOnlyWrittenOut(call, scope)) return;
  context.report(
    access.name,
    PAYLOAD_RULE_ID,
    `\`${access.name.text}()\` buffers the whole download in memory only to write it out again. Stream it: \`await pipeline(Readable.fromWeb(response.body), createWriteStream(path))\` (\`node:stream\`, \`node:stream/promises\`).`,
  );
}

function pushesFromStream(pushCall) {
  for (let node = pushCall.parent; node; node = node.parent) {
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

function accumulatesStream(chunks, scope) {
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

function isBufferConcat(access) {
  return (
    ts.isPropertyAccessExpression(access) && access.name.text === 'concat' && access.expression.getText() === 'Buffer'
  );
}

function checkBufferedStream(call, access, context) {
  const [chunks] = call.arguments;
  if (!isBufferConcat(access) || !chunks || !ts.isIdentifier(unwrap(chunks))) return;
  const scope = ts.findAncestor(call, ts.isFunctionLike)?.body;
  if (!scope || !accumulatesStream(unwrap(chunks), scope) || !isOnlyWrittenOut(call, scope)) return;
  context.report(
    access.name,
    PAYLOAD_RULE_ID,
    'The stream is collected into one Buffer only to be written out again, so memory use equals the payload size. Connect the streams instead: `await pipeline(source, destination)` (`node:stream/promises`).',
  );
}

function check(node, context) {
  const access = node.expression;
  if (ts.isPropertyAccessExpression(access)) {
    if (WRITE_METHODS.has(access.name.text)) checkCacheWrite(node, context);
    checkDownloadedBody(node, access, context);
    checkBufferedStream(node, access, context);
  }
  checkRequestFileRead(node, context);
}

function checkAssignment(node, context) {
  if (ts.isElementAccessExpression(node.left)) checkCacheWrite(node, context);
}

module.exports = { check, checkAssignment };
