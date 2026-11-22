'use strict';

// service-query-in-loop: the query sits in a project helper called once per item. When the helper is a single keyed
// read or a single insert, a batch sibling is added next to it and the loop calls that once; a loop that only awaits
// the helper otherwise runs its calls a few at a time.
const { innermostNodeAt } = require('../../shared/fix-hunks.cjs');
const path = require('node:path');
const { ts, calleeCall, freshName, indentationAt, isPlainReference, nameTaken, textOf } = require('./helpers.cjs');

const CONCURRENT_CALLS = 5;
const typedExtensions = /\.[cm]?tsx?$/i;
const migrationSource = /(?:^|[\\/])migrations?[\\/]/i;
// Cache commands on separate keys do not race when they overlap. Database helpers are left sequential: their order
// and locks can matter (two claims of the same slot, deadlocks between multi-table deletes), and the listed queries
// may not be all a helper does.
const overlapSafeCommands = new Set([
  'del',
  'unlink',
  'get',
  'mget',
  'exists',
  'set',
  'setex',
  'expire',
  'hdel',
  'hget',
  'scan',
]);
const transactionHandle =
  /^(?:tx|trx|transaction|manager|entityManager|em|queryRunner|runner|session|connection|conn)$|(?:Manager|Runner|Tx|Transaction|Session)$/;
const arrayMethods = new Set(['map', 'filter', 'slice', 'concat', 'flat', 'flatMap']);
const objectListers = new Set(['keys', 'values', 'entries']);

// Batch variants of single-row and list reads, by client family.
const batchReads = {
  typeorm: { find: 'find', findBy: 'findBy', findOne: 'find', findOneBy: 'findBy' },
  prisma: { findMany: 'findMany', findFirst: 'findMany', findUnique: 'findMany' },
};
const singleReads = new Set(['findOne', 'findOneBy', 'findFirst', 'findUnique']);
// Options that change which rows one call returns per key, so they cannot be shared by all keys.
const readOptions = new Set(['where', 'select', 'relations', 'order', 'orderBy', 'include', 'withDeleted']);

function clientFamily(message) {
  if (message.includes('`In(ids)`')) return 'typeorm';
  if (message.includes('`{ in: ids }`')) return 'prisma';
}

function unwrap(node) {
  return ts.skipOuterExpressions(node);
}

function references(node, names) {
  let found = false;
  (function visit(child) {
    if (found) return;
    if (ts.isIdentifier(child) && names.has(child.text) && !isPropertyName(child)) found = true;
    else ts.forEachChild(child, visit);
  })(node);
  return found;
}

function isPropertyName(identifier) {
  const parent = identifier.parent;
  return (
    (ts.isPropertyAccessExpression(parent) && parent.name === identifier) ||
    (ts.isPropertyAssignment(parent) && parent.name === identifier) ||
    (ts.isMethodDeclaration(parent) && parent.name === identifier)
  );
}

function contains(node, predicate) {
  let found = false;
  (function visit(child) {
    if (found) return;
    if (predicate(child)) found = true;
    else ts.forEachChild(child, visit);
  })(node);
  return found;
}

function bindingNames(name, names = new Set()) {
  if (ts.isIdentifier(name)) names.add(name.text);
  else
    for (const element of name.elements ?? []) if (!ts.isOmittedExpression(element)) bindingNames(element.name, names);
  return names;
}

// Names declared by the loop binding and inside its body: values that differ per item.
function loopNames(binding, body) {
  const names = bindingNames(binding);
  (function visit(node) {
    if ((ts.isVariableDeclaration(node) || ts.isParameter(node)) && node.name) bindingNames(node.name, names);
    ts.forEachChild(node, visit);
  })(body);
  return names;
}

// --- The callee ---

function enclosingNamedFunction(node) {
  for (let current = node; current; current = current.parent)
    if ((ts.isMethodDeclaration(current) || ts.isFunctionDeclaration(current)) && current.body && current.name)
      return current;
}

// The helper declaration when every listed query sits directly in it, so its body is the whole story.
function directCallee(finding, name, load) {
  if (!finding.related?.length) return;
  let found;
  for (const related of finding.related) {
    const entry = load(related.file);
    if (!entry?.sourceFile) return;
    const offset = entry.lineStarts[related.line - 1] + related.column - 1;
    const token = innermostNodeAt(ts, entry.sourceFile, offset);
    const declaration = token && enclosingNamedFunction(token);
    if (!declaration || textOf(declaration.name) !== name) return;
    if (found && found.declaration !== declaration) return;
    found = { entry, declaration };
  }
  return found;
}

function simpleParameters(declaration) {
  return declaration.parameters.every(
    (parameter) => ts.isIdentifier(parameter.name) && !parameter.dotDotDotToken && !parameter.initializer,
  );
}

function objectProperty(object, key) {
  return object.properties.find(
    (property) =>
      (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) &&
      ts.isIdentifier(property.name) &&
      property.name.text === key,
  );
}

// `repo.find(...)` or `prisma.model.findMany(...)`, awaited or not, as a whole statement's value.
function queryCall(expression) {
  const value = unwrap(expression);
  const call = ts.isAwaitExpression(value) ? unwrap(value.expression) : value;
  if (ts.isCallExpression(call) && ts.isPropertyAccessExpression(call.expression)) return call;
}

// The read statement and what surrounds it: constant declarations before it, synchronous statements after it.
function splitAroundRead(statements, family) {
  const index = statements.findIndex(
    (statement) =>
      contains(statement, ts.isAwaitExpression) || batchReads[family][queryStatement(statement)?.expression.name.text],
  );
  if (index === -1) return;
  const read = statements[index];
  const before = statements.slice(0, index);
  const after = statements.slice(index + 1);
  if (
    !before.every(
      (statement) => ts.isVariableStatement(statement) && statement.declarationList.flags & ts.NodeFlags.Const,
    )
  )
    return;
  if (after.some((statement) => contains(statement, ts.isAwaitExpression))) return;
  if (after.length && !after.some((statement) => contains(statement, ts.isReturnStatement))) return;
  return { read, before, after };
}

