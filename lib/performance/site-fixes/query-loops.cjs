'use strict';

// Rewrites per-item queries inside a for-of loop into one batched query before the loop, and single queries that
// load every row only to count, pick or filter them. Any shape not proven safe is left to the rule example.
const {
  bindingNames,
  ts,
  textOf,
  replaceNode,
  calleeCall,
  enclosingIteration,
  insertLinesBefore,
  lineStart,
  freshName,
  isPlainReference,
} = require('./helpers.cjs');

const exitKinds = new Set([
  ts.SyntaxKind.ContinueStatement,
  ts.SyntaxKind.BreakStatement,
  ts.SyntaxKind.ReturnStatement,
  ts.SyntaxKind.ThrowStatement,
]);
const arrayProducingMethods = new Set(['map', 'filter', 'slice', 'concat', 'flatMap', 'toSorted', 'split']);
const awaitedListMethods = new Set(['findMany', 'find', 'findBy', 'findAll']);
const arrayTypeNames = new Set(['Array', 'ReadonlyArray']);
// Array.from would drain these before the loop runs, leaving the loop nothing to iterate.
const oneShotTypeNames = new Set([
  'Iterable',
  'IterableIterator',
  'Iterator',
  'Generator',
  'AsyncIterable',
  'AsyncIterableIterator',
  'AsyncGenerator',
]);
const typeScriptFile = /\.[cm]?tsx?$/i;
const identifierPattern = /^[A-Za-z_$][\w$]*$/;
const sqlName = '[a-z_][a-z0-9_$]*';
const sqlQualifiedName = `${sqlName}(?:\\.${sqlName})?`;
const keyLookupSql = new RegExp(
  `^(\\s*select\\s+(\\*|${sqlQualifiedName}(?:\\s*,\\s*${sqlQualifiedName})*)\\s+from\\s+(${sqlQualifiedName})` +
    `\\s+where\\s+(${sqlQualifiedName})\\s*=\\s*)\\$1(\\s*;?\\s*)$`,
  'i',
);
const selectListSql = /^(\s*select\s+)(.+?)(\s+from\s)/is;
const trailingSql = /\s*;?\s*$/;

function someNode(root, predicate) {
  return !!(function visit(node) {
    return predicate(node) || ts.forEachChild(node, visit);
  })(root);
}

function outerParentheses(expression) {
  while (ts.isParenthesizedExpression(expression.parent)) expression = expression.parent;
  return expression;
}

function startsLine(node) {
  const sourceFile = node.getSourceFile();
  const start = node.getStart(sourceFile);
  return !sourceFile.text.slice(lineStart(sourceFile.text, start), start).trim();
}

// The text of `node` with absolute-offset edits inside it applied.
function textWith(node, edits) {
  const sourceFile = node.getSourceFile();
  const start = node.getStart(sourceFile);
  let result = textOf(node);
  for (const edit of [...edits].sort((left, right) => right.start - left.start)) {
    result = result.slice(0, edit.start - start) + edit.text + result.slice(edit.end - start);
  }
  return result;
}

// Wraps a replacement in parentheses unless the slot it lands in already separates it from its neighbours.
function inSlot(target, text) {
  const parent = target.parent;
  const bare =
    (ts.isVariableDeclaration(parent) && parent.initializer === target) ||
    (ts.isBinaryExpression(parent) &&
      parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      parent.right === target) ||
    ts.isReturnStatement(parent) ||
    ts.isExpressionStatement(parent) ||
    ts.isParenthesizedExpression(parent) ||
    ts.isArrayLiteralExpression(parent) ||
    (ts.isPropertyAssignment(parent) && parent.initializer === target) ||
    (ts.isCallExpression(parent) && parent.arguments.includes(target));
  return bare ? text : `(${text})`;
}

function isReference(identifier) {
  const parent = identifier.parent;
  if ((ts.isPropertyAccessExpression(parent) || ts.isPropertyAssignment(parent)) && parent.name === identifier)
    return false;
  if (ts.isBindingElement(parent) && parent.propertyName === identifier) return false;
  return !ts.isTypeReferenceNode(parent) && !ts.isQualifiedName(parent);
}

