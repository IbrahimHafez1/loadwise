'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { ts, calleeCall, replaceNode, textOf, freshName, indentationAt } = require('./helpers.cjs');
const { findProjectRoot } = require('../schema/context.cjs');
const { distinctFields, optionProperty, propertyKey, propertyValue } = require('../prisma-aggregates.cjs');

const FIXABLE_OPTIONS = new Set(['where', 'select', 'distinct', 'orderBy', 'take', 'skip']);
const PAGING_OPTIONS = ['take', 'skip'];
const SORT_DIRECTIONS = new Set(['asc', 'desc']);
const SCHEMA_FILES = [path.join('prisma', 'schema.prisma'), 'schema.prisma'];
const SCHEMA_FOLDER = path.join('prisma', 'schema');

// `select: { a: true }` whose keys all belong to the distinct fields.
function selectsOnly(selectProperty, fields) {
  const value = propertyValue(selectProperty);
  if (!value || !ts.isObjectLiteralExpression(value) || !value.properties.length) return false;
  return value.properties.every(
    (property) =>
      ts.isPropertyAssignment(property) &&
      fields.includes(propertyKey(property)) &&
      property.initializer.kind === ts.SyntaxKind.TrueKeyword,
  );
}

// groupBy only orders by its `by` fields (or aggregates), so a sort on anything else cannot move over.
function ordersOnly(orderByProperty, fields) {
  const value = propertyValue(orderByProperty);
  if (!value) return false;
  const entries = ts.isArrayLiteralExpression(value) ? value.elements : [value];
  return entries.every(
    (entry) =>
      ts.isObjectLiteralExpression(entry) &&
      entry.properties.every(
        (property) =>
          ts.isPropertyAssignment(property) &&
          fields.includes(propertyKey(property)) &&
          ts.isStringLiteralLike(property.initializer) &&
          SORT_DIRECTIONS.has(property.initializer.text),
      ),
  );
}

// The quote the file already uses for the distinct field names.
function quoted(distinctProperty, field) {
  const quote = textOf(propertyValue(distinctProperty)).includes('"') ? '"' : "'";
  return quote + field + quote;
}

// True when `options` holds a comment outside the kept properties, which rebuilding the object would drop.
function dropsComment(options, keptProperties) {
  const sourceFile = options.getSourceFile();
  const start = options.getStart(sourceFile);
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    false,
    sourceFile.languageVariant,
    sourceFile.text.slice(start, options.end),
  );
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    const isComment = token === ts.SyntaxKind.SingleLineCommentTrivia || token === ts.SyntaxKind.MultiLineCommentTrivia;
    const position = start + scanner.getTokenStart();
    const kept = keptProperties.some(
      (property) => property.getStart(sourceFile) <= position && position < property.end,
    );
    if (isComment && !kept) return true;
  }
  return false;
}

function distinctFix({ node }) {
  const call = calleeCall(node);
  if (!call || !ts.isPropertyAccessExpression(call.expression) || call.arguments.length !== 1) return;
  const options = call.arguments[0];
  if (!ts.isObjectLiteralExpression(options)) return;
  if (!options.properties.every((property) => FIXABLE_OPTIONS.has(propertyKey(property)))) return;
  const distinctProperty = optionProperty(options, 'distinct');
  const selectProperty = optionProperty(options, 'select');
  const fields = distinctProperty && distinctFields(distinctProperty);
  if (!fields || !selectProperty || !selectsOnly(selectProperty, fields)) return;
  const orderByProperty = optionProperty(options, 'orderBy');
  if (orderByProperty && !ordersOnly(orderByProperty, fields)) return;
  const paged = PAGING_OPTIONS.some((key) => optionProperty(options, key));
  // groupBy rejects take/skip without an orderBy, so a page of distinct values gets an explicit order.
  const addedOrder = paged && !orderByProperty;
  const orderEntries = fields.map((field) => `{ ${field}: ${quoted(distinctProperty, 'asc')} }`);
  const orderBy = `orderBy: ${orderEntries.length === 1 ? orderEntries[0] : `[${orderEntries.join(', ')}]`}`;
  const keptProperties = ['where', 'orderBy', ...PAGING_OPTIONS]
    .map((key) => optionProperty(options, key))
    .filter(Boolean);
  if (dropsComment(options, keptProperties)) return;
  const kept = ['where', 'orderBy', ...PAGING_OPTIONS].flatMap((key) => {
    const property = optionProperty(options, key);
    if (property) return [textOf(property)];
    return key === 'orderBy' && addedOrder ? [orderBy] : [];
  });
  const by = `by: [${fields.map((field) => quoted(distinctProperty, field)).join(', ')}]`;
  const note = addedOrder
    ? `groupBy needs an orderBy to page, so this pages through ${fields.join(', ')} in ascending order; the original page had no order, so check that callers do not rely on which distinct values the page held.`
    : 'groupBy returns one row per distinct combination; rows come back in unspecified order unless orderBy is set.';
  return {
    edits: [replaceNode(call.expression.name, 'groupBy'), replaceNode(options, `{ ${[by, ...kept].join(', ')} }`)],
    note,
  };
}