function queryStatement(statement) {
  if (ts.isReturnStatement(statement) && statement.expression) return queryCall(statement.expression);
  if (ts.isVariableStatement(statement) && statement.declarationList.declarations.length === 1) {
    const declaration = statement.declarationList.declarations[0];
    if (ts.isIdentifier(declaration.name) && declaration.initializer) return queryCall(declaration.initializer);
  }
}

// The `where` object of a read and the key property in it that holds a parameter.
function readShape(call, family, parameterNames) {
  const method = call.expression.name.text;
  const batchMethod = batchReads[family][method];
  if (!batchMethod || call.arguments.length !== 1) return;
  const options = unwrap(call.arguments[0]);
  if (!ts.isObjectLiteralExpression(options)) return;
  const byMethod = method.endsWith('By');
  let where = options;
  if (!byMethod) {
    if (!options.properties.every((property) => readOptions.has(textOf(property.name ?? property)))) return;
    const whereProperty = objectProperty(options, 'where');
    if (!whereProperty || !ts.isPropertyAssignment(whereProperty)) return;
    where = unwrap(whereProperty.initializer);
    if (!ts.isObjectLiteralExpression(where)) return;
  }
  const keyProperties = where.properties.filter((property) => {
    if (ts.isShorthandPropertyAssignment(property)) return parameterNames.has(property.name.text);
    return (
      ts.isPropertyAssignment(property) &&
      ts.isIdentifier(property.initializer) &&
      parameterNames.has(property.initializer.text)
    );
  });
  if (keyProperties.length !== 1 || !ts.isIdentifier(keyProperties[0].name)) return;
  const keyProperty = keyProperties[0];
  const parameter = ts.isShorthandPropertyAssignment(keyProperty)
    ? keyProperty.name.text
    : keyProperty.initializer.text;
  return { method, batchMethod, options, byMethod, keyProperty, key: keyProperty.name.text, parameter };
}

// `new Set`-free text of the options with the key matched against the whole list, and the key selected.
function batchOptionsText(shape, family, listName, edits) {
  const { options, keyProperty, key } = shape;
  const sourceFile = options.getSourceFile();
  const base = options.getStart(sourceFile);
  const replacements = [
    {
      start: keyProperty.getStart(sourceFile),
      end: keyProperty.end,
      text: `${key}: ${family === 'typeorm' ? `In(${listName})` : `{ in: ${listName} }`}`,
    },
    ...edits,
  ].sort((left, right) => right.start - left.start);
  let result = textOf(options);
  for (const replacement of replacements)
    result = result.slice(0, replacement.start - base) + replacement.text + result.slice(replacement.end - base);
  return result;
}

// Rows must carry the key to be matched back to each item; returns the edit that adds it, if any.
function selectKeyEdit(shape) {
  if (shape.byMethod) return { edits: [] };
  const selectProperty = objectProperty(shape.options, 'select');
  if (!selectProperty) return { edits: [] };
  if (!ts.isPropertyAssignment(selectProperty)) return;
  const select = unwrap(selectProperty.initializer);
  const sourceFile = select.getSourceFile();
  if (ts.isArrayLiteralExpression(select)) {
    if (!select.elements.every(ts.isStringLiteralLike)) return;
    if (select.elements.some((element) => element.text === shape.key)) return { edits: [] };
    const quote = select.elements[0] && textOf(select.elements[0]).startsWith('"') ? '"' : "'";
    const separator = select.elements.length ? ', ' : '';
    return {
      edits: [{ start: select.end - 1, end: select.end - 1, text: `${separator}${quote}${shape.key}${quote}` }],
      added: true,
    };
  }
  if (!ts.isObjectLiteralExpression(select)) return;
  if (objectProperty(select, shape.key)) return { edits: [] };
  const opening = select.getStart(sourceFile) + 1;
  return { edits: [{ start: opening, end: opening, text: ` ${shape.key}: true,` }], added: true };
}

function pluralOf(name) {
  if (name.endsWith('s')) return `${name}List`;
  return /[^aeiou]y$/.test(name) ? `${name.slice(0, -1)}ies` : `${name}s`;
}

function arrayType(typeNode) {
  const text = textOf(typeNode);
  return ts.isUnionTypeNode(typeNode) || ts.isFunctionTypeNode(typeNode) ? `(${text})[]` : `${text}[]`;
}

function promisedType(declaration) {
  const type = declaration.type;
  if (!type) return;
  if (ts.isTypeReferenceNode(type) && textOf(type.typeName) === 'Promise' && type.typeArguments?.length === 1)
    return type.typeArguments[0];
}

function modifiersText(declaration) {
  const kept = (declaration.modifiers ?? []).filter((modifier) =>
    [
      ts.SyntaxKind.PrivateKeyword,
      ts.SyntaxKind.ProtectedKeyword,
      ts.SyntaxKind.PublicKeyword,
      ts.SyntaxKind.StaticKeyword,
    ].includes(modifier.kind),
  );
  const exported =
    ts.isFunctionDeclaration(declaration) &&
    declaration.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
  return [
    ...(exported ? ['export'] : []),
    ...kept.map(textOf),
    'async',
    ...(ts.isFunctionDeclaration(declaration) ? ['function'] : []),
  ].join(' ');
}