function mutationTarget(node) {
  if (ts.isBinaryExpression(node) && ts.isAssignmentOperator(node.operatorToken.kind)) return node.left;
  if (
    (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
    (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)
  )
    return node.operand;
  if (ts.isDeleteExpression(node)) return node.expression;
}

// Names declared or written inside `root`; an expression reading them cannot be evaluated before the loop.
function localNames(root) {
  const names = new Set();
  someNode(root, (node) => {
    if (
      (ts.isVariableDeclaration(node) ||
        ts.isParameter(node) ||
        ts.isBindingElement(node) ||
        ts.isFunctionDeclaration(node) ||
        ts.isClassDeclaration(node)) &&
      node.name &&
      ts.isIdentifier(node.name)
    )
      names.add(node.name.text);
    const target = mutationTarget(node);
    if (target)
      someNode(target, (inner) => {
        if (ts.isIdentifier(inner)) names.add(inner.text);
      });
    return false;
  });
  return names;
}

// Whether `expression` reads only the loop variable and bindings the loop never declares or writes.
function readsOnly(expression, loopVariable, locals) {
  let usesLoopVariable = false;
  const unsafe = someNode(expression, (node) => {
    if (ts.isAwaitExpression(node) || ts.isYieldExpression(node) || ts.isFunctionLike(node) || mutationTarget(node))
      return true;
    if (!ts.isIdentifier(node) || !isReference(node)) return false;
    if (node.text === loopVariable) usesLoopVariable = true;
    else if (locals.has(node.text)) return true;
    return false;
  });
  return unsafe ? undefined : { usesLoopVariable };
}

function receiverRoot(expression) {
  let current = expression;
  while (ts.isPropertyAccessExpression(current) && current.expression.kind !== ts.SyntaxKind.ThisKeyword)
    current = current.expression;
  if (ts.isIdentifier(current) || ts.isPropertyAccessExpression(current)) return textOf(current);
}

// The awaited value may only flow straight into a declaration, assignment, argument or property read.
function plainPath(awaited, statement) {
  for (let child = awaited; child !== statement; child = child.parent) {
    const parent = child.parent;
    const allowed =
      ts.isParenthesizedExpression(parent) ||
      ts.isVariableDeclaration(parent) ||
      ts.isVariableDeclarationList(parent) ||
      ts.isVariableStatement(parent) ||
      ts.isExpressionStatement(parent) ||
      (ts.isPropertyAccessExpression(parent) && parent.expression === child) ||
      (ts.isBinaryExpression(parent) &&
        parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        parent.right === child) ||
      (ts.isCallExpression(parent) && parent.arguments.includes(child));
    if (!allowed) return false;
  }
  return true;
}

function forOfLoop(loop) {
  if (!ts.isForOfStatement(loop) || loop.awaitModifier || !isPlainReference(loop.expression)) return;
  if (!(ts.isBlock(loop.parent) || ts.isSourceFile(loop.parent)) || !startsLine(loop)) return;
  const list = loop.initializer;
  if (!ts.isVariableDeclarationList(list) || list.declarations.length !== 1) return;
  const name = list.declarations[0].name;
  if (!ts.isIdentifier(name)) return;
  const locals = localNames(loop.statement);
  if (locals.has(name.text) || someNode(loop.expression, (node) => ts.isIdentifier(node) && locals.has(node.text)))
    return;
  return { loop, loopVariable: name.text, locals };
}

// A for-of whose only round trip is `call`, issued unconditionally from a top-level statement of the body.
function loopSite(call) {
  const awaited = call.parent;
  const iteration = enclosingIteration(call);
  if (!ts.isAwaitExpression(awaited) || iteration?.kind !== 'loop') return;
  const site = forOfLoop(iteration.node);
  const body = site?.loop.statement;
  if (!body || !ts.isBlock(body)) return;
  const statement = body.statements.find((candidate) => candidate.pos <= call.pos && call.end <= candidate.end);
  if (!statement || !plainPath(awaited, statement)) return;
  const earlier = body.statements.slice(0, body.statements.indexOf(statement));
  if (earlier.some((previous) => someNode(previous, (node) => exitKinds.has(node.kind)))) return;
  // The batched read runs before every iteration, so no other awaited work may change what it would read.
  const otherWork = someNode(
    body,
    (node) =>
      (ts.isAwaitExpression(node) && node !== awaited) ||
      ts.isYieldExpression(node) ||
      (ts.isForOfStatement(node) && !!node.awaitModifier),
  );
  const root = receiverRoot(call.expression.expression);
  const sameClient = someNode(
    body,
    (node) =>
      ts.isCallExpression(node) &&
      node !== call &&
      ts.isPropertyAccessExpression(node.expression) &&
      receiverRoot(node.expression.expression) === root,
  );
  if (otherWork || !root || sameClient) return;
  return { ...site, statement, awaited };
}

const freshIteratorMethods = new Set(['entries', 'values', 'keys']);

// The loop's collection in a form that can be iterated again before the loop without draining it.
function itemSource(expression) {
  const value = ts.skipParentheses(expression);
  if (isPlainReference(value)) {
    const kind = collectionKind(value);
    return kind && { text: textOf(value), kind, fixed: fixedList(value) };
  }
  if (
    ts.isCallExpression(value) &&
    ts.isPropertyAccessExpression(value.expression) &&
    !value.arguments.length &&
    freshIteratorMethods.has(value.expression.name.text) &&
    isPlainReference(value.expression.expression)
  ) {
    // Each call returns a fresh iterator, so the loop's own iterator is untouched whatever the owner is.
    const owner = value.expression.expression;
    const ownerKind = collectionKind(owner);
    const method = value.expression.name.text;
    return { text: textOf(value), kind: 'iterable', method, owner: textOf(owner), ownerKind, fixed: fixedList(owner) };
  }
  const fallback =
    ts.isBinaryExpression(value) &&
    [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken].includes(value.operatorToken.kind) &&
    isPlainReference(value.left) &&
    ts.isArrayLiteralExpression(value.right) &&
    !value.right.elements.length;
  if (fallback) return { text: textOf(value), kind: 'iterable', fixed: false };
}

// A for-of whose items can be listed again before it: its binding, collection and the names its body writes.
function forOfBinding(loop) {
  if (!ts.isForOfStatement(loop) || loop.awaitModifier) return;
  if (!(ts.isBlock(loop.parent) || ts.isSourceFile(loop.parent)) || !startsLine(loop)) return;
  const list = loop.initializer;
  if (!ts.isVariableDeclarationList(list) || list.declarations.length !== 1) return;
  const pattern = list.declarations[0].name;
  const names = bindingNames(pattern);
  const source = itemSource(loop.expression);
  const locals = localNames(loop.statement);
  if (!source || [...names].some((name) => locals.has(name))) return;
  if (someNode(loop.expression, (node) => ts.isIdentifier(node) && locals.has(node.text))) return;
  return { loop, pattern, names, source, locals };
}

function mentions(text, name) {
  // Over-matching `item.name` only keeps a parameter; missing `...name` would drop one the result reads.
  return new RegExp(`(?<![\\w$])${name.replace(/\$/g, '\\$')}(?![\\w$])`).test(text);
}

// `[open, close]` around a per-item expression so it is evaluated once for every item of the loop.
function mapParts(binding, result) {
  const { pattern, source } = binding;
  if (ts.isIdentifier(pattern)) {
    return source.kind === 'array'
      ? [`${source.text}.map((${pattern.text}) => `, ')']
      : [`Array.from(${source.text}, (${pattern.text}) => `, ')'];
  }
  const elements = ts.isArrayBindingPattern(pattern) ? pattern.elements : [];
  const plainPair =
    elements.length === 2 &&
    elements.every(
      (element) =>
        !ts.isOmittedExpression(element) &&
        ts.isIdentifier(element.name) &&
        !element.initializer &&
        !element.dotDotDotToken,
    );
  if (source.method === 'entries' && source.ownerKind === 'array' && plainPair) {
    const [index, item] = elements.map((element) => element.name.text);
    // An unused item keeps its slot with a leading underscore so unused-parameter checks stay quiet.
    const parameters = mentions(result, index) ? `${mentions(result, item) ? item : `_${item}`}, ${index}` : item;
    return [`${source.owner}.map((${parameters}) => `, ')'];
  }
  const parameter = elements.length ? arrayParameter(elements, result) : textOf(pattern);
  if (source.kind === 'array') return [`${source.text}.map((${parameter}) => `, ')'];
  return [`Array.from(${source.text}, (${parameter}) => `, ')'];
}

// An array pattern whose names `result` never reads become holes, so the callback declares nothing it ignores.
function arrayParameter(elements, result) {
  const kept = elements.map((element) => {
    const plainName =
      !ts.isOmittedExpression(element) &&
      ts.isIdentifier(element.name) &&
      !element.initializer &&
      !element.dotDotDotToken;
    return plainName && !mentions(result, element.name.text) ? '' : textOf(element);
  });
  while (kept.length && !kept.at(-1)) kept.pop();
  return `[${kept.join(', ')}]`;
}

// `result` evaluated for every item of the loop, as an array.
function mapItems(binding, result) {
  if (ts.isIdentifier(binding.pattern) && result === binding.pattern.text)
    return binding.source.kind === 'array' ? binding.source.text : `Array.from(${binding.source.text})`;
  const [open, close] = mapParts(binding, result);
  return `${open}${result.startsWith('{') ? `(${result})` : result}${close}`;
}

function readsOnlyNames(expression, names, locals) {
  let usesLoopVariable = false;
  const unsafe = someNode(expression, (node) => {
    if (ts.isAwaitExpression(node) || ts.isYieldExpression(node) || ts.isFunctionLike(node) || mutationTarget(node))
      return true;
    if (!ts.isIdentifier(node) || !isReference(node)) return false;
    if (names.has(node.text)) usesLoopVariable = true;
    else if (locals.has(node.text)) return true;
    return false;
  });
  return unsafe ? undefined : { usesLoopVariable };
}

// Whether reaching `awaited` from the top of its statement depends on a branch.
function conditionalPath(awaited, statement) {
  for (let child = awaited; child !== statement; child = child.parent) {
    const parent = child.parent;
    if (ts.isIfStatement(parent) && parent.expression !== child) return true;
    if (ts.isConditionalExpression(parent) && parent.condition !== child) return true;
    if (ts.isCaseClause(parent) || ts.isDefaultClause(parent)) return true;
    const shortCircuit = [
      ts.SyntaxKind.AmpersandAmpersandToken,
      ts.SyntaxKind.BarBarToken,
      ts.SyntaxKind.QuestionQuestionToken,
    ];
    if (ts.isBinaryExpression(parent) && parent.right === child && shortCircuit.includes(parent.operatorToken.kind))
      return true;
  }
  return false;
}

// A read awaited once per item of a for-of. Other statements may surround it; the builder reports what to check.
function loopLookup(call) {
  const awaited = outerParentheses(call).parent;
  const iteration = enclosingIteration(call);
  if (!ts.isAwaitExpression(awaited) || iteration?.kind !== 'loop') return;
  const binding = forOfBinding(iteration.node);
  const body = binding?.loop.statement;
  if (!body || !ts.isBlock(body)) return;
  const statement = body.statements.find((candidate) => candidate.pos <= call.pos && call.end <= candidate.end);
  if (!statement) return;
  // A per-item try would now have to catch the batched read too.
  for (let current = awaited.parent; current !== body; current = current.parent)
    if (ts.isTryStatement(current) || ts.isCatchClause(current)) return;
  const index = body.statements.indexOf(statement);
  const guarded =
    body.statements.slice(0, index).some((previous) => someNode(previous, (node) => exitKinds.has(node.kind))) ||
    conditionalPath(awaited, statement);
  const otherAwaits = [];
  const blocked = someNode(body, (node) => {
    if (ts.isYieldExpression(node) || (ts.isForOfStatement(node) && node.awaitModifier)) return true;
    if (ts.isAwaitExpression(node) && node !== awaited) otherAwaits.push(node);
    return false;
  });
  if (blocked) return;
  const start = awaited.getStart();
  return {
    ...binding,
    statement,
    awaited,
    guarded,
    earlierAwaits: otherAwaits.filter((node) => node.end <= start),
    laterAwaits: otherAwaits.filter((node) => node.end > start),
  };
}

// A `const` declared earlier in the loop body from the item alone, so the key can be computed per item up front.
function inlinedLocal(identifier, site) {
  const index = site.loop.statement.statements.indexOf(site.statement);
  for (const statement of site.loop.statement.statements.slice(0, index)) {
    if (!ts.isVariableStatement(statement) || !(statement.declarationList.flags & ts.NodeFlags.Const)) continue;
    const declaration = statement.declarationList.declarations.find(
      (candidate) => ts.isIdentifier(candidate.name) && candidate.name.text === identifier.text,
    );
    if (!declaration?.initializer) continue;
    const locals = new Set([...site.locals].filter((name) => name !== identifier.text));
    if (readsOnlyNames(declaration.initializer, site.names, locals)?.usesLoopVariable) return declaration.initializer;
  }
}

const findOperator = /^[A-Z]\w*$/;

// The one filter property that depends on the item; the others must be the same on every iteration.
function itemKeyFilter(filter, site) {
  const properties = plainProperties(filter);
  if (!properties?.size) return;
  let key;
  for (const [field, property] of properties) {
    const value = propertyValue(property);
    if (textOf(property).includes('\n')) return;
    const reads = readsOnlyNames(value, site.names, site.locals);
    const local = !reads && ts.isIdentifier(value) && inlinedLocal(value, site);
    if (reads && !reads.usesLoopVariable) continue;
    if ((!reads && !local) || key || !identifierPattern.test(field)) return;
    const operator =
      ts.isCallExpression(value) && ts.isIdentifier(value.expression) && findOperator.test(value.expression.text);
    if (ts.isObjectLiteralExpression(value) || ts.isArrayLiteralExpression(value) || operator) return;
    key = { field, property, value, perItem: local || value };
  }
  return key && { ...key, properties };
}

// The key as computed for every item; under a guard it must not throw for the items the guard skipped.
function itemKeys(site, key) {
  let perItem = textOf(key.perItem);
  if (site.guarded) {
    const unsafe = someNode(
      key.perItem,
      (node) =>
        ts.isCallExpression(node) ||
        ts.isElementAccessExpression(node) ||
        ts.isNewExpression(node) ||
        ts.isTaggedTemplateExpression(node),
    );
    if (unsafe) return;
    const edits = [];
    someNode(key.perItem, (node) => {
      if (
        ts.isPropertyAccessExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        !node.questionDotToken
      )
        edits.push({ start: node.expression.end, end: node.name.getStart(), text: '?.' });
      return false;
    });
    perItem = textWith(key.perItem, edits);
  }
  const keys = mapItems(site, perItem);
  return site.guarded ? `${keys}.filter((key) => key != null)` : keys;
}

const readMethodPattern = /^(?:find|count|exists|aggregate|groupBy|get|has)/;
const batchWritePattern = /Many$/;

// What the reader must check once the read moves before the loop, or undefined when awaited work before it could
// change what it reads.
// Whether awaited work later in the body may write rows of this read: the same repository or client, or a call
// the builder cannot see into.
function mayWriteSameRows(awaited, receiverText, prismaRoot) {
  const call = ts.skipParentheses(awaited.expression);
  if (!ts.isCallExpression(call) || !ts.isPropertyAccessExpression(call.expression)) return true;
  const receiver = call.expression.expression;
  if (readMethodPattern.test(call.expression.name.text)) return false;
  if (receiver.kind === ts.SyntaxKind.ThisKeyword || textOf(receiver) === receiverText) return true;
  // Prisma writes on the same client can write this model through nested relations.
  return !!prismaRoot && receiverRoot(receiver) === prismaRoot;
}

// Keys that cannot repeat: items of a list fixed in the source, or each item's own `item.id`.
function distinctKeys(site, keyNode) {
  const value = ts.skipParentheses(keyNode);
  const ownId =
    ts.isPropertyAccessExpression(value) &&
    value.name.text === 'id' &&
    ts.isIdentifier(value.expression) &&
    site.names.has(value.expression.text);
  return site.source.fixed || ownId;
}

// What the reader must check once the read moves before the loop, or undefined when work in the loop could change
// what it reads: awaited writes before it, or later writes to the same rows when two items may share a key.
function loopWorkNote(site, receiverText, prismaRoot, keyNode) {
  const earlierWrites = [];
  for (const awaited of site.earlierAwaits) {
    const call = ts.skipParentheses(awaited.expression);
    if (!ts.isCallExpression(call) || !ts.isPropertyAccessExpression(call.expression)) return;
    const receiver = call.expression.expression;
    const method = call.expression.name.text;
    if (receiver.kind === ts.SyntaxKind.ThisKeyword || textOf(receiver) === receiverText) return;
    if (readMethodPattern.test(method)) continue;
    if (prismaRoot && receiverRoot(receiver) === prismaRoot && !batchWritePattern.test(method)) return;
    earlierWrites.push(textOf(call.expression));
  }
  const laterWrites = site.laterAwaits.some((awaited) => mayWriteSameRows(awaited, receiverText, prismaRoot));
  if (laterWrites && !distinctKeys(site, keyNode)) return;
  if (!site.laterAwaits.length && !earlierWrites.length) return [];
  const checked = earlierWrites.length
    ? ` and that ${[...new Set(earlierWrites)].join(', ')} cannot change what it reads`
    : '';
  return [
    `The read now runs once before the loop, so rows the loop itself writes are not seen by later items: check that no two items share a key${checked}.`,
  ];
}

function typeKind(type) {
  if (ts.isArrayTypeNode(type) || ts.isTupleTypeNode(type)) return 'array';
  if (ts.isTypeOperatorNode(type)) return typeKind(type.type);
  if (!ts.isTypeReferenceNode(type)) return 'iterable';
  const name = textOf(type.typeName);
  if (arrayTypeNames.has(name)) return 'array';
  if (!oneShotTypeNames.has(name)) return 'iterable';
}

function declarationOf(identifier) {
  const name = identifier.text;
  for (let scope = identifier.parent; scope; scope = scope.parent) {
    if (ts.isFunctionLike(scope)) {
      const parameter = scope.parameters.find(
        (candidate) => ts.isIdentifier(candidate.name) && candidate.name.text === name,
      );
      if (parameter) return parameter;
    }
    if (!ts.isBlock(scope) && !ts.isSourceFile(scope)) continue;
    for (const statement of scope.statements) {
      if (!ts.isVariableStatement(statement)) continue;
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.name.text === name) return declaration;
        if (!ts.isObjectBindingPattern(declaration.name)) continue;
        const element = declaration.name.elements.find((item) => ts.isIdentifier(item.name) && item.name.text === name);
        if (element) return element;
      }
    }
  }
}