// --- prisma-relation-count-in-list ---

const schemaCache = new Map();

function schemaText(fileName) {
  const root = findProjectRoot(path.dirname(fileName));
  if (schemaCache.has(root)) return schemaCache.get(root);
  const texts = [];
  for (const location of SCHEMA_FILES) {
    try {
      texts.push(fs.readFileSync(path.join(root, location), 'utf8'));
      break;
    } catch {
      // Try the next conventional location.
    }
  }
  try {
    for (const name of fs.readdirSync(path.join(root, SCHEMA_FOLDER)))
      if (name.endsWith('.prisma')) texts.push(fs.readFileSync(path.join(root, SCHEMA_FOLDER, name), 'utf8'));
  } catch {
    // Single-file schemas have no schema folder.
  }
  const text = texts.join('\n');
  schemaCache.set(root, text);
  return text;
}

function relationAttribute(rest) {
  const match = /@relation\(([^)]*)\)/.exec(rest);
  if (!match) return;
  const list = (key) =>
    new RegExp(`${key}\\s*:\\s*\\[([^\\]]*)\\]`)
      .exec(match[1])?.[1]
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  const name = /^\s*"([^"]*)"/.exec(match[1])?.[1] ?? /name\s*:\s*"([^"]*)"/.exec(match[1])?.[1];
  return { name, fields: list('fields'), references: list('references') };
}

// model name -> [{ name, type, list, relation }]
function parseModels(text) {
  const models = new Map();
  for (const match of text.matchAll(/^\s*model\s+(\w+)\s*\{([\s\S]*?)^\s*\}/gm)) {
    const fields = [];
    for (const line of match[2].split('\n')) {
      const field = /^\s*(\w+)\s+(\w+)(\[\])?\??(.*)$/.exec(line.replace(/\/\/.*$/, ''));
      if (field)
        fields.push({ name: field[1], type: field[2], list: Boolean(field[3]), relation: relationAttribute(field[4]) });
    }
    models.set(match[1], fields);
  }
  return models;
}

// The child model and its single-column foreign key for a one-to-many relation field of `modelName`.
function foreignKeyOf(models, modelName, relationName) {
  const listField = models.get(modelName)?.find((field) => field.name === relationName);
  if (!listField?.list) return;
  const backFields = (models.get(listField.type) ?? []).filter(
    (field) => field.type === modelName && !field.list && field.relation?.fields?.length === 1,
  );
  const matching = backFields.filter((field) => field.relation.name === listField.relation?.name);
  if (matching.length !== 1 || matching[0].relation.references?.length !== 1) return;
  return {
    model: listField.type,
    foreignKey: matching[0].relation.fields[0],
    reference: matching[0].relation.references[0],
  };
}

function accessorOf(modelName) {
  return modelName[0].toLowerCase() + modelName.slice(1);
}

// `rel: true` counts every row; `rel: { where }` counts matching rows; anything else is not understood.
function countFilter(property) {
  const value = propertyValue(property);
  if (value?.kind === ts.SyntaxKind.TrueKeyword) return { where: undefined };
  if (!value || !ts.isObjectLiteralExpression(value) || value.properties.length !== 1) return;
  const where = optionProperty(value, 'where');
  return where && ts.isPropertyAssignment(where) ? { where: textOf(where.initializer) } : undefined;
}

// Removes `property` and its separator, taking whole lines when it sits on lines of its own.
function removeProperty(property, text) {
  const sourceFile = property.getSourceFile();
  let start = property.getStart(sourceFile);
  let end = property.end;
  const comma = /^\s*,/.exec(text.slice(end));
  if (comma) end += comma[0].length;
  const lineBegin = text.lastIndexOf('\n', start - 1) + 1;
  const lineFinish = text.indexOf('\n', end);
  if (!text.slice(lineBegin, start).trim() && lineFinish !== -1 && !text.slice(end, lineFinish).trim())
    return { start: lineBegin, end: lineFinish + 1, text: '' };
  if (!comma) {
    const previous = /,\s*$/.exec(text.slice(0, start));
    if (previous) start -= previous[0].length;
  }
  return { start, end, text: '' };
}

// Prisma only accepts its own promises in `$transaction([...])`, and `.then()` returns a plain one. Returns the
// array element holding the call, or undefined outside a batch.
function batchTransactionElement(call) {
  let expression = call;
  while (ts.isParenthesizedExpression(expression.parent)) expression = expression.parent;
  const array = expression.parent;
  if (!array || !ts.isArrayLiteralExpression(array)) return;
  const outer = array.parent;
  const isBatch =
    ts.isCallExpression(outer) &&
    ts.isPropertyAccessExpression(outer.expression) &&
    outer.expression.name.text === '$transaction';
  return isBatch ? { expression, array, outer } : undefined;
}

// `const [rows, total] = await client.$transaction([findMany, count])` as the binding of the page rows and its
// statement, so the counts can be merged in below the statement instead of inside the batch.
function batchRowsBinding({ expression, array, outer }) {
  const awaited = outer.parent;
  const declaration = awaited && ts.isAwaitExpression(awaited) ? awaited.parent : undefined;
  if (!declaration || !ts.isVariableDeclaration(declaration) || declaration.initializer !== awaited) return;
  if (declaration.type || !ts.isArrayBindingPattern(declaration.name)) return;
  const list = declaration.parent;
  const isBlockScoped = list.flags & (ts.NodeFlags.Const | ts.NodeFlags.Let);
  if (list.declarations.length !== 1 || !isBlockScoped) return;
  const statement = list.parent;
  if (!ts.isVariableStatement(statement) || !ts.isBlock(statement.parent)) return;
  const index = array.elements.indexOf(expression);
  const element = declaration.name.elements[index];
  if (!element || ts.isOmittedExpression(element) || !ts.isIdentifier(element.name)) return;
  if (element.initializer || element.dotDotDotToken || element.propertyName) return;
  return { name: element.name, statement, keyword: list.flags & ts.NodeFlags.Const ? 'const' : 'let' };
}

function relationCountFix({ finding, node, sourceFile, text }) {
  const modelName = /Paged (\w+)\.findMany/.exec(finding.message)?.[1];
  const call = calleeCall(node);
  if (!modelName || !call || call.arguments.length !== 1) return;
  const batch = batchTransactionElement(call);
  const batchRows = batch && batchRowsBinding(batch);
  if (batch && !batchRows) return;
  const delegate = call.expression;
  if (!ts.isPropertyAccessExpression(delegate) || !ts.isPropertyAccessExpression(delegate.expression)) return;
  const client = textOf(delegate.expression.expression);
  const options = ts.skipOuterExpressions(call.arguments[0]);
  if (!ts.isObjectLiteralExpression(options)) return;
  const projectionKey = ['select', 'include'].find((key) => {
    const value = optionProperty(options, key) && propertyValue(optionProperty(options, key));
    return value && ts.isObjectLiteralExpression(value) && optionProperty(value, '_count');
  });
  if (!projectionKey) return;
  const projection = propertyValue(optionProperty(options, projectionKey));
  const countProperty = optionProperty(projection, '_count');
  const countValue = propertyValue(countProperty);
  const counted = countValue && ts.isObjectLiteralExpression(countValue) && optionProperty(countValue, 'select');
  const countedValue = counted && propertyValue(counted);
  if (!countedValue || !ts.isObjectLiteralExpression(countedValue) || countValue.properties.length !== 1) return;
  const models = parseModels(schemaText(sourceFile.fileName));
  const relations = [];
  for (const property of countedValue.properties) {
    const name = propertyKey(property);
    const filter = name && countFilter(property);
    const key = filter && foreignKeyOf(models, modelName, name);
    if (!key) return;
    relations.push({ name, ...key, where: filter.where });
  }
  const reference = relations[0].reference;
  if (relations.some((relation) => relation.reference !== reference)) return;
  const edits = [removeProperty(countProperty, text)];
  const selectsReference = projectionKey === 'include' || optionProperty(projection, reference);
  if (!selectsReference) {
    const opening = projection.getStart(sourceFile) + 1;
    edits.push({ start: opening, end: opening, text: ` ${reference}: true,` });
  }
  const added = selectsReference ? '' : ` It also selects \`${reference}\`, which the rows did not carry before.`;
  if (batchRows) {
    const merged = batchMerge(sourceFile, text, batchRows, { client, relations, reference });
    if (!merged) return;
    return {
      edits: [...edits, ...merged],
      note: `The batch reads the page without counts, and the counts come from one groupBy per relation over the page's ids right after it, outside the batch transaction. Rows keep the \`_count\` shape.${added}`,
    };
  }
  edits.push({
    start: call.end,
    end: call.end,
    text: thenClause({ sourceFile, text, call, client, relations, reference }),
  });
  return {
    edits,
    note: `The page is read first and the counts come from one groupBy per relation over the page's ids, so they are read in a separate query (inside an interactive transaction keep using its client). Rows keep the \`_count\` shape.${added}`,
  };
}

// The batch binds the page under a fresh name; the lines below the statement count and rebuild the original name.
function batchMerge(sourceFile, text, { name, statement, keyword }, { client, relations, reference }) {
  const rows = freshName(sourceFile, 'pageRows');
  if (!rows) return;
  const lines = countLines(sourceFile, client, relations, reference, rows);
  if (!lines) return;
  lines.push(`${keyword} ${name.text} = ${lines.pop()}`);
  const indentation = indentationAt(text, statement.getStart(sourceFile));
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  return [
    { start: name.getStart(sourceFile), end: name.end, text: rows },
    { start: statement.end, end: statement.end, text: lines.map((line) => eol + indentation + line).join('') },
  ];
}

function thenClause({ sourceFile, text, call, client, relations, reference }) {
  const rows = freshName(sourceFile, 'pageRows');
  const indentation = indentationAt(text, call.end);
  const body = countLines(sourceFile, client, relations, reference, rows);
  body.push(`return ${body.pop()}`);
  const lines = [`.then(async (${rows}) => {`, ...body.map((line) => `  ${line}`), '})'];
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  return lines.map((line, index) => (index ? indentation + line : line)).join(eol);
}

// Statements that count each relation over the ids of `rows`; the last line is the merged rows expression.
function countLines(sourceFile, client, relations, reference, rows) {
  const fresh = (base) => freshName(sourceFile, base);
  const ids = fresh('pageIds');
  const groupCall = (relation) => {
    const keyFilter = `{ ${relation.foreignKey}: { in: ${ids} } }`;
    const where = relation.where ? `{ AND: [${keyFilter}, ${relation.where}] }` : keyFilter;
    return `${client}.${accessorOf(relation.model)}.groupBy({ by: ["${relation.foreignKey}"], where: ${where}, _count: { _all: true } })`;
  };
  const named = relations.map((relation) => ({
    ...relation,
    groups: fresh(`${relation.name}Groups`),
    byId: fresh(`${relation.name}CountById`),
  }));
  const lines = [`const ${ids} = ${rows}.map((row) => row.${reference});`];
  if (named.length === 1) lines.push(`const ${named[0].groups} = await ${groupCall(named[0])};`);
  else {
    lines.push(`const [${named.map((relation) => relation.groups).join(', ')}] = await Promise.all([`);
    for (const relation of named) lines.push(`  ${groupCall(relation)},`);
    lines.push(']);');
  }
  for (const relation of named)
    lines.push(
      `const ${relation.byId} = new Map(${relation.groups}.map((group) => [group.${relation.foreignKey}, group._count._all]));`,
    );
  const counts = named.map((relation) => `${relation.name}: ${relation.byId}.get(row.${reference}) ?? 0`).join(', ');
  lines.push(`${rows}.map((row) => ({ ...row, _count: { ${counts} } }));`);
  return lines;
}

module.exports = { 'prisma-distinct-in-memory': distinctFix, 'prisma-relation-count-in-list': relationCountFix };