function signatureText({ declaration, batchName, itemIndex, listName, typed, returnType }) {
  const parameters = declaration.parameters.map((parameter, index) => {
    if (index !== itemIndex) return textOf(parameter);
    return typed && parameter.type ? `${listName}: ${arrayType(parameter.type)}` : listName;
  });
  const result = typed && returnType ? `: Promise<${returnType}>` : '';
  return `${modifiersText(declaration)} ${batchName}(${parameters.join(', ')})${result} {`;
}

// Statement text moved one level deeper, keeping its own line breaks.
function reindented(statement, from, to) {
  return textOf(statement)
    .split('\n')
    .map((line, index) => (index === 0 ? to + line : line.startsWith(from) ? to + line.slice(from.length) : line));
}

// A batch sibling of a single keyed read: one query for all keys, then the per-item result in input order.
function readBatch(callee, family, typed) {
  const { declaration } = callee;
  if (!ts.isBlock(declaration.body) || !simpleParameters(declaration)) return;
  const parameterNames = new Set(declaration.parameters.map((parameter) => parameter.name.text));
  const parts = splitAroundRead(declaration.body.statements, family);
  const call = parts && queryStatement(parts.read);
  const shape = call && readShape(call, family, parameterNames);
  if (!shape) return;
  const itemIndex = declaration.parameters.findIndex((parameter) => parameter.name.text === shape.parameter);
  const itemParameter = declaration.parameters[itemIndex];
  // Rows are matched to keys with ===, which needs keys that are plain strings or numbers.
  if (typed && !(itemParameter.type && ['string', 'number'].includes(textOf(itemParameter.type)))) return;
  // The key must reach the query only through the where clause.
  const others = declaration.body.statements.filter((statement) => statement !== parts.read);
  if (others.some((statement) => references(statement, new Set([shape.parameter])))) return;
  let keyUses = 0;
  (function visit(node) {
    if (ts.isIdentifier(node) && node.text === shape.parameter && !isPropertyName(node)) keyUses++;
    ts.forEachChild(node, visit);
  })(call.arguments[0]);
  if (keyUses !== 1) return;
  const selection = selectKeyEdit(shape);
  if (!selection) return;
  const sourceFile = declaration.getSourceFile();
  const taken = (name) => contains(declaration, (node) => ts.isIdentifier(node) && node.text === name);
  const listName = pluralOf(shape.parameter);
  const rowsName = taken('rows') ? 'batchRows' : 'rows';
  const rowName = taken('row') ? 'batchRow' : 'row';
  if (taken(listName) || taken(rowsName) || taken(rowName)) return;
  const single = singleReads.has(shape.method);
  const receiver = textOf(call.expression.expression);
  const options = batchOptionsText(shape, family, listName, selection.edits);
  const match = `${rowsName}.${single ? 'find' : 'filter'}((${rowName}) => ${rowName}.${shape.key} === ${shape.parameter})${single ? ' ?? null' : ''}`;
  const returned = promisedType(declaration);
  const returnType = returned && (ts.isUnionTypeNode(returned) ? `(${textOf(returned)})[]` : `${textOf(returned)}[]`);
  const indentation = indentationAt(sourceFile.text, declaration.getStart(sourceFile));
  const bodyIndentation = indentationAt(sourceFile.text, declaration.body.statements[0].getStart(sourceFile));
  const step = bodyIndentation.slice(indentation.length) || '  ';
  const lines = [
    `${indentation}${signatureText({ declaration, batchName: 'BATCH_NAME', itemIndex, listName, typed, returnType })}`,
    `${bodyIndentation}if (!${listName}.length) return [];`,
    ...parts.before.flatMap((statement) => reindented(statement, bodyIndentation, bodyIndentation)),
    `${bodyIndentation}const ${rowsName} = await ${receiver}.${shape.batchMethod}(${options});`,
  ];
  if (ts.isReturnStatement(parts.read))
    lines.push(`${bodyIndentation}return ${listName}.map((${shape.parameter}) => ${match});`);
  else {
    const name = parts.read.declarationList.declarations[0].name.text;
    lines.push(
      `${bodyIndentation}return ${listName}.map((${shape.parameter}) => {`,
      `${bodyIndentation}${step}const ${name} = ${match};`,
      ...parts.after.flatMap((statement) => reindented(statement, bodyIndentation, bodyIndentation + step)),
      `${bodyIndentation}});`,
    );
  }
  lines.push(`${indentation}}`);
  return {
    kind: 'read',
    itemIndex,
    listName,
    lines,
    bare: !parts.after.length,
    single,
    needsIn: family === 'typeorm',
    note:
      `${shape.method}() per item becomes one ${shape.batchMethod}() over all keys, matched back with === on \`${shape.key}\`` +
      (single ? ' (first match, null when missing).' : '.') +
      (selection.added ? ` The rows now also select \`${shape.key}\`.` : '') +
      (parts.before.length ? ' The lines before the query run once per batch instead of once per item.' : ''),
  };
}