function isArrayExpression(expression) {
  const value = ts.skipParentheses(expression);
  if (ts.isArrayLiteralExpression(value)) return true;
  if (ts.isAwaitExpression(value)) {
    const call = ts.skipParentheses(value.expression);
    return (
      ts.isCallExpression(call) &&
      ts.isPropertyAccessExpression(call.expression) &&
      awaitedListMethods.has(call.expression.name.text)
    );
  }
  if (!ts.isCallExpression(value) || !ts.isPropertyAccessExpression(value.expression)) return false;
  const callee = textOf(value.expression);
  return (
    arrayProducingMethods.has(value.expression.name.text) ||
    ['Array.from', 'Array.of', 'Object.keys', 'Object.values', 'Object.entries'].includes(callee)
  );
}

// 'array' when `.map` exists, 'iterable' when Array.from copies it safely, undefined when it may be one-shot.
function collectionKind(expression) {
  if (!ts.isIdentifier(expression)) return 'iterable';
  const declaration = declarationOf(expression);
  if (!declaration) return 'iterable';
  if (ts.isBindingElement(declaration)) {
    const name = (declaration.propertyName ?? declaration.name).text;
    const source = declaration.parent.parent;
    const initializer =
      ts.isVariableDeclaration(source) && source.initializer && ts.skipParentheses(source.initializer);
    const call = initializer && ts.isAwaitExpression(initializer) && ts.skipParentheses(initializer.expression);
    const pgRows =
      name === 'rows' &&
      call &&
      ts.isCallExpression(call) &&
      ts.isPropertyAccessExpression(call.expression) &&
      call.expression.name.text === 'query';
    return pgRows ? 'array' : undefined;
  }
  if (declaration.type) return typeKind(declaration.type);
  if (ts.isParameter(declaration)) return 'iterable';
  if (!declaration.initializer) return;
  if (isArrayExpression(declaration.initializer)) return 'array';
  const initializer = ts.skipParentheses(declaration.initializer);
  if (ts.isNewExpression(initializer) && ['Set', 'Map'].includes(textOf(initializer.expression))) return 'iterable';
  if (ts.isAsExpression(initializer) || ts.isSatisfiesExpression(initializer)) return typeKind(initializer.type);
}

// A list whose items are fixed in the source (`const PLANS = [...]` or an imported SCREAMING_CASE constant), so a
// reader can check that its keys are distinct.
function fixedList(expression) {
  const value = ts.skipParentheses(expression);
  if (ts.isPropertyAccessExpression(value)) return isPlainReference(value) && fixedList(value.expression);
  if (!ts.isIdentifier(value)) return false;
  if (/^[A-Z][A-Z0-9_]*$/.test(value.text)) return true;
  const declaration = declarationOf(value);
  return (
    !!declaration &&
    ts.isVariableDeclaration(declaration) &&
    !!(declaration.parent.flags & ts.NodeFlags.Const) &&
    !!declaration.initializer &&
    ts.isArrayLiteralExpression(ts.skipParentheses(declaration.initializer))
  );
}

// `items.map((item) => result)`, or Array.from when the collection may not be an array.
function mapCollection(collection, parameter, result) {
  const kind = collectionKind(collection);
  if (!kind) return;
  const items = textOf(collection);
  if (result === parameter) return kind === 'array' ? items : `Array.from(${items})`;
  const callback = `(${parameter}) => ${result.startsWith('{') ? `(${result})` : result}`;
  return kind === 'array' ? `${items}.map(${callback})` : `Array.from(${items}, ${callback})`;
}

function propertyName(property) {
  if (!property.name || ts.isComputedPropertyName(property.name)) return;
  if (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) return property.name.text;
}

// Property assignments by name, or undefined when spreads, methods, computed or repeated names hide the shape.
function plainProperties(object) {
  if (!object || !ts.isObjectLiteralExpression(object)) return;
  const properties = new Map();
  for (const property of object.properties) {
    const name = propertyName(property);
    if (name === undefined || properties.has(name)) return;
    properties.set(name, property);
  }
  return properties;
}

function propertyValue(property) {
  return ts.isShorthandPropertyAssignment(property) ? property.name : property.initializer;
}

function plural(name) {
  if (/[^aeiou]y$/.test(name)) return name.slice(0, -1) + 'ies';
  if (/(?:s|x|ch|sh)$/.test(name)) return name + 'es';
  return name + 's';
}

function capitalized(name) {
  return name[0].toUpperCase() + name.slice(1);
}

function camelCase(name) {
  return name.replace(/_+([a-z0-9])/g, (_, letter) => letter.toUpperCase());
}

