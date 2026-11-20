'use strict';

// Rewrites per-item queries inside a for-of loop into one batched query before the loop, and single queries that
// load every row only to count, pick or filter them. Any shape not proven safe is left to the rule example.
const {
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

// `{ key: value }` naming one scalar field.
function singleKeyFilter(filter) {
  const properties = plainProperties(filter);
  if (properties?.size !== 1) return;
  const [[field, property]] = properties;
  const value = propertyValue(property);
  if (!identifierPattern.test(field) || ts.isObjectLiteralExpression(value) || ts.isArrayLiteralExpression(value))
    return;
  return { field, value };
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
function keyedLookup({ site, sourceFile, rowsBase, rowName, field, keyValue, fetchLine, note }) {
  const rows = usableName(sourceFile, rowsBase);
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

const mapKeyNote =
  'Rows are matched through a Map, so the key must be a string or number value (not a Date, Decimal or Buffer).';

function prismaLookup(call, sourceFile) {
  const delegate = call.expression.expression;
  if (!ts.isPropertyAccessExpression(delegate) || !isPlainReference(delegate) || call.arguments.length !== 1) return;
  const site = loopSite(call);
  const options = plainProperties(call.arguments[0]);
  if (
    !site ||
    !options?.has('where') ||
    [...options.keys()].some((name) => !['where', 'select', 'include'].includes(name))
  )
    return;
  const filter = ts.isPropertyAssignment(options.get('where')) && singleKeyFilter(options.get('where').initializer);
  if (!filter || !readsOnly(filter.value, site.loopVariable, site.locals)?.usesLoopVariable) return;
  const selection = options.get('select');
  if (selection) {
    const selected = ts.isPropertyAssignment(selection) && plainProperties(selection.initializer)?.get(filter.field);
    if (!selected || !ts.isPropertyAssignment(selected) || selected.initializer.kind !== ts.SyntaxKind.TrueKeyword)
      return;
  }
  const keys = mapCollection(site.loop.expression, site.loopVariable, textOf(filter.value));
  if (!keys) return;
  const optionTexts = [...options].map(([name, property]) =>
    name === 'where' ? `where: { ${filter.field}: { in: ${keys} } }` : textOf(property),
  );
  if (optionTexts.some((option) => option.includes('\n'))) return;
  const model = delegate.name.text;
  return keyedLookup({
    site,
    sourceFile,
    rowsBase: plural(model),
    rowName: model,
    field: filter.field,
    keyValue: filter.value,
    fetchLine: `${textOf(delegate)}.findMany({ ${optionTexts.join(', ')} })`,
    note: mapKeyNote,
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
  const site = iteration?.kind === 'loop' && forOfLoop(iteration.node);
  if (!site) return;
  const body = site.loop.statement;
  const statement = ts.isBlock(body) && body.statements.length === 1 ? body.statements[0] : body;
  if (
    !ts.isExpressionStatement(statement) ||
    statement.expression !== call.parent ||
    !ts.isAwaitExpression(call.parent) ||
    !readsOnly(data, site.loopVariable, site.locals)
  )
    return;
  const dataText = reindent(textOf(data), indentationOf(statement), indentationOf(site.loop));
  const items = mapCollection(site.loop.expression, site.loopVariable, dataText);
  if (!items) return;
  return { edits: [replaceNode(site.loop, `${createMany(items)};`)], note: createManyNote };
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
  if (method === 'create') return prismaCreateMany(call);
  if (method === 'findUnique') return prismaLookup(call, sourceFile);
}

function repositoryNames(receiver) {
  const last = ts.isPropertyAccessExpression(receiver) ? receiver.name.text : textOf(receiver);
  const base = last.replace(/(?:Repository|Repo)$/, '');
  if (!base || base === 'this') return { rowsBase: 'rows', rowName: 'row' };
  const lowered = base[0].toLowerCase() + base.slice(1);
  if (lowered.endsWith('s')) return { rowsBase: lowered, rowName: 'row' };
  return { rowsBase: plural(lowered), rowName: lowered };
}

// The local name of TypeORM's `In`, adding it to an existing named import when needed.
function typeormIn(sourceFile) {
  for (const statement of sourceFile.statements) {
    const clause = ts.isImportDeclaration(statement) && statement.importClause;
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
}

function ormQueryInLoop({ node, finding, sourceFile }) {
  if (!finding.message?.startsWith('TypeORM.findOneBy()')) return;
  const call = calleeCall(node);
  if (!call || !ts.isPropertyAccessExpression(call.expression) || call.arguments.length !== 1) return;
  const receiver = call.expression.expression;
  if (!isPlainReference(receiver)) return;
  const filter = singleKeyFilter(call.arguments[0]);
  const site = loopSite(call);
  // Only the primary key guarantees the single row findOneBy returned.
  if (!site || filter?.field !== 'id' || !readsOnly(filter.value, site.loopVariable, site.locals)?.usesLoopVariable)
    return;
  const keys = mapCollection(site.loop.expression, site.loopVariable, textOf(filter.value));
  const operator = typeormIn(sourceFile);
  if (!keys || !operator) return;
  const fix = keyedLookup({
    site,
    sourceFile,
    ...repositoryNames(receiver),
    field: 'id',
    keyValue: filter.value,
    fetchLine: `${textOf(receiver)}.findBy({ id: ${operator.name}(${keys}) })`,
    note: mapKeyNote,
  });
  return fix && { ...fix, edits: [...fix.edits, ...operator.edits] };
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

function redisCommandInLoop({ node, finding, sourceFile }) {
  const call = calleeCall(node);
  const batch = redisBatchMethod(finding.message);
  if (!call || !batch || !ts.isPropertyAccessExpression(call.expression) || call.expression.name.text !== 'get') return;
  const client = call.expression.expression;
  const key = call.arguments.length === 1 && call.arguments[0];
  const site = key && !ts.isSpreadElement(key) && isPlainReference(client) && loopSite(call);
  if (!site || !readsOnly(key, site.loopVariable, site.locals)?.usesLoopVariable) return;
  const declared = site.awaited.parent;
  const base = ts.isVariableDeclaration(declared) && ts.isIdentifier(declared.name) ? declared.name.text : 'cached';
  const keys = usableName(sourceFile, 'keys');
  const values = keys && usableName(sourceFile, 'values');
  const byKey = values && usableName(sourceFile, `${base}ByKey`);
  const keyList = mapCollection(site.loop.expression, site.loopVariable, textOf(key));
  if (!byKey || !keyList) return;
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
  };
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