// `await repo.save(repo.create(X))`, `await repo.insert(X)`, `await prisma.model.create({ data: X })`, or
// `const row = repo.create(X); await repo.save(row);` as the whole body.
function writeBatch(callee, family, typed) {
  const { declaration } = callee;
  if (!ts.isBlock(declaration.body) || !simpleParameters(declaration)) return;
  const statements = declaration.body.statements;
  const last = statements.at(-1);
  if (!last || statements.length > 2) return;
  const lastExpression = ts.isExpressionStatement(last) || ts.isReturnStatement(last) ? last.expression : undefined;
  let call = lastExpression && queryCall(lastExpression);
  let handler;
  if (call && call.expression.name.text === 'catch' && call.arguments.length === 1) {
    handler = call.arguments[0];
    call = queryCall(call.expression.expression);
  }
  if (!call || call.arguments.length !== 1) return;
  const method = call.expression.name.text;
  const receiver = textOf(call.expression.expression);
  let item;
  let batchCall;
  if (family === 'prisma' && method === 'create' && statements.length === 1) {
    const options = unwrap(call.arguments[0]);
    const data =
      ts.isObjectLiteralExpression(options) && options.properties.length === 1 && objectProperty(options, 'data');
    if (!data || !ts.isPropertyAssignment(data)) return;
    item = data.initializer;
    batchCall = (list, parameter) =>
      `${receiver}.createMany({ data: ${list}.map((${parameter}) => ${wrapped(item)}) })`;
  } else if (family === 'typeorm' && method === 'insert' && statements.length === 1) {
    item = call.arguments[0];
    batchCall = (list, parameter) => `${receiver}.insert(${list}.map((${parameter}) => ${wrapped(item)}))`;
  } else if (family === 'typeorm' && method === 'save') {
    const created = createdEntity(statements, call, receiver);
    if (!created) return;
    item = created;
    batchCall = (list, parameter) =>
      `${receiver}.save(${list}.map((${parameter}) => ${receiver}.create(${textOf(item)})))`;
  } else return;
  const parameterNames = new Set(declaration.parameters.map((parameter) => parameter.name.text));
  const used = declaration.parameters.filter((parameter) => references(item, new Set([parameter.name.text])));
  if (!used.length || [...parameterNames].some((name) => handler && references(handler, new Set([name])))) return;
  return { kind: 'write', receiver, batchCall, handler, used: used.map((parameter) => parameter.name.text), typed };
}

function wrapped(node) {
  return ts.isObjectLiteralExpression(unwrap(node)) ? `(${textOf(node)})` : textOf(node);
}

// The X of `repo.save(repo.create(X))`, or of `const row = repo.create(X); await repo.save(row);`.
function createdEntity(statements, saveCall, receiver) {
  const argument = unwrap(saveCall.arguments[0]);
  const isCreate = (node) =>
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === 'create' &&
    textOf(node.expression.expression) === receiver &&
    node.arguments.length === 1;
  if (statements.length === 1) return isCreate(argument) ? argument.arguments[0] : undefined;
  const [first] = statements;
  if (!ts.isVariableStatement(first) || first.declarationList.declarations.length !== 1) return;
  const declaration = first.declarationList.declarations[0];
  const initializer = declaration.initializer && unwrap(declaration.initializer);
  if (!ts.isIdentifier(declaration.name) || !ts.isIdentifier(argument) || argument.text !== declaration.name.text)
    return;
  return initializer && isCreate(initializer) ? initializer.arguments[0] : undefined;
}

function writeLines(callee, write, itemIndex, listName) {
  const { declaration } = callee;
  const sourceFile = declaration.getSourceFile();
  const indentation = indentationAt(sourceFile.text, declaration.getStart(sourceFile));
  const bodyIndentation = indentationAt(sourceFile.text, declaration.body.statements[0].getStart(sourceFile));
  const parameter = declaration.parameters[itemIndex].name.text;
  const handler = write.handler ? `.catch(${textOf(write.handler)})` : '';
  return [
    `${indentation}${signatureText({ declaration, batchName: 'BATCH_NAME', itemIndex, listName, typed: write.typed, returnType: 'void' })}`,
    `${bodyIndentation}if (!${listName}.length) return;`,
    `${bodyIndentation}await ${write.batchCall(listName, parameter)}${handler};`,
    `${indentation}}`,
  ];
}

// --- The call site ---

// `Promise.all(list.map((item) => helper(item)))`: the helper call is the whole callback body.
function promiseAllSite(call) {
  let expression = call;
  while (ts.isParenthesizedExpression(expression.parent)) expression = expression.parent;
  const callback = expression.parent;
  if (!callback || !ts.isArrowFunction(callback) || callback.body !== expression || callback.parameters.length !== 1)
    return;
  const map = callback.parent;
  if (!ts.isCallExpression(map) || map.arguments.length !== 1 || !ts.isPropertyAccessExpression(map.expression)) return;
  if (map.expression.name.text !== 'map') return;
  const all = map.parent;
  if (
    !ts.isCallExpression(all) ||
    all.arguments.length !== 1 ||
    all.arguments[0] !== map ||
    textOf(all.expression) !== 'Promise.all'
  )
    return;
  const parameter = callback.parameters[0];
  if (parameter.initializer || parameter.dotDotDotToken) return;
  return {
    kind: 'all',
    all,
    collection: map.expression.expression,
    binding: parameter.name,
    names: loopNames(parameter.name, callback.body),
  };
}

function awaitedStatement(call) {
  let expression = call;
  while (ts.isParenthesizedExpression(expression.parent)) expression = expression.parent;
  if (!ts.isAwaitExpression(expression.parent)) return;
  return expression.parent;
}

function forOfBinding(loop) {
  if (loop.awaitModifier || !ts.isVariableDeclarationList(loop.initializer)) return;
  const declarations = loop.initializer.declarations;
  return declarations.length === 1 ? declarations[0].name : undefined;
}

// `for (const item of list) await helper(item);` with nothing else in the loop.
function soleLoopSite(call) {
  const awaited = awaitedStatement(call);
  const statement = awaited?.parent;
  if (!statement || !ts.isExpressionStatement(statement)) return;
  const container = statement.parent;
  const loop = ts.isBlock(container) && container.statements.length === 1 ? container.parent : container;
  if (!ts.isForOfStatement(loop) || (loop.statement !== statement && loop.statement !== container)) return;
  const binding = forOfBinding(loop);
  if (!binding) return;
  return {
    kind: 'loop',
    loop,
    awaited,
    collection: loop.expression,
    binding,
    names: loopNames(binding, loop.statement),
  };
}