function usableName(sourceFile, base) {
  if (!identifierPattern.test(base) || ts.stringToToken(base) !== undefined) return;
  return freshName(sourceFile, base);
}

function asConst(sourceFile) {
  return typeScriptFile.test(sourceFile.fileName) ? ' as const' : '';
}

// Batched rows indexed by one key field, then each iteration reads its row from the Map.
// `base`, or `existingBase` when the file already uses `base`, before falling back to a numbered name.
function rowsName(sourceFile, base) {
  if (!identifierPattern.test(base) || ts.stringToToken(base) !== undefined) return;
  if (freshName(sourceFile, base) === base) return base;
  return freshName(sourceFile, `existing${capitalized(base)}`);
}

function keyedLookup({ site, sourceFile, rowsBase, rowName, field, keyValue, fetchLine, note }) {
  const rows = rowsName(sourceFile, rowsBase);
  const byKey = rows && usableName(sourceFile, `${rows}By${capitalized(field)}`);
  if (!byKey) return;
  const entry = `[${rowName}.${field}, ${rowName}]${asConst(sourceFile)}`;
  return {
    edits: [
      insertLinesBefore(site.loop, [
        `const ${rows} = await ${fetchLine};`,
        `const ${byKey} = new Map(${rows}.map((${rowName}) => ${entry}));`,
      ]),
      replaceNode(site.awaited, inSlot(site.awaited, `${byKey}.get(${textOf(keyValue)}) ?? null`)),
    ],
    note,
  };
}

// One indentation level of the loop body, so generated blocks match the file's own style.
function indentationStep(loop) {
  const body = loop.statement;
  const inner = ts.isBlock(body) && body.statements[0];
  const step = inner ? indentationOf(inner).slice(indentationOf(loop).length) : '';
  return step || '  ';
}

// Batched rows grouped by one key field in query order, then each iteration reads its list from the Map. Items
// that may share a key get their own copy of the list, as each per-item query returned a fresh array.
function groupedLookup({ site, sourceFile, rowsBase, rowName, field, keyValue, fetchLine, note }) {
  const rows = rowsName(sourceFile, rowsBase);
  const byKey = rows && usableName(sourceFile, `${rows}By${capitalized(field)}`);
  const group = byKey && usableName(sourceFile, 'group');
  if (!group || rowName === rows) return;
  const step = indentationStep(site.loop);
  const mapType = typeScriptFile.test(sourceFile.fileName) ? `<unknown, typeof ${rows}>` : '';
  const lookup = `${byKey}.get(${textOf(keyValue)}) ?? []`;
  return {
    edits: [
      insertLinesBefore(site.loop, [
        `const ${rows} = await ${fetchLine};`,
        `const ${byKey} = new Map${mapType}();`,
        `for (const ${rowName} of ${rows}) {`,
        `${step}const ${group} = ${byKey}.get(${rowName}.${field}) ?? [];`,
        `${step}${group}.push(${rowName});`,
        `${step}${byKey}.set(${rowName}.${field}, ${group});`,
        '}',
      ]),
      replaceNode(site.awaited, inSlot(site.awaited, distinctKeys(site, keyValue) ? lookup : `[...(${lookup})]`)),
    ],
    note,
  };
}

// List reads that may take `take`, `skip`, `cursor` or `distinct` are never batched: those limit rows per key.
const groupedKeyNote =
  'Rows are grouped through a Map in query order, so the key must be a string or number of the same type the column comes back as (not a Date, Decimal, Buffer or a bigint read as a string), and is compared exactly, without a case-insensitive collation.';
const nullKeyNote =
  'An item whose key is null or undefined now gets no rows, where its own query matched rows with a null key (or, for undefined, no filter at all).';

// The key is the item's own `id`, which is never null.
function ownIdKey(keyValue) {
  const value = ts.skipParentheses(keyValue);
  return ts.isPropertyAccessExpression(value) && value.name.text === 'id';
}

const mapKeyNote =
  'Rows are matched through a Map, so the key must be a string or number value (not a Date, Decimal or Buffer).';

const setKeyNote =
  'Keys are matched through a Set, so the key must be a string or number value (not a Date, Decimal or Buffer).';
const duplicateKeyNote =
  'If several rows share a key, the Map keeps the last one, where the per-item query returned whichever came first.';

function joinNotes(notes) {
  return notes.filter(Boolean).join(' ');
}

// The options besides `where`, unchanged: each must be one line and the same on every iteration.
function invariantOptions(options, site, allowed) {
  const texts = new Map();
  for (const [name, property] of options) {
    if (name === 'where') continue;
    const reads = ts.isPropertyAssignment(property) && readsOnlyNames(property.initializer, site.names, site.locals);
    if (!allowed.has(name) || !reads || reads.usesLoopVariable || textOf(property).includes('\n')) return;
    texts.set(name, textOf(property));
  }
  return texts;
}

function whereWith(key, keyCondition) {
  const parts = [...key.properties].map(([name, property]) =>
    property === key.property ? `${name}: ${keyCondition}` : textOf(property),
  );
  return `{ ${parts.join(', ')} }`;
}

// `{ field: true }` with the key field selected, adding it when missing.
function selectingKey(select, field) {
  const selected = ts.isPropertyAssignment(select) && plainProperties(select.initializer);
  if (!selected) return;
  const current = selected.get(field);
  if (current) return ts.isPropertyAssignment(current) && current.initializer.kind === ts.SyntaxKind.TrueKeyword && {};
  const fields = [...selected.values()].map(textOf);
  return { text: `select: { ${[...fields, `${field}: true`].join(', ')} }`, added: true };
}

const prismaModes = { findUnique: 'one', findFirst: 'one', findMany: 'list', count: 'count', aggregate: 'aggregate' };
const prismaAggregates = new Set(['_avg', '_sum', '_min', '_max', '_count']);

// What `aggregate` returns for a key with no rows, which groupBy leaves out.
function emptyAggregate(options) {
  const parts = [];
  for (const [name, property] of options) {
    if (name === 'where') continue;
    const fields = ts.isPropertyAssignment(property) && plainProperties(property.initializer);
    if (!prismaAggregates.has(name) || !fields?.size) return;
    const empty = name === '_count' ? '0' : 'null';
    for (const field of fields.values())
      if (!ts.isPropertyAssignment(field) || field.initializer.kind !== ts.SyntaxKind.TrueKeyword) return;
    parts.push(`${name}: { ${[...fields.keys()].map((field) => `${field}: ${empty}`).join(', ')} }`);
  }
  return parts.length ? `{ ${parts.join(', ')} }` : undefined;
}

function prismaLookup(call, sourceFile) {
  const delegate = call.expression.expression;
  const mode = prismaModes[call.expression.name.text];
  if (!mode || !ts.isPropertyAccessExpression(delegate) || !isPlainReference(delegate) || call.arguments.length !== 1)
    return;
  const site = loopLookup(call);
  const options = site && plainProperties(call.arguments[0]);
  const where = options?.get('where');
  if (!where || !ts.isPropertyAssignment(where)) return;
  const key = itemKeyFilter(where.initializer, site);
  const keys = key && itemKeys(site, key);
  const workNotes = keys && loopWorkNote(site, textOf(delegate), receiverRoot(delegate), key.perItem);
  if (!workNotes) return;
  const model = delegate.name.text;
  const condition = whereWith(key, `{ in: ${keys} }`);
  if (mode === 'count' || mode === 'aggregate') {
    let empty = '0';
    let extra = '_count: { _all: true }';
    if (mode === 'count' && options.size !== 1) return;
    if (mode === 'aggregate') {
      empty = emptyAggregate(options);
      const others = empty && invariantOptions(options, site, prismaAggregates);
      if (!others) return;
      extra = [...others.values()].join(', ');
    }
    const groups = usableName(sourceFile, `${model}${mode === 'count' ? 'Counts' : 'Totals'}`);
    const byKey = groups && usableName(sourceFile, `${groups.replace(/s$/, '')}By${capitalized(key.field)}`);
    if (!byKey) return;
    const value = mode === 'count' ? 'row._count._all' : 'row';
    return {
      edits: [
        insertLinesBefore(site.loop, [
          `const ${groups} = await ${textOf(delegate)}.groupBy({ by: ['${key.field}'], where: ${condition}, ${extra} });`,
          `const ${byKey} = new Map(${groups}.map((row) => [row.${key.field}, ${value}]${asConst(sourceFile)}));`,
        ]),
        replaceNode(site.awaited, inSlot(site.awaited, `${byKey}.get(${textOf(key.value)}) ?? ${empty}`)),
      ],
      note: joinNotes([mapKeyNote, ...workNotes]),
    };
  }
  const allowed = new Set(mode === 'list' ? ['select', 'include', 'orderBy'] : ['select', 'include']);
  const others = invariantOptions(options, site, allowed);
  const select = options.get('select') && selectingKey(options.get('select'), key.field);
  if (!others || (options.has('select') && !select)) return;
  if (select?.added) others.set('select', select.text);
  const fetchLine = `${textOf(delegate)}.findMany({ ${[`where: ${condition}`, ...others.values()].join(', ')} })`;
  if (mode === 'list')
    return groupedLookup({
      site,
      sourceFile,
      rowsBase: plural(model),
      rowName: model,
      field: key.field,
      keyValue: key.value,
      fetchLine,
      note: joinNotes([
        groupedKeyNote,
        !ownIdKey(key.value) && nullKeyNote,
        select?.added && `The select now also reads \`${key.field}\` to group rows by item.`,
        ...workNotes,
      ]),
    });
  const unique = call.expression.name.text === 'findUnique' || key.field === 'id';
  return keyedLookup({
    site,
    sourceFile,
    rowsBase: plural(model),
    rowName: model,
    field: key.field,
    keyValue: key.value,
    fetchLine,
    note: joinNotes([
      mapKeyNote,
      !unique && duplicateKeyNote,
      select?.added && `The select now also reads \`${key.field}\` to match rows to items.`,
      ...workNotes,
    ]),
  });
}

// `data: { ... }` holding only scalar values; nested objects may be relation writes createMany cannot run.
function flatData(options) {
  const properties = plainProperties(options);
  const data = properties?.size === 1 && properties.get('data');
  if (!data || !ts.isPropertyAssignment(data) || !ts.isObjectLiteralExpression(data.initializer)) return;
  const nested = someNode(
    data.initializer,
    (node) =>
      node !== data.initializer &&
      (ts.isObjectLiteralExpression(node) || ts.isFunctionLike(node) || ts.isAwaitExpression(node)),
  );
  return nested ? undefined : data.initializer;
}

const createManyNote =
  'createMany inserts every row in one statement: it returns only a count, runs no nested writes, and one failing row now rejects the whole batch.';

function reindent(text, from, to) {
  return text
    .split('\n')
    .map((line, index) => (index > 0 && line.startsWith(from) ? to + line.slice(from.length) : line))
    .join('\n');
}

function indentationOf(node) {
  const sourceFile = node.getSourceFile();
  const start = lineStart(sourceFile.text, node.getStart(sourceFile));
  return /^[ \t]*/.exec(sourceFile.text.slice(start))[0];
}

function prismaCreateMany(call) {
  const delegate = call.expression.expression;
  const data = call.arguments.length === 1 && flatData(call.arguments[0]);
  if (!ts.isPropertyAccessExpression(delegate) || !isPlainReference(delegate) || !data) return;
  const createMany = (items) => `await ${textOf(delegate)}.createMany({ data: ${items} })`;
  const iteration = enclosingIteration(call);
  if (iteration?.kind === 'callback') return prismaCreateManyFromMap(call, iteration, data, createMany);
  const site = loopWrite(call);
  if (!site || !readsOnlyNames(data, site.names, site.locals)) return;
  const edits = wrapLoop(
    {
      site,
      inner: data,
    },
    (items) => `${createMany(items)};`,
    ['(', ')'],
    `await ${textOf(delegate)}.createMany({ data: `,
    ' });',
  );
  return edits && { edits, note: createManyNote };
}

// A for-of whose whole body is one awaited write with an unused result.
function loopWrite(call) {
  const iteration = enclosingIteration(call);
  const site = iteration?.kind === 'loop' && forOfBinding(iteration.node);
  if (!site) return;
  const body = site.loop.statement;
  const statement = ts.isBlock(body) && body.statements.length === 1 ? body.statements[0] : body;
  if (
    !ts.isExpressionStatement(statement) ||
    statement.expression !== call.parent ||
    !ts.isAwaitExpression(call.parent)
  )
    return;
  return { ...site, statement };
}

// True when `text` between the offsets holds a comment.
function hasCommentBetween(text, from, to) {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, text.slice(from, to));
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan())
    if (token === ts.SyntaxKind.SingleLineCommentTrivia || token === ts.SyntaxKind.MultiLineCommentTrivia) return true;
  return false;
}

// Replaces the loop with one call over every item: whole when short, else only its head and tail so the per-item
// text between keeps its lines (one level deeper than the new code expects).
function wrapLoop({ site, inner }, whole, [innerOpen, innerClose], head, tail) {
  // Only the per-item text survives the rewrite, so a comment elsewhere in the loop would be silently dropped.
  const text = site.loop.getSourceFile().text;
  if (hasCommentBetween(text, site.loop.getStart(), inner.getStart())) return;
  if (hasCommentBetween(text, inner.end, site.loop.end)) return;
  const loopText = textOf(site.loop);
  const innerText = reindent(textOf(inner), indentationOf(site.statement), indentationOf(site.loop));
  const items = mapItems(site, innerText);
  if (loopText.split('\n').length <= 6) return [replaceNode(site.loop, whole(items))];
  const [open, close] = mapParts(site, textOf(inner));
  return [
    { start: site.loop.getStart(), end: inner.getStart(), text: `${head}${open}${innerOpen}` },
    { start: inner.end, end: site.loop.end, text: `${innerClose}${close}${tail}` },
  ];
}

const transactionNote =
  'The writes now run in one transaction: if one fails, the earlier ones roll back instead of staying applied.';
const prismaWriteMethods = new Set(['create', 'update', 'upsert', 'delete']);

// The client of `client.model.method(...)` when it can open a batch transaction (not an interactive `tx`).
function prismaClientOf(delegate) {
  if (!ts.isPropertyAccessExpression(delegate) || !isPlainReference(delegate)) return;
  const client = delegate.expression;
  const name = ts.isPropertyAccessExpression(client) ? client.name.text : textOf(client);
  if (/prisma/i.test(name)) return textOf(client);
}

// Per-item Prisma writes become one `$transaction([...])`: one round trip to the engine and one database transaction.
function prismaWriteTransaction(call) {
  const client = prismaClientOf(call.expression.expression);
  if (!client) return;
  const iteration = enclosingIteration(call);
  if (iteration?.kind === 'callback') {
    const { node: mapCall, callback, method } = iteration;
    const all = mapCall.parent;
    if (
      method !== 'map' ||
      !ts.isArrowFunction(callback) ||
      callback.body !== call ||
      callback.modifiers?.length ||
      !ts.isCallExpression(all) ||
      textOf(all.expression) !== 'Promise.all' ||
      all.arguments.length !== 1 ||
      all.arguments[0] !== mapCall
    )
      return;
    return { edits: [replaceNode(all.expression, `${client}.$transaction`)], note: transactionNote };
  }
  const site = loopWrite(call);
  if (!site || call.arguments.some((argument) => !readsOnlyNames(argument, site.names, site.locals))) return;
  const transaction = (items) => `await ${client}.$transaction(${items});`;
  const edits = wrapLoop({ site, inner: call }, transaction, ['', ''], `await ${client}.$transaction(`, ');');
  return edits && { edits, note: transactionNote };
}

// The callback's whole job is the create: `(item) => db.m.create(...)` or a block that only awaits or returns it.
function onlyCreates(callback, call) {
  const outer = ts.isAwaitExpression(call.parent) ? call.parent : call;
  if (callback.body === outer) return true;
  if (!ts.isBlock(callback.body) || callback.body.statements.length !== 1) return false;
  const [statement] = callback.body.statements;
  return (
    (ts.isExpressionStatement(statement) && statement.expression === outer && outer !== call) ||
    (ts.isReturnStatement(statement) && statement.expression === outer)
  );
}

function prismaCreateManyFromMap(call, iteration, data, createMany) {
  const { node: mapCall, callback, method } = iteration;
  const all = mapCall.parent;
  const awaited = all?.parent;
  if (
    method !== 'map' ||
    !ts.isArrowFunction(callback) ||
    callback.parameters.length !== 1 ||
    !ts.isIdentifier(callback.parameters[0].name) ||
    callback.parameters[0].initializer ||
    callback.parameters[0].dotDotDotToken ||
    mapCall.arguments.length !== 1 ||
    !isPlainReference(mapCall.expression.expression) ||
    !onlyCreates(callback, call) ||
    !ts.isCallExpression(all) ||
    textOf(all.expression) !== 'Promise.all' ||
    all.arguments.length !== 1 ||
    !ts.isAwaitExpression(awaited) ||
    !ts.isExpressionStatement(awaited.parent)
  )
    return;
  const parameter = callback.parameters[0].name.text;
  if (!readsOnly(data, parameter, localNames(callback.body))) return;
  const items = `${textOf(mapCall.expression)}((${textOf(callback.parameters[0])}) => (${textOf(data)}))`;
  return { edits: [replaceNode(awaited, createMany(items))], note: createManyNote };
}

function prismaQueryInLoop({ node, sourceFile }) {
  const call = calleeCall(node);
  if (!call || !ts.isPropertyAccessExpression(call.expression)) return;
  const method = call.expression.name.text;
  if (prismaWriteMethods.has(method))
    return (method === 'create' && prismaCreateMany(call)) || prismaWriteTransaction(call);
  if (prismaModes[method]) return prismaLookup(call, sourceFile);
}

function repositoryNames(receiver) {
  const last = ts.isPropertyAccessExpression(receiver) ? receiver.name.text : textOf(receiver);
  const base = last.replace(/(?:Repository|Repo|repository|repo)$/, '');
  if (!base || base === 'this') return { rowsBase: 'rows', rowName: 'row' };
  const lowered = base[0].toLowerCase() + base.slice(1);
  // `case`, `default` and other keywords cannot name the callback parameter.
  if (lowered.endsWith('s')) return { rowsBase: lowered, rowName: 'row' };
  if (ts.stringToToken(lowered) !== undefined) return { rowsBase: plural(lowered), rowName: 'row' };
  return { rowsBase: plural(lowered), rowName: lowered };
}