// `await helper(key)` anywhere in a for-of body, outside nested functions and try blocks.
function prefetchSite(call) {
  const awaited = awaitedStatement(call);
  if (!awaited) return;
  for (let current = awaited.parent; current; current = current.parent) {
    if (ts.isFunctionLike(current) || ts.isTryStatement(current)) return;
    if (ts.isForOfStatement(current)) {
      const binding = forOfBinding(current);
      if (!binding) return;
      return {
        kind: 'prefetch',
        loop: current,
        awaited,
        collection: current.expression,
        binding,
        names: loopNames(binding, current.statement),
      };
    }
    if (ts.isIterationStatement(current, false)) return;
  }
}

// The one argument that differs per item; the others must be the same for the whole loop.
function varyingArgument(call, site) {
  const varying = call.arguments
    .map((argument, index) => ({ argument, index }))
    .filter(({ argument }) => references(argument, site.names));
  if (varying.length !== 1) return;
  if (contains(varying[0].argument, (node) => ts.isAwaitExpression(node) || ts.isFunctionLike(node))) return;
  return varying[0];
}

function isArrayExpression(expression) {
  const value = unwrap(expression);
  if (ts.isArrayLiteralExpression(value)) return true;
  if (!ts.isCallExpression(value) || !ts.isPropertyAccessExpression(value.expression)) return false;
  const method = value.expression.name.text;
  const receiver = textOf(value.expression.expression);
  return (
    arrayMethods.has(method) ||
    (receiver === 'Object' && objectListers.has(method)) ||
    (receiver === 'Array' && method === 'from')
  );
}

// The list of per-item argument values, as an expression over the loop's collection.
function listExpression(site, argument, typed) {
  const binding = textOf(site.binding);
  const collection = textOf(site.collection);
  const identity = ts.isIdentifier(site.binding) && textOf(argument) === binding;
  // A for-of loop accepts any iterable; .map() needs an array.
  const array =
    site.kind === 'all' || isArrayExpression(site.collection) || (typed && isPlainReference(unwrap(site.collection)));
  if (identity) return array ? collection : `Array.from(${collection})`;
  return array
    ? `${collection}.map((${binding}) => ${textOf(argument)})`
    : `Array.from(${collection}, (${binding}) => ${textOf(argument)})`;
}

function calleeText(call, batchName) {
  const callee = call.expression;
  return ts.isPropertyAccessExpression(callee) ? `${textOf(callee.expression)}.${batchName}` : batchName;
}

function batchCallText(call, batchName, itemIndex, list) {
  const parts = call.arguments.map((argument, index) => (index === itemIndex ? list : textOf(argument)));
  return `${calleeText(call, batchName)}(${parts.join(', ')})`;
}

// --- Assembling the fix ---

function insertMethod(callee, batchName, lines) {
  const { declaration } = callee;
  return {
    start: declaration.end,
    end: declaration.end,
    text: '\n\n' + lines.join('\n').replace('BATCH_NAME', batchName),
  };
}

// TypeORM's In() must be imported where the batch read is written.
function inImportEdit(sourceFile) {
  const imports = sourceFile.statements.filter(ts.isImportDeclaration);
  const typeormImport = imports.find(
    (declaration) => ts.isStringLiteral(declaration.moduleSpecifier) && declaration.moduleSpecifier.text === 'typeorm',
  );
  const named = typeormImport?.importClause?.namedBindings;
  if (!named || !ts.isNamedImports(named) || typeormImport.importClause.isTypeOnly) return;
  if (named.elements.some((element) => element.name.text === 'In' && !element.isTypeOnly)) return { edits: [] };
  if (contains(sourceFile, (node) => ts.isIdentifier(node) && node.text === 'In')) return;
  const position = named.elements.length ? named.elements.at(-1).end : named.getStart(sourceFile) + 1;
  return { edits: [{ start: position, end: position, text: named.elements.length ? ', In' : ' In ' }] };
}

// --- Reusing a batch sibling that already exists ---

// The declarations beside the helper: its class members, or the statements of the file holding a function.
function siblingDeclarations(declaration) {
  if (ts.isClassLike(declaration.parent)) return declaration.parent.members;
  return ts.isSourceFile(declaration.parent) || ts.isModuleBlock(declaration.parent)
    ? declaration.parent.statements
    : [];
}

function declaredName(declaration) {
  return declaration.name && ts.isIdentifier(declaration.name) ? declaration.name.text : undefined;
}

function hasModifier(declaration, kind) {
  return !!declaration.modifiers?.some((modifier) => modifier.kind === kind);
}

// Text compared line by line without indentation or line-ending differences, so a sibling an earlier fix inserted
// (possibly reformatted to the file's indentation) is recognised as this one.
function sameLines(declaration, lines) {
  const normalized = (text) =>
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .join('\n');
  return normalized(textOf(declaration)) === normalized(lines.join('\n'));
}

// A function in the file that takes exactly one parameter, so `list.map(fn)` passes it nothing extra that matters.
function unaryFunctionNamed(sourceFile, name) {
  return sourceFile.statements.some(
    (statement) =>
      ts.isFunctionDeclaration(statement) &&
      statement.name?.text === name &&
      statement.parameters.length === 1 &&
      !statement.parameters[0].dotDotDotToken,
  );
}