// Names for rows of `repo`, `this.userRepository` or `source.getRepository(User)`, which is safe to evaluate once.
function repositoryReceiver(receiver) {
  if (isPlainReference(receiver)) return repositoryNames(receiver);
  const plainGetRepository =
    ts.isCallExpression(receiver) &&
    ts.isPropertyAccessExpression(receiver.expression) &&
    receiver.expression.name.text === 'getRepository' &&
    isPlainReference(receiver.expression.expression) &&
    receiver.arguments.length === 1 &&
    ts.isIdentifier(receiver.arguments[0]);
  if (plainGetRepository) return repositoryNames(receiver.arguments[0]);
}

// The local name of TypeORM's `In`, adding it to an existing named import, or as a new import, when needed.
function typeormIn(sourceFile) {
  let lastImport;
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    lastImport = statement;
    const clause = statement.importClause;
    const bindings = clause?.namedBindings;
    if (
      !clause ||
      clause.isTypeOnly ||
      statement.moduleSpecifier.text !== 'typeorm' ||
      !bindings ||
      !ts.isNamedImports(bindings)
    )
      continue;
    const existing = bindings.elements.find((element) => (element.propertyName ?? element.name).text === 'In');
    if (existing) return existing.isTypeOnly ? undefined : { name: existing.name.text, edits: [] };
    if (freshName(sourceFile, 'In') !== 'In' || !bindings.elements.length) return;
    const last = bindings.elements.at(-1);
    return { name: 'In', edits: [{ start: last.end, end: last.end, text: ', In' }] };
  }
  if (!lastImport || freshName(sourceFile, 'In') !== 'In') return;
  const quote = textOf(lastImport.moduleSpecifier)[0];
  const line = `\nimport { In } from ${quote}typeorm${quote};`;
  return { name: 'In', edits: [{ start: lastImport.end, end: lastImport.end, text: line }] };
}

const typeormModes = {
  find: 'list',
  findBy: 'list',
  findOne: 'one',
  findOneBy: 'one',
  exists: 'exists',
  existsBy: 'exists',
  count: 'count',
  countBy: 'count',
};
const typeormRowOptions = new Set(['relations', 'select', 'withDeleted', 'loadEagerRelations']);
// A shared `order` keeps each key's rows in the same order once they are grouped; `take` and `skip` would not.
const typeormListOptions = new Set([...typeormRowOptions, 'order']);
const typeormOptionsByMode = { one: typeormRowOptions, list: typeormListOptions };

// `select` naming the key column, as an object or an array of property names.
function typeormSelectsKey(select, field) {
  const value = ts.isPropertyAssignment(select) && select.initializer;
  if (value && ts.isArrayLiteralExpression(value))
    return value.elements.some((element) => ts.isStringLiteral(element) && element.text === field);
  const current = value && plainProperties(value)?.get(field);
  return !!current && ts.isPropertyAssignment(current) && current.initializer.kind === ts.SyntaxKind.TrueKeyword;
}

function typeormLookup(call, sourceFile) {
  const method = call.expression.name.text;
  const mode = typeormModes[method];
  const receiver = call.expression.expression;
  const names = mode && call.arguments.length === 1 && repositoryReceiver(receiver);
  const site = names && loopLookup(call);
  if (!site || someNode(receiver, (node) => ts.isIdentifier(node) && site.locals.has(node.text))) return;
  const byFilter = method.endsWith('By');
  const options = byFilter ? new Map() : plainProperties(call.arguments[0]);
  const where = byFilter ? call.arguments[0] : options?.get('where');
  if (!where || (!byFilter && !ts.isPropertyAssignment(where))) return;
  const key = itemKeyFilter(byFilter ? where : where.initializer, site);
  const others = key && invariantOptions(options, site, typeormOptionsByMode[mode] ?? new Set());
  const keys = others && itemKeys(site, key);
  const operator = keys && typeormIn(sourceFile);
  const workNotes = operator && loopWorkNote(site, textOf(receiver), undefined, key.perItem);
  if (!workNotes || (options.has('select') && !typeormSelectsKey(options.get('select'), key.field))) return;
  const condition = whereWith(key, `${operator.name}(${keys})`);
  const repository = textOf(receiver);
  const keyText = textOf(key.value);
  const base = names.rowName === 'row' ? names.rowsBase.replace(/s$/, '') : names.rowName;
  const notes = [mapKeyNote, ...workNotes];
  const fetchLine = byFilter
    ? `${repository}.findBy(${condition})`
    : `${repository}.find({ ${[`where: ${condition}`, ...others.values()].join(', ')} })`;
  let fix;
  if (mode === 'list') {
    notes[0] = groupedKeyNote;
    if (!ownIdKey(key.value)) notes.splice(1, 0, nullKeyNote);
    fix = groupedLookup({ site, sourceFile, ...names, field: key.field, keyValue: key.value, fetchLine, note: '' });
  } else if (mode === 'one') {
    if (key.field !== 'id') notes.splice(1, 0, duplicateKeyNote);
    fix = keyedLookup({ site, sourceFile, ...names, field: key.field, keyValue: key.value, fetchLine, note: '' });
  } else if (mode === 'exists') {
    notes[0] = setKeyNote;
    const rows = usableName(sourceFile, names.rowsBase);
    const keySet = rows && usableName(sourceFile, `${base}${capitalized(plural(key.field))}`);
    if (!keySet) return;
    fix = {
      edits: [
        insertLinesBefore(site.loop, [
          `const ${rows} = await ${repository}.find({ where: ${condition}, select: { ${key.field}: true } });`,
          `const ${keySet} = new Set(${rows}.map((row) => row.${key.field}));`,
        ]),
        replaceNode(site.awaited, inSlot(site.awaited, `${keySet}.has(${keyText})`)),
      ],
    };
  } else {
    const counts = usableName(sourceFile, `${base}Counts`);
    const byKey = counts && usableName(sourceFile, `${base}CountBy${capitalized(key.field)}`);
    if (!byKey) return;
    fix = {
      edits: [
        insertLinesBefore(site.loop, [
          `const ${counts} = await ${repository}`,
          `  .createQueryBuilder('row')`,
          `  .select('row.${key.field}', 'groupKey')`,
          `  .addSelect('COUNT(*)', 'total')`,
          `  .where(${condition})`,
          `  .groupBy('row.${key.field}')`,
          `  .getRawMany();`,
          `const ${byKey} = new Map(${counts}.map((row) => [row.groupKey, Number(row.total)]${asConst(sourceFile)}));`,
        ]),
        replaceNode(site.awaited, inSlot(site.awaited, `${byKey}.get(${keyText}) ?? 0`)),
      ],
    };
  }
  return fix && { edits: [...fix.edits, ...operator.edits], note: joinNotes(notes) };
}

function ormQueryInLoop({ node, finding, sourceFile }) {
  if (!finding.message?.startsWith('TypeORM.')) return;
  const call = calleeCall(node);
  if (!call || !ts.isPropertyAccessExpression(call.expression)) return;
  return typeormLookup(call, sourceFile);
}

function singleLineLiteral(node) {
  if (!ts.isStringLiteral(node) && !ts.isNoSubstitutionTemplateLiteral(node)) return false;
  const raw = textOf(node);
  return raw.slice(1, -1) === node.text && !node.text.includes('\n');
}

// How the loop reads the pg result: `const { rows } = await ...` or `(await ...).rows`.
function pgRowsUse(awaited) {
  const parent = awaited.parent;
  if (ts.isVariableDeclaration(parent) && ts.isObjectBindingPattern(parent.name)) {
    const [element, ...rest] = parent.name.elements;
    if (rest.length || element.dotDotDotToken || element.initializer || !ts.isIdentifier(element.name)) return;
    if ((element.propertyName ?? element.name).text !== 'rows') return;
    return { target: parent, text: (lookup) => `${element.name.text} = ${lookup}` };
  }
  const outer = outerParentheses(awaited);
  const access = outer.parent;
  if (outer !== awaited && ts.isPropertyAccessExpression(access) && access.name.text === 'rows')
    return { target: access, text: (lookup) => inSlot(access, lookup) };
}

function pgQueryInLoop({ node, sourceFile }) {
  const call = calleeCall(node);
  if (!call || !ts.isPropertyAccessExpression(call.expression) || call.arguments.length !== 2) return;
  const [query, parameters] = call.arguments;
  if (!singleLineLiteral(query) || !ts.isArrayLiteralExpression(parameters) || parameters.elements.length !== 1) return;
  const match = keyLookupSql.exec(query.text);
  const key = parameters.elements[0];
  const site = match && !ts.isSpreadElement(key) && loopSite(call);
  const use = site && pgRowsUse(site.awaited);
  if (!use || !readsOnly(key, site.loopVariable, site.locals)?.usesLoopVariable) return;
  const [, head, projection, table, column, tail] = match;
  const field = column.split('.').at(-1).toLowerCase();
  const projected =
    projection === '*' || projection.split(',').some((name) => name.trim().split('.').at(-1).toLowerCase() === field);
  const keys = mapCollection(site.loop.expression, site.loopVariable, textOf(key));
  const rows = usableName(sourceFile, camelCase(table.split('.').at(-1).toLowerCase()));
  const byKey = rows && usableName(sourceFile, `${rows}By${capitalized(camelCase(field))}`);
  if (!projected || !keys || !byKey) return;
  const quote = textOf(query)[0];
  const batched = `${quote}${head}ANY($1)${tail}${quote}`;
  const groupKey = `String(row.${field})`;
  return {
    edits: [
      insertLinesBefore(site.loop, [
        `const { rows: ${rows} } = await ${textOf(call.expression)}(${batched}, [${keys}]);`,
        `const ${byKey} = new Map();`,
        `for (const row of ${rows}) ${byKey}.set(${groupKey}, [...(${byKey}.get(${groupKey}) ?? []), row]);`,
      ]),
      replaceNode(use.target, use.text(`${byKey}.get(String(${textOf(key)})) ?? []`)),
    ],
    note: 'Rows are grouped by String(key) because pg returns bigint and numeric columns as strings; check date or case-insensitive keys.',
  };
}

function redisBatchMethod(message) {
  if (message?.includes('.mGet(')) return 'mGet';
  if (message?.includes('.mget(')) return 'mget';
}

const redisWriteNote =
  'Values are now read once before the loop, so a value the loop itself writes is not seen by a later item that reads the same key.';

function redisGetInLoop(call, batch, sourceFile) {
  const client = call.expression.expression;
  const key = call.arguments.length === 1 && call.arguments[0];
  const site = key && !ts.isSpreadElement(key) && isPlainReference(client) && loopLookup(call);
  const reads = site && readsOnlyNames(key, site.names, site.locals);
  const local = site && !reads && ts.isIdentifier(key) && inlinedLocal(key, site);
  if (!(reads?.usesLoopVariable || local)) return;
  const keyList = itemKeys(site, { perItem: local || key });
  const workNotes = keyList && loopWorkNote(site, textOf(client), undefined, local || key);
  if (!workNotes) return;
  const declared = site.awaited.parent;
  const base = ts.isVariableDeclaration(declared) && ts.isIdentifier(declared.name) ? declared.name.text : 'cached';
  const keys = usableName(sourceFile, 'keys');
  const values = keys && usableName(sourceFile, 'values');
  const byKey = values && usableName(sourceFile, `${base}ByKey`);
  if (!byKey) return;
  return {
    edits: [
      insertLinesBefore(site.loop, [
        `const ${keys} = ${keyList};`,
        // MGET with no keys is a Redis error, while the loop simply ran zero times.
        `const ${values} = ${keys}.length ? await ${textOf(client)}.${batch}(${keys}) : [];`,
        `const ${byKey} = new Map(${keys}.map((key, index) => [key, ${values}[index]]${asConst(sourceFile)}));`,
      ]),
      replaceNode(site.awaited, inSlot(site.awaited, `${byKey}.get(${textOf(key)}) ?? null`)),
    ],
    ...(workNotes.length && { note: redisWriteNote }),
  };
}

// `Promise.all(items.map((item) => redis.command(...)))`: the mapped call, its client and the Promise.all.
function mappedRedisCommands(call) {
  const iteration = enclosingIteration(call);
  if (iteration?.kind !== 'callback') return;
  const { node: mapCall, callback, method } = iteration;
  const all = mapCall.parent;
  const client = call.expression.expression;
  if (
    method !== 'map' ||
    !ts.isArrowFunction(callback) ||
    callback.body !== call ||
    callback.modifiers?.length ||
    callback.parameters.length !== 1 ||
    !ts.isIdentifier(callback.parameters[0].name) ||
    !isPlainReference(client) ||
    !ts.isCallExpression(all) ||
    textOf(all.expression) !== 'Promise.all' ||
    all.arguments.length !== 1 ||
    all.arguments[0] !== mapCall ||
    call.arguments.some(ts.isSpreadElement)
  )
    return;
  return { mapCall, callback, all, client: textOf(client), parameter: callback.parameters[0].name.text };
}

// Awaited `Promise.all` of DELs as a statement becomes one variadic DEL, skipped when there is nothing to delete.
function redisDelAll(call, sourceFile) {
  const mapped = mappedRedisCommands(call);
  const awaited = mapped && mapped.all.parent;
  if (!awaited || !ts.isAwaitExpression(awaited) || !ts.isExpressionStatement(awaited.parent)) return;
  // Two statements replace one, which only a block (not an `if` or loop body) can hold.
  if (!ts.isBlock(awaited.parent.parent) && !ts.isSourceFile(awaited.parent.parent)) return;
  if (call.arguments.length !== 1) return;
  const [key] = call.arguments;
  const collection = textOf(mapped.mapCall.expression.expression);
  const keyText = textOf(key);
  const list = keyText === mapped.parameter ? collection : `${collection}.map((${mapped.parameter}) => ${keyText})`;
  const keys = usableName(sourceFile, 'keysToDelete');
  if (!keys) return;
  return {
    edits: [
      replaceNode(
        awaited.parent,
        `const ${keys} = ${list};\n${indentationOf(awaited.parent)}if (${keys}.length) await ${mapped.client}.del(...${keys});`,
      ),
    ],
    note: 'On Redis Cluster every key must hash to the same slot (use a {hash tag}), or keep one DEL per slot.',
  };
}

// `Promise.all` of SETs becomes one ioredis pipeline that still rejects on the first failed reply.
function redisSetPipeline(call) {
  const mapped = mappedRedisCommands(call);
  if (!mapped || call.arguments.length < 2) return;
  const collection = textOf(mapped.mapCall.expression.expression);
  const quote = call.arguments.find(ts.isStringLiteral) ? textOf(call.arguments.find(ts.isStringLiteral))[0] : "'";
  const command = `[${quote}set${quote}, ${call.arguments.map(textOf).join(', ')}]`;
  const replies = `(replies ?? []).map(([error, reply]) => { if (error) throw error; return reply; })`;
  const pipeline = `${mapped.client}.pipeline(${collection}.map((${mapped.parameter}) => ${command})).exec().then((replies) => ${replies})`;
  return {
    edits: [replaceNode(mapped.all, pipeline)],
    note: 'A pipeline sends every command in one round trip; it resolves to unknown[] replies, so retype any use of the result.',
  };
}

function redisCommandInLoop({ node, finding, sourceFile }) {
  const call = calleeCall(node);
  if (!call || !ts.isPropertyAccessExpression(call.expression)) return;
  const command = call.expression.name.text;
  const batch = redisBatchMethod(finding.message);
  if (command === 'get' && batch) return redisGetInLoop(call, batch, sourceFile);
  if (command === 'del' && finding.message?.includes('.del(...keys)')) return redisDelAll(call, sourceFile);
  if (command === 'set' && finding.message?.includes('.pipeline()') && finding.message.includes('.mset('))
    return redisSetPipeline(call);
}

// `(await db.model.findMany(args))` around `call`, or undefined when anything else sits between them.
function awaitedFindMany(call) {
  if (!call || !ts.isPropertyAccessExpression(call.expression) || call.expression.name.text !== 'findMany') return;
  const awaited = outerParentheses(call).parent;
  if (ts.isAwaitExpression(awaited)) return outerParentheses(awaited);
}

function renamedCall(call, method) {
  const name = call.expression.name;
  return textWith(call, [{ start: name.getStart(), end: name.end, text: method }]);
}

function prismaCountMaterialization({ node }) {
  const call = calleeCall(node);
  const result = awaitedFindMany(call);
  const access = result?.parent;
  if (!ts.isPropertyAccessExpression(access) || access.expression !== result || access.name.text !== 'length') return;
  return { edits: [replaceNode(access, inSlot(access, `await ${renamedCall(call, 'count')}`))] };
}

function booleanContext(expression) {
  const value = outerParentheses(expression);
  const parent = value.parent;
  if (
    ((ts.isIfStatement(parent) || ts.isWhileStatement(parent) || ts.isDoStatement(parent)) &&
      parent.expression === value) ||
    (ts.isConditionalExpression(parent) && parent.condition === value) ||
    (ts.isPrefixUnaryExpression(parent) && parent.operator === ts.SyntaxKind.ExclamationToken)
  )
    return true;
  return (
    ts.isBinaryExpression(parent) &&
    [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken].includes(parent.operatorToken.kind) &&
    booleanContext(parent)
  );
}

// A use that behaves the same for null (findFirst) as for undefined (an empty array's [0]).
function nullSafeUse(identifier) {
  const value = outerParentheses(identifier);
  const parent = value.parent;
  if ((ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) && parent.expression === value)
    return true;
  if (booleanContext(value)) return true;
  if (!ts.isBinaryExpression(parent) || parent.left !== value) return false;
  const operator = parent.operatorToken.kind;
  if (operator === ts.SyntaxKind.QuestionQuestionToken || operator === ts.SyntaxKind.BarBarToken) return true;
  return (
    (operator === ts.SyntaxKind.EqualsEqualsToken || operator === ts.SyntaxKind.ExclamationEqualsToken) &&
    (parent.right.kind === ts.SyntaxKind.NullKeyword || textOf(parent.right) === 'undefined')
  );
}