// A canonical form of an expression: parameters by position, arrow parameters by depth, `(x) => fn(x)` as `fn`
// when `fn` is a one-parameter function of `sourceFile`, and no formatting. Two expressions with the same form do
// the same thing.
function canonical(node, names, sourceFile, depth = 0) {
  if (ts.isParenthesizedExpression(node)) return canonical(node.expression, names, sourceFile, depth);
  if (ts.isIdentifier(node)) {
    const parent = node.parent;
    const propertyName =
      parent && (ts.isPropertyAccessExpression(parent) || ts.isPropertyAssignment(parent)) && parent.name === node;
    return propertyName ? node.text : (names.get(node.text) ?? node.text);
  }
  if (ts.isArrowFunction(node) && node.parameters.length === 1 && ts.isIdentifier(node.parameters[0].name)) {
    const parameter = node.parameters[0].name.text;
    const body = ts.isParenthesizedExpression(node.body) ? node.body.expression : node.body;
    const forwards =
      ts.isCallExpression(body) &&
      ts.isIdentifier(body.expression) &&
      body.arguments.length === 1 &&
      ts.isIdentifier(body.arguments[0]) &&
      body.arguments[0].text === parameter &&
      unaryFunctionNamed(sourceFile, body.expression.text);
    if (forwards) return canonical(body.expression, names, sourceFile, depth);
    const inner = new Map(names).set(parameter, `$arrow${depth}`);
    return `(${inner.get(parameter)})=>${canonical(node.body, inner, sourceFile, depth + 1)}`;
  }
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return `#${node.getText()}`;
  const children = [];
  ts.forEachChild(node, (child) => {
    children.push(canonical(child, names, sourceFile, depth));
  });
  return children.length ? `${node.kind}(${children.join(',')})` : `${node.kind}:${node.getText()}`;
}

function parsedExpression(text, sourceFile) {
  const parsed = ts.createSourceFile(sourceFile.fileName, `(${text});`, ts.ScriptTarget.Latest, true);
  const [statement] = parsed.statements;
  return statement && ts.isExpressionStatement(statement) ? { node: statement.expression, sourceFile: parsed } : {};
}

// `if (!list.length) return;` or `if (list.length === 0) return;`: nothing to write for an empty list.
function emptyListGuard(statement, listName) {
  if (!ts.isIfStatement(statement) || statement.elseStatement) return false;
  const thenStatement =
    ts.isBlock(statement.thenStatement) && statement.thenStatement.statements.length === 1
      ? statement.thenStatement.statements[0]
      : statement.thenStatement;
  if (!ts.isReturnStatement(thenStatement) || thenStatement.expression) return false;
  const condition = textOf(statement.expression).replace(/\s+/g, '');
  return [`!${listName}.length`, `${listName}.length===0`, `${listName}.length<1`].includes(condition);
}

// The project's own array variant of a write helper: the same parameters with the item one as a list, and a body
// that only skips an empty list and runs the same batch write the generated sibling would.
function equivalentWrite(member, callee, write, itemIndex) {
  const { declaration } = callee;
  if (
    member === declaration ||
    member.kind !== declaration.kind ||
    !member.body ||
    !ts.isBlock(member.body) ||
    member.parameters.length !== declaration.parameters.length ||
    !simpleParameters(member) ||
    hasModifier(member, ts.SyntaxKind.StaticKeyword) !== hasModifier(declaration, ts.SyntaxKind.StaticKeyword)
  )
    return false;
  const sameParameters = declaration.parameters.every((parameter, index) => {
    const other = member.parameters[index];
    const typeText = (candidate) => (candidate.type ? textOf(candidate.type) : '');
    if (index !== itemIndex) return typeText(parameter) === typeText(other);
    if (!parameter.type || !other.type) return !parameter.type && !other.type;
    const item = textOf(parameter.type);
    return [`${item}[]`, `readonly ${item}[]`, `Array<${item}>`, `ReadonlyArray<${item}>`].includes(textOf(other.type));
  });
  if (!sameParameters) return false;
  const listName = member.parameters[itemIndex].name.text;
  const statements = member.body.statements.filter((statement) => !emptyListGuard(statement, listName));
  const [statement] = statements;
  if (statements.length !== 1 || !(ts.isExpressionStatement(statement) || ts.isReturnStatement(statement)))
    return false;
  const awaited = statement.expression && unwrap(statement.expression);
  if (!awaited || !ts.isAwaitExpression(awaited)) return false;
  const positions = (parameters, list) =>
    new Map(
      parameters.map((parameter, index) => [parameter.name.text, index === itemIndex ? list : `$argument${index}`]),
    );
  const handler = write.handler ? `.catch(${textOf(write.handler)})` : '';
  const expected = parsedExpression(
    `${write.batchCall(listName, declaration.parameters[itemIndex].name.text)}${handler}`,
    declaration.getSourceFile(),
  );
  if (!expected.node) return false;
  const sourceFile = declaration.getSourceFile();
  const ownNames = positions(member.parameters, '$list');
  // The generated call names the list after the member's own parameter; the other parameters use the helper's names.
  const expectedNames = new Map([...positions(declaration.parameters, '$item'), [listName, '$list']]);
  return canonical(awaited.expression, ownNames, sourceFile) === canonical(expected.node, expectedNames, sourceFile);
}

// The batch sibling to call: one already in the file (inserted by an earlier fix, or the project's own array variant
// of the same write), or a new `<helper>Many`. Undefined when that name already holds something different.
function batchTarget(callee, lines, write, itemIndex) {
  const { declaration } = callee;
  const name = `${textOf(declaration.name)}Many`;
  const siblings = siblingDeclarations(declaration);
  const sameName = siblings.find((sibling) => declaredName(sibling) === name);
  if (sameName) {
    const reusable =
      sameLines(
        sameName,
        lines.map((line) => line.replace('BATCH_NAME', name)),
      ) ||
      (write && equivalentWrite(sameName, callee, write, itemIndex));
    return reusable ? { name, existing: sameName } : undefined;
  }
  const equivalent = write && siblings.find((sibling) => equivalentWrite(sibling, callee, write, itemIndex));
  if (equivalent) return { name: declaredName(equivalent), existing: equivalent };
  // A new function shares the file's scope; a new method only the class's members.
  if (ts.isFunctionDeclaration(declaration) && nameTaken(declaration.getSourceFile(), name)) return;
  return { name };
}

// A private or protected sibling can only be called from inside its own class.
function callableFrom(existing, call) {
  const hidden =
    hasModifier(existing, ts.SyntaxKind.PrivateKeyword) ||
    hasModifier(existing, ts.SyntaxKind.ProtectedKeyword) ||
    (existing.name && ts.isPrivateIdentifier(existing.name));
  if (!hidden) return true;
  for (let current = call.parent; current; current = current.parent)
    if (ts.isClassLike(current)) return current === existing.parent;
  return false;
}

// --- Importing a batch function declared in another file ---

const resolvedExtensions = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];

// Whether a relative module specifier written in `fromFile` names `targetFile` (with or without its extension, a
// `.js` written for a `.ts` source, or an index file).
function specifierNames(specifier, fromFile, targetFile) {
  if (!/^\.\.?(?:\/|$)/.test(specifier)) return false;
  const base = path.resolve(path.dirname(fromFile), specifier);
  const stem = base.replace(/\.[cm]?[jt]sx?$/i, '');
  const candidates = [
    base,
    ...resolvedExtensions.flatMap((extension) => [stem + extension, path.join(base, 'index' + extension)]),
  ];
  const target = path.resolve(targetFile).toLowerCase();
  return candidates.some((candidate) => candidate.toLowerCase() === target);
}

// The edit adding `batchName` next to `name` in the call site's named import of the helper's file.
function importBatchEdit(sourceFile, name, batchName, calleeFile) {
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (statement.importClause.isTypeOnly || !bindings || !ts.isNamedImports(bindings)) continue;
    if (!specifierNames(statement.moduleSpecifier.text, sourceFile.fileName, calleeFile)) continue;
    const element = bindings.elements.find((candidate) => candidate.name.text === name);
    if (!element || element.propertyName || element.isTypeOnly) return;
    if (bindings.elements.some((candidate) => candidate.name.text === batchName)) return [];
    if (nameTaken(sourceFile, batchName)) return;
    return [{ start: element.end, end: element.end, text: `, ${batchName}` }];
  }
}

// An exported top-level function called by its own name from another file that imports it by name.
function crossFileImport(callee, call, sourceFile, batchName) {
  const { declaration } = callee;
  if (!ts.isSourceFile(declaration.parent) || !hasModifier(declaration, ts.SyntaxKind.ExportKeyword)) return;
  if (hasModifier(declaration, ts.SyntaxKind.DefaultKeyword) || !ts.isIdentifier(call.expression)) return;
  return importBatchEdit(sourceFile, call.expression.text, batchName, callee.entry.absolute);
}

function targetsOf(editsByFile) {
  return [...editsByFile].map(([file, edits]) => ({ file, edits }));
}

function addEdits(editsByFile, file, edits) {
  editsByFile.set(file, [...(editsByFile.get(file) ?? []), ...edits]);
}

function batchedFix({ finding, call, sourceFile, load }) {
  const family = clientFamily(finding.message);
  const name = ts.isPropertyAccessExpression(call.expression) ? call.expression.name.text : textOf(call.expression);
  const callee = family && directCallee(finding, name, load);
  if (!callee || finding.related.length !== 1) return;
  const crossFile = ts.isFunctionDeclaration(callee.declaration) && callee.entry.sourceFile !== sourceFile;
  const typed = typedExtensions.test(callee.entry.sourceFile.fileName);
  const siteTyped = typedExtensions.test(sourceFile.fileName);
  const read = readBatch(callee, family, typed);
  const write = !read && writeBatch(callee, family, typed);
  if (!read && !write) return;
  const site =
    promiseAllSite(call) ?? (write ? soleLoopSite(call) : undefined) ?? (read?.bare ? prefetchSite(call) : undefined);
  if (!site) return;
  const varying = varyingArgument(call, site);
  if (!varying || call.arguments.length !== callee.declaration.parameters.length) return;
  const itemIndex = read ? read.itemIndex : varying.index;
  if (varying.index !== itemIndex) return;
  if (write && !write.used.includes(callee.declaration.parameters[itemIndex].name.text)) return;
  if (site.kind === 'all' && write && !ts.isExpressionStatement(awaitedStatement(site.all)?.parent ?? site.all.parent))
    return;
  const listName = read ? read.listName : pluralOf(callee.declaration.parameters[itemIndex].name.text);
  if (write && contains(callee.declaration, (node) => ts.isIdentifier(node) && node.text === listName)) return;
  const lines = read ? read.lines : writeLines(callee, write, itemIndex, listName);
  const target = batchTarget(callee, lines, write, itemIndex);
  if (!target || (target.existing && !callableFrom(target.existing, call))) return;
  const batch = target.name;
  const imported = crossFile && crossFileImport(callee, call, sourceFile, batch);
  if (crossFile && !imported) return;
  const editsByFile = new Map();
  addEdits(editsByFile, finding.file, [
    ...(imported || []),
    ...siteEdits({ site, call, batch, itemIndex, argument: varying.argument, read, sourceFile, typed: siteTyped }),
  ]);
  const calleeFile = callee.entry.filename;
  if (!target.existing) {
    addEdits(editsByFile, calleeFile, [insertMethod(callee, batch, lines)]);
    if (read?.needsIn) {
      const importEdit = inImportEdit(callee.entry.sourceFile);
      if (!importEdit) return;
      addEdits(editsByFile, calleeFile, importEdit.edits);
    }
  }
  if ([...editsByFile.values()].flat().some((edit) => edit === undefined)) return;
  return { targets: targetsOf(editsByFile), note: batchNote(site, read, write, batch, !!target.existing) };
}