function onlyNullSafeUses(declaration) {
  if (!ts.isIdentifier(declaration.name) || !(declaration.parent.flags & ts.NodeFlags.Const)) return false;
  const scope = ts.findAncestor(declaration, (node) => ts.isFunctionLike(node) || ts.isSourceFile(node));
  const name = declaration.name;
  return !someNode(
    scope,
    (node) =>
      ts.isIdentifier(node) && node !== name && node.text === name.text && isReference(node) && !nullSafeUse(node),
  );
}

function prismaFirstMaterialization({ node }) {
  const call = calleeCall(node);
  const result = awaitedFindMany(call);
  const access = result?.parent;
  if (!ts.isElementAccessExpression(access) || access.expression !== result) return;
  const first = `await ${renamedCall(call, 'findFirst')}`;
  const outer = outerParentheses(access);
  const read = outer.parent;
  if ((ts.isPropertyAccessExpression(read) || ts.isElementAccessExpression(read)) && read.expression === outer)
    return { edits: [replaceNode(access, `(${first})`)] };
  if (ts.isVariableDeclaration(read) && read.initializer === access && onlyNullSafeUses(read))
    return { edits: [replaceNode(access, first)] };
}

// The findMany call text with option properties replaced or appended.
function withOptions(call, changes) {
  const [options] = call.arguments;
  if (!options) {
    const added = [...changes.values()].map((change) => change()).join(', ');
    return textOf(call).replace(/\(\s*\)$/, `({ ${added} })`);
  }
  const properties = plainProperties(options);
  if (!properties) return;
  const edits = [];
  const appended = [];
  for (const [name, change] of changes) {
    const existing = properties.get(name);
    if (existing) edits.push(replaceNode(existing, change(existing)));
    else appended.push(change());
  }
  if (appended.length) {
    const last = options.properties.at(-1);
    edits.push(
      last
        ? { start: last.end, end: last.end, text: `, ${appended.join(', ')}` }
        : replaceNode(options, `{ ${appended.join(', ')} }`),
    );
  }
  return textWith(call, edits);
}

function fieldOf(expression, parameter) {
  if (
    ts.isPropertyAccessExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    expression.expression.text === parameter
  )
    return expression.name.text;
}

function singleResult(callback, arity) {
  if (
    !callback ||
    (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback)) ||
    callback.parameters.length !== arity ||
    !callback.parameters.every((parameter) => ts.isIdentifier(parameter.name))
  )
    return;
  let result = callback.body;
  if (ts.isBlock(result)) {
    if (result.statements.length !== 1 || !ts.isReturnStatement(result.statements[0])) return;
    result = result.statements[0].expression;
  }
  return result && ts.skipParentheses(result);
}

// `(await db.model.findMany(args)).method(...)` from the reported method name.
function chainedFindMany(node) {
  const access = node.parent;
  const chained = access?.parent;
  if (!ts.isPropertyAccessExpression(access) || !ts.isCallExpression(chained) || chained.expression !== access) return;
  const awaited = ts.skipParentheses(access.expression);
  const call = ts.isAwaitExpression(awaited) && ts.skipParentheses(awaited.expression);
  if (call && ts.isCallExpression(call) && awaitedFindMany(call)) return { call, chained };
}

const filterNote =
  'The database now compares the value: check case-insensitive collations, and Decimal, BigInt or DateTime fields that JavaScript `===` never matched.';

function prismaFilterMaterialization({ node }) {
  const query = chainedFindMany(node);
  const predicate = query && singleResult(query.chained.arguments[0], 1);
  if (
    !predicate ||
    query.chained.arguments.length !== 1 ||
    !ts.isBinaryExpression(predicate) ||
    predicate.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken
  )
    return;
  const parameter = query.chained.arguments[0].parameters[0].name.text;
  const [fieldSide, valueSide] = fieldOf(predicate.left, parameter)
    ? [predicate.left, predicate.right]
    : [predicate.right, predicate.left];
  const field = fieldOf(fieldSide, parameter);
  const value = ts.skipParentheses(valueSide);
  const literal =
    ts.isStringLiteral(value) ||
    ts.isNumericLiteral(value) ||
    value.kind === ts.SyntaxKind.TrueKeyword ||
    value.kind === ts.SyntaxKind.FalseKeyword ||
    (ts.isPrefixUnaryExpression(value) &&
      value.operator === ts.SyntaxKind.MinusToken &&
      ts.isNumericLiteral(value.operand));
  if (!field || !literal) return;
  const condition = `{ ${field}: ${textOf(value)} }`;
  const where = (existing) => {
    if (!existing) return `where: ${condition}`;
    const current = propertyValue(existing);
    return `where: { AND: [${textOf(current)}, ${condition}] }`;
  };
  const rewritten = withOptions(query.call, new Map([['where', where]]));
  if (!rewritten) return;
  return { edits: [replaceNode(query.chained, inSlot(query.chained, `await ${rewritten}`))], note: filterNote };
}

function prismaTopKMaterialization({ node }) {
  const query = chainedFindMany(node);
  const comparator = query?.chained.arguments[0];
  const difference = query && singleResult(comparator, 2);
  const slice = query && outerParentheses(query.chained).parent?.parent;
  if (
    !difference ||
    !ts.isBinaryExpression(difference) ||
    difference.operatorToken.kind !== ts.SyntaxKind.MinusToken ||
    !ts.isCallExpression(slice) ||
    !ts.isPropertyAccessExpression(slice.expression) ||
    slice.expression.expression !== outerParentheses(query.chained) ||
    slice.expression.name.text !== 'slice' ||
    slice.arguments.length !== 2 ||
    textOf(slice.arguments[0]) !== '0' ||
    !ts.isNumericLiteral(slice.arguments[1])
  )
    return;
  const [first, second] = comparator.parameters.map((parameter) => parameter.name.text);
  const ascending = fieldOf(difference.left, first);
  const field = ascending ?? fieldOf(difference.left, second);
  if (!field || fieldOf(difference.right, ascending ? second : first) !== field) return;
  const order = `{ ${field}: '${ascending ? 'asc' : 'desc'}' }`;
  const orderBy = (existing) => {
    if (!existing) return `orderBy: ${order}`;
    // JavaScript's stable sort kept the query order as the tie-breaker.
    const current = propertyValue(existing);
    const rest = ts.isArrayLiteralExpression(current) ? current.elements.map(textOf).join(', ') : textOf(current);
    return `orderBy: [${order}, ${rest}]`;
  };
  const changes = new Map([
    ['orderBy', orderBy],
    ['take', () => `take: ${slice.arguments[1].text}`],
  ]);
  const rewritten = withOptions(query.call, changes);
  if (!rewritten) return;
  return {
    edits: [replaceNode(slice, inSlot(slice, `await ${rewritten}`))],
    note: 'Check NULL placement: the database orders NULLs itself, while the JavaScript comparator treated them as 0.',
  };
}

// The string literal of `(await client.query(SQL)).rows` holding the reported read.
function pgRowsQuery(rows) {
  const awaited = ts.skipParentheses(rows.expression);
  const call = ts.isAwaitExpression(awaited) && ts.skipParentheses(awaited.expression);
  if (!call || !ts.isCallExpression(call) || rows.name.text !== 'rows') return;
  const [query] = call.arguments;
  if (query && singleLineLiteral(query)) return query;
}

function sqlKeyword(sql, keyword) {
  return /^\s*SELECT/.test(sql) ? keyword.toUpperCase() : keyword.toLowerCase();
}

function pgFirstMaterialization({ node }) {
  const access = node.parent;
  const rows = ts.isElementAccessExpression(access) && ts.skipParentheses(access.expression);
  const query = rows && ts.isPropertyAccessExpression(rows) && pgRowsQuery(rows);
  if (!query) return;
  const end = query.getStart() + 1 + query.text.replace(trailingSql, '').length;
  return { edits: [{ start: end, end, text: ` ${sqlKeyword(query.text, 'limit')} 1` }] };
}

function pgCountMaterialization({ node }) {
  const length = node.parent;
  const rows = ts.isPropertyAccessExpression(length) && ts.skipParentheses(length.expression);
  const query = rows && ts.isPropertyAccessExpression(rows) && pgRowsQuery(rows);
  const list = query && selectListSql.exec(query.text);
  if (!list) return;
  const start = query.getStart() + 1 + list[1].length;
  const counted = `${sqlKeyword(query.text, 'count')}(*) ${sqlKeyword(query.text, 'as')} total`;
  const rowsText = textWith(rows, [{ start, end: start + list[2].length, text: counted }]);
  return { edits: [replaceNode(length, `Number(${rowsText}[0].total)`)] };
}

module.exports = {
  'prisma-query-in-loop': prismaQueryInLoop,
  'orm-query-in-loop': ormQueryInLoop,
  'pg-query-in-loop': pgQueryInLoop,
  'redis-command-in-loop': redisCommandInLoop,
  'prisma-count-materialization': prismaCountMaterialization,
  'prisma-first-materialization': prismaFirstMaterialization,
  'prisma-filter-materialization': prismaFilterMaterialization,
  'prisma-top-k-materialization': prismaTopKMaterialization,
  'pg-first-materialization': pgFirstMaterialization,
  'pg-count-materialization': pgCountMaterialization,
};