function siteEdits({ site, call, batch, itemIndex, argument, read, sourceFile, typed }) {
  const list = listExpression(site, argument, typed);
  if (site.kind === 'all')
    return [
      { start: site.all.getStart(sourceFile), end: site.all.end, text: batchCallText(call, batch, itemIndex, list) },
    ];
  if (site.kind === 'loop')
    return [
      {
        start: site.loop.getStart(sourceFile),
        end: site.loop.end,
        text: `await ${batchCallText(call, batch, itemIndex, list)};`,
      },
    ];
  // Prefetch: the key is evaluated again inside the loop, so it must be free of side effects.
  if (!isPlainReference(unwrap(argument)) || !isPlainReference(unwrap(site.collection))) return [undefined];
  const keys = freshName(sourceFile, read.listName);
  const byKey = freshName(sourceFile, `${textOf(call.expression).split('.').at(-1)}ByKey`);
  if (!keys || !byKey) return [undefined];
  const fallback = read.single ? 'null' : '[]';
  const lookup = `${byKey}.get(${textOf(argument)}) ?? ${fallback}`;
  const parent = site.awaited.parent;
  const inline = ts.isVariableDeclaration(parent) || ts.isReturnStatement(parent) ? lookup : `(${lookup})`;
  const indentation = indentationAt(sourceFile.text, site.loop.getStart(sourceFile));
  const prefetch = [
    `const ${keys} = ${list};`,
    `const ${byKey} = new Map((await ${batchCallText(call, batch, itemIndex, keys)}).map((result, index) => [${keys}[index], result]));`,
  ];
  const anchor = ts.isLabeledStatement(site.loop.parent) ? site.loop.parent : site.loop;
  const loopStart = anchor.getStart(sourceFile);
  return [
    { start: loopStart, end: loopStart, text: prefetch.join('\n' + indentation) + '\n' + indentation },
    { start: site.awaited.getStart(sourceFile), end: site.awaited.end, text: inline },
  ];
}

function batchNote(site, read, write, batch, existing) {
  const verb = existing ? 'Calls the existing' : 'Adds';
  if (read) {
    const timing =
      site.kind === 'prefetch'
        ? ' All keys are read before the loop, so rows the loop writes before reading them are not seen, and items the loop skips are still fetched.'
        : '';
    return `${verb} ${batch}(): ${read.note}${timing}`;
  }
  return `${verb} ${batch}(), which writes all rows in one statement after the loop instead of one per item. The batch is all-or-nothing (a failing row no longer leaves the earlier rows written), ${
    write.batchCall('x', 'y').includes('createMany')
      ? 'createMany does not run nested writes or return the rows, '
      : 'entity listeners still run per row, '
  }and the rows are written when the loop would have finished.`;
}

// --- Fallback: run the calls a few at a time ---

// The helper only runs cache commands, every one of them listed rather than summarized as "and N more".
function overlapSafe(finding) {
  if (!/ Redis commands? per item/.test(finding.message) || /\d+ more\)/.test(finding.message)) return false;
  return finding.related.every((related) => {
    const label = /`([^`]+)`/.exec(related.message)?.[1];
    return label && overlapSafeCommands.has(label.split('.').at(-1).toLowerCase());
  });
}

function concurrentFix({ finding, call, sourceFile }) {
  // Tests, seeds and scripts run sequentially on purpose more often than not, and their speed rarely matters.
  if (finding.contextualReason || migrationSource.test(finding.file) || !overlapSafe(finding)) return;
  const site = soleLoopSite(call);
  // Several statements replace the loop, which only a block (not an `if` body or a label) can hold.
  if (!site || !(ts.isBlock(site.loop.parent) || ts.isSourceFile(site.loop.parent))) return;
  const operand = site.awaited.expression;
  if (contains(operand, ts.isAwaitExpression)) return;
  const handles = new Set();
  (function visit(node) {
    if (ts.isIdentifier(node) && !isPropertyName(node) && transactionHandle.test(node.text)) handles.add(node.text);
    ts.forEachChild(node, visit);
  })(operand);
  // Calls on one transaction share its connection, so they cannot overlap anyway.
  if (handles.size) return;
  for (let current = site.loop.parent; current; current = current.parent) {
    if (!ts.isFunctionLike(current)) continue;
    const owner = current.parent;
    if (ts.isCallExpression(owner) && /transaction/i.test(textOf(owner.expression))) return;
    break;
  }
  const items = freshName(sourceFile, 'pendingItems');
  const start = freshName(sourceFile, 'start');
  const limit = freshName(sourceFile, 'concurrentCalls');
  if (!items || !start || !limit) return;
  const indentation = indentationAt(sourceFile.text, site.loop.getStart(sourceFile));
  const lines = [
    `const ${limit} = ${CONCURRENT_CALLS};`,
    `const ${items} = Array.from(${textOf(site.collection)});`,
    `for (let ${start} = 0; ${start} < ${items}.length; ${start} += ${limit}) {`,
    `  await Promise.all(${items}.slice(${start}, ${start} + ${limit}).map((${textOf(site.binding)}) => ${textOf(operand)}));`,
    '}',
  ];
  const name = textOf(call.expression);
  return {
    edits: [{ start: site.loop.getStart(sourceFile), end: site.loop.end, text: lines.join('\n' + indentation) }],
    note: `This does not cut the number of queries: no batch variant could be derived from \`${name}()\`, so a set-based version of it, or one multi-key client call such as Redis \`del(...keys)\` or \`mget(...keys)\`, is still the real fix. Meanwhile it runs up to ${CONCURRENT_CALLS} calls at once to cut wall time. Calls now overlap and may finish out of order, and when one fails the others of its group still run (later groups do not start). Apply only if the items are independent of each other.`,
  };
}

function serviceLoopFix({ finding, node, sourceFile, load }) {
  const call = calleeCall(node);
  if (!call) return;
  return batchedFix({ finding, call, sourceFile, load }) ?? concurrentFix({ finding, call, sourceFile });
}

module.exports = { 'service-query-in-loop': serviceLoopFix };
