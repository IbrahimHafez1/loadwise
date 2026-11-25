import fs from 'node:fs';
import path from 'node:path';
import { requireReview, ts, calleeCall, replaceNode, textOf, freshName, indentationAt } from './helpers.js';
import { findProjectRoot } from '../schema/context.js';
import { distinctFields, optionProperty, propertyKey, propertyValue } from '../prisma-aggregates.js';
import type {
  ArrayLiteralExpression,
  CallExpression,
  Expression,
  Identifier,
  Node,
  ObjectLiteralElementLike,
  ObjectLiteralExpression,
  SourceFile,
  VariableStatement,
} from 'typescript';
import type { Finding, FixResult, SiteFixInput, TextEdit } from '../../shared/types.js';

/** A `@relation(...)` attribute of a Prisma schema field. */
interface RelationAttribute {
  name: string | undefined;
  fields: string[] | undefined;
  references: string[] | undefined;
}

/** One field of a Prisma schema model. */
interface ModelField {
  name: string;
  type: string;
  list: boolean;
  relation: RelationAttribute | undefined;
}

/** The child model and its single-column foreign key for a one-to-many relation field. */
interface ForeignKey {
  model: string;
  foreignKey: string;
  reference: string;
}

/** One relation counted in `_count`, with the filter its count carries. */
interface RelationCount extends ForeignKey {
  name: string;
  where: string | undefined;
}

/** The relations whose counts are read in separate queries, and the client that reads them. */
interface CountPlan {
  client: string;
  relations: RelationCount[];
  reference: string;
}

/** What the `.then()` form of the rewrite needs. */
interface ThenClauseInput extends CountPlan {
  sourceFile: SourceFile;
  text: string;
  call: CallExpression;
}

/** The array element of a `$transaction([...])` batch that holds the call. */
interface BatchElement {
  expression: Expression;
  array: ArrayLiteralExpression;
  outer: CallExpression;
}

/** The binding of the page rows in `const [rows, total] = await client.$transaction([...])`. */
interface BatchRows {
  name: Identifier;
  statement: VariableStatement;
  keyword: 'const' | 'let';
}

const FIXABLE_OPTIONS = new Set(['where', 'select', 'distinct', 'orderBy', 'take', 'skip']);
const PAGING_OPTIONS = ['take', 'skip'];
const SORT_DIRECTIONS = new Set(['asc', 'desc']);
const SCHEMA_FILES = [path.join('prisma', 'schema.prisma'), 'schema.prisma'];
const SCHEMA_FOLDER = path.join('prisma', 'schema');

// `select: { a: true }` whose keys all belong to the distinct fields.
// True when the property's key is one of `keys`.
function keyIn(property: ObjectLiteralElementLike, keys: readonly string[]): boolean {
  const key = propertyKey(property);
  return key !== undefined && keys.includes(key);
}

function selectsOnly(selectProperty: ObjectLiteralElementLike, fields: readonly string[]): boolean {
  const value = propertyValue(selectProperty);
  if (!value || !ts.isObjectLiteralExpression(value) || !value.properties.length) return false;
  return value.properties.every(
    (property) =>
      ts.isPropertyAssignment(property) &&
      keyIn(property, fields) &&
      property.initializer.kind === ts.SyntaxKind.TrueKeyword,
  );
}

// groupBy only orders by its `by` fields (or aggregates), so a sort on anything else cannot move
// over.
function ordersOnly(orderByProperty: ObjectLiteralElementLike, fields: readonly string[]): boolean {
  const value = propertyValue(orderByProperty);
  if (!value) return false;
  const entries = ts.isArrayLiteralExpression(value) ? value.elements : [value];
  return entries.every(
    (entry) =>
      ts.isObjectLiteralExpression(entry) &&
      entry.properties.every(
        (property) =>
          ts.isPropertyAssignment(property) &&
          keyIn(property, fields) &&
          ts.isStringLiteralLike(property.initializer) &&
          SORT_DIRECTIONS.has(property.initializer.text),
      ),
  );
}

// The quote the file already uses for the distinct field names.
function quoted(distinctValue: Expression, field: string): string {
  const quote = textOf(distinctValue).includes('"') ? '"' : "'";
  return quote + field + quote;
}

// True when `options` holds a comment outside the kept properties, which rebuilding the object
// would drop.
function dropsComment(options: ObjectLiteralExpression, keptProperties: readonly Node[]): boolean {
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

function isFixableOption(property: ObjectLiteralElementLike): boolean {
  const key = propertyKey(property);
  return key !== undefined && FIXABLE_OPTIONS.has(key);
}

function distinctFix({ node }: SiteFixInput): FixResult | undefined {
  if (!node) return;
  const call = calleeCall(node);
  if (!call || !ts.isPropertyAccessExpression(call.expression) || call.arguments.length !== 1) return;
  const options = call.arguments[0];
  if (!ts.isObjectLiteralExpression(options)) return;
  if (!options.properties.every(isFixableOption)) return;
  const distinctProperty = optionProperty(options, 'distinct');
  const selectProperty = optionProperty(options, 'select');
  const fields = distinctProperty && distinctFields(distinctProperty);
  const distinctValue = distinctProperty && propertyValue(distinctProperty);
  if (!fields || !distinctValue || !selectProperty || !selectsOnly(selectProperty, fields)) return;
  const orderByProperty = optionProperty(options, 'orderBy');
  if (orderByProperty && !ordersOnly(orderByProperty, fields)) return;
  const paged = PAGING_OPTIONS.some((key) => optionProperty(options, key));
  // groupBy rejects take/skip without an orderBy, so a page of distinct values gets an explicit
  // order.
  const addedOrder = paged && !orderByProperty;
  const orderEntries = fields.map((field) => `{ ${field}: ${quoted(distinctValue, 'asc')} }`);
  const orderBy = `orderBy: ${orderEntries.length === 1 ? orderEntries[0] : `[${orderEntries.join(', ')}]`}`;
  const keptProperties = ['where', 'orderBy', ...PAGING_OPTIONS]
    .map((key) => optionProperty(options, key))
    .filter((property): property is ObjectLiteralElementLike => property !== undefined);
  if (dropsComment(options, keptProperties)) return;
  const kept = ['where', 'orderBy', ...PAGING_OPTIONS].flatMap((key) => {
    const property = optionProperty(options, key);
    if (property) return [textOf(property)];
    return key === 'orderBy' && addedOrder ? [orderBy] : [];
  });
  const by = `by: [${fields.map((field) => quoted(distinctValue, field)).join(', ')}]`;
  const note = addedOrder
    ? `groupBy needs an orderBy to page, so this pages through ${fields.join(', ')} in ascending order; the original page had no order, so check that callers do not rely on which distinct values the page held.`
    : 'groupBy returns one row per distinct combination; rows come back in unspecified order unless orderBy is set.';
  return {
    edits: [replaceNode(call.expression.name, 'groupBy'), replaceNode(options, `{ ${[by, ...kept].join(', ')} }`)],
    note,
  };
}

// --- prisma-relation-count-in-list ---

const schemaCache = new Map<string, string>();

function schemaText(fileName: string): string {
  const root = findProjectRoot(path.dirname(fileName));
  const cachedText = schemaCache.get(root);
  if (cachedText !== undefined) return cachedText;
  const texts: string[] = [];
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

function relationAttribute(rest: string): RelationAttribute | undefined {
  const match = /@relation\(([^)]*)\)/.exec(rest);
  if (!match) return;
  const list = (key: string) =>
    new RegExp(`${key}\\s*:\\s*\\[([^\\]]*)\\]`)
      .exec(match[1])?.[1]
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  const name = /^\s*"([^"]*)"/.exec(match[1])?.[1] ?? /name\s*:\s*"([^"]*)"/.exec(match[1])?.[1];
  return { name, fields: list('fields'), references: list('references') };
}

// model name -> [{ name, type, list, relation }]
function parseModels(text: string): Map<string, ModelField[]> {
  const models = new Map<string, ModelField[]>();
  for (const match of text.matchAll(/^\s*model\s+(\w+)\s*\{([\s\S]*?)^\s*\}/gm)) {
    const fields: ModelField[] = [];
    for (const line of match[2].split('\n')) {
      const field = /^\s*(\w+)\s+(\w+)(\[\])?\??(.*)$/.exec(line.replace(/\/\/.*$/, ''));
      if (field)
        fields.push({ name: field[1], type: field[2], list: Boolean(field[3]), relation: relationAttribute(field[4]) });
    }
    models.set(match[1], fields);
  }
  return models;
}

// The child model and its single-column foreign key for a one-to-many relation field of
// `modelName`.
function foreignKeyOf(
  models: ReadonlyMap<string, ModelField[]>,
  modelName: string,
  relationName: string,
): ForeignKey | undefined {
  const listField = models.get(modelName)?.find((field) => field.name === relationName);
  if (!listField?.list) return;
  const backFields = (models.get(listField.type) ?? []).filter(
    (field) => field.type === modelName && !field.list && field.relation?.fields?.length === 1,
  );
  const matching = backFields.filter((field) => field.relation?.name === listField.relation?.name);
  const relation = matching[0]?.relation;
  if (matching.length !== 1 || !relation?.fields || relation.references?.length !== 1) return;
  return {
    model: listField.type,
    foreignKey: relation.fields[0],
    reference: relation.references[0],
  };
}

function accessorOf(modelName: string): string {
  return modelName[0].toLowerCase() + modelName.slice(1);
}

// `rel: true` counts every row; `rel: { where }` counts matching rows; anything else is not
// understood.
function countFilter(property: ObjectLiteralElementLike): { where: string | undefined } | undefined {
  const value = propertyValue(property);
  if (value?.kind === ts.SyntaxKind.TrueKeyword) return { where: undefined };
  if (!value || !ts.isObjectLiteralExpression(value) || value.properties.length !== 1) return;
  const where = optionProperty(value, 'where');
  return where && ts.isPropertyAssignment(where) ? { where: textOf(where.initializer) } : undefined;
}

// Removes `property` and its separator, taking whole lines when it sits on lines of its own.
function removeProperty(property: Node, text: string): TextEdit {
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

// Prisma only accepts its own promises in `$transaction([...])`, and `.then()` returns a plain one.
// Returns the array element holding the call, or undefined outside a batch.
function batchTransactionElement(call: CallExpression): BatchElement | undefined {
  let expression: Expression = call;
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

// `const [rows, total] = await client.$transaction([findMany, count])` as the binding of the page
// rows and its statement, so the counts can be merged in below the statement instead of inside the
// batch.
function batchRowsBinding({ expression, array, outer }: BatchElement): BatchRows | undefined {
  const awaited = outer.parent;
  const declaration = awaited && ts.isAwaitExpression(awaited) ? awaited.parent : undefined;
  if (!declaration || !ts.isVariableDeclaration(declaration) || declaration.initializer !== awaited) return;
  if (declaration.type || !ts.isArrayBindingPattern(declaration.name)) return;
  const list = declaration.parent;
  if (!ts.isVariableDeclarationList(list)) return;
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

/** The paged `findMany` call that carries a `_count`, with its model and the client it runs on. */
interface PagedCall {
  modelName: string;
  call: CallExpression;
  client: string;
}

/** The `_count` selection inside the projection of a `findMany` call. */
interface CountProjection {
  projectionKey: string;
  projection: ObjectLiteralExpression;
  countProperty: ObjectLiteralElementLike;
  countedValue: ObjectLiteralExpression;
}

/** The counted relations and the single column of the page rows they are grouped by. */
interface CountedRelations {
  relations: RelationCount[];
  reference: string;
}

/**
 * The edits that stop selecting the counts inside the page, and the note about extra selected
 * fields.
 */
interface CountRemoval {
  edits: TextEdit[];
  added: string;
}

/** Everything that turns the page read and its counts into the final fix. */
interface CountRewriteInput extends ThenClauseInput {
  edits: TextEdit[];
  added: string;
  batchRows: BatchRows | undefined;
}

function pagedCallOf(finding: Finding, node: Node): PagedCall | undefined {
  const modelName = /Paged (\w+)\.findMany/.exec(finding.message)?.[1];
  const call = calleeCall(node);
  if (!modelName || !call || call.arguments.length !== 1) return;
  const delegate = call.expression;
  if (!ts.isPropertyAccessExpression(delegate) || !ts.isPropertyAccessExpression(delegate.expression)) return;
  return { modelName, call, client: textOf(delegate.expression.expression) };
}

// `undefined` when the call sits in a batch that cannot be rewritten; otherwise the rows binding of
// the batch, if the call is in one.
function batchRowsOf(call: CallExpression): { batchRows: BatchRows | undefined } | undefined {
  const batch = batchTransactionElement(call);
  const batchRows = batch && batchRowsBinding(batch);
  if (batch && !batchRows) return;
  return { batchRows };
}

function projectionKeyOf(options: ObjectLiteralExpression): string | undefined {
  return ['select', 'include'].find((key) => {
    const property = optionProperty(options, key);
    const value = property && propertyValue(property);
    return value && ts.isObjectLiteralExpression(value) && optionProperty(value, '_count');
  });
}

// The `select` object of a `_count: { select: { ... } }` property that counts exactly one object.
function countedSelection(countProperty: ObjectLiteralElementLike): ObjectLiteralExpression | undefined {
  const countValue = propertyValue(countProperty);
  const counted =
    countValue && ts.isObjectLiteralExpression(countValue) ? optionProperty(countValue, 'select') : undefined;
  const countedValue = counted && propertyValue(counted);
  if (!countValue || !ts.isObjectLiteralExpression(countValue) || !countedValue) return;
  if (!ts.isObjectLiteralExpression(countedValue) || countValue.properties.length !== 1) return;
  return countedValue;
}

function countProjection(call: CallExpression): CountProjection | undefined {
  const options = ts.skipOuterExpressions(call.arguments[0]);
  if (!ts.isObjectLiteralExpression(options)) return;
  const projectionKey = projectionKeyOf(options);
  if (!projectionKey) return;
  const projectionProperty = optionProperty(options, projectionKey);
  const projection = projectionProperty && propertyValue(projectionProperty);
  if (!projection || !ts.isObjectLiteralExpression(projection)) return;
  const countProperty = optionProperty(projection, '_count');
  if (!countProperty) return;
  const countedValue = countedSelection(countProperty);
  if (!countedValue) return;
  return { projectionKey, projection, countProperty, countedValue };
}

function countedRelations(
  countedValue: ObjectLiteralExpression,
  sourceFile: SourceFile,
  modelName: string,
): CountedRelations | undefined {
  const models = parseModels(schemaText(sourceFile.fileName));
  const relations: RelationCount[] = [];
  for (const property of countedValue.properties) {
    const name = propertyKey(property);
    if (!name) return;
    const filter = countFilter(property);
    if (!filter) return;
    const key = foreignKeyOf(models, modelName, name);
    if (!key) return;
    relations.push({ name, ...key, where: filter.where });
  }
  const reference = relations[0].reference;
  if (relations.some((relation) => relation.reference !== reference)) return;
  return { relations, reference };
}

function countRemoval(
  { projectionKey, projection, countProperty }: CountProjection,
  reference: string,
  sourceFile: SourceFile,
  text: string,
): CountRemoval {
  const edits: TextEdit[] = [removeProperty(countProperty, text)];
  const selectsReference = projectionKey === 'include' || optionProperty(projection, reference);
  if (!selectsReference) {
    const opening = projection.getStart(sourceFile) + 1;
    edits.push({ start: opening, end: opening, text: ` ${reference}: true,` });
  }
  const added = selectsReference ? '' : ` It also selects \`${reference}\`, which the rows did not carry before.`;
  return { edits, added };
}

function countRewrite({
  sourceFile,
  text,
  call,
  client,
  relations,
  reference,
  edits,
  added,
  batchRows,
}: CountRewriteInput): FixResult | undefined {
  if (batchRows) {
    const merged = batchMerge(sourceFile, text, batchRows, { client, relations, reference });
    if (!merged) return;
    return {
      edits: [...edits, ...merged],
      note: `The batch reads the page without counts, and the counts come from one groupBy per relation over the page's ids right after it, outside the batch transaction. Rows keep the \`_count\` shape.${added}`,
    };
  }
  const clause = thenClause({ sourceFile, text, call, client, relations, reference });
  if (clause === undefined) return;
  edits.push({ start: call.end, end: call.end, text: clause });
  return {
    edits,
    note: `The page is read first and the counts come from one groupBy per relation over the page's ids, so they are read in a separate query (inside an interactive transaction keep using its client). Rows keep the \`_count\` shape.${added}`,
  };
}

function relationCountFix({ finding, node, sourceFile, text }: SiteFixInput): FixResult | undefined {
  if (!node || !sourceFile || text === undefined) return;
  const paged = pagedCallOf(finding, node);
  if (!paged) return;
  const { modelName, call, client } = paged;
  const batch = batchRowsOf(call);
  if (!batch) return;
  const projection = countProjection(call);
  if (!projection) return;
  const counted = countedRelations(projection.countedValue, sourceFile, modelName);
  if (!counted) return;
  const { relations, reference } = counted;
  const { edits, added } = countRemoval(projection, reference, sourceFile, text);
  return countRewrite({
    sourceFile,
    text,
    call,
    client,
    relations,
    reference,
    edits,
    added,
    batchRows: batch.batchRows,
  });
}

// The batch binds the page under a fresh name; the lines below the statement count and rebuild the
// original name.
function batchMerge(
  sourceFile: SourceFile,
  text: string,
  { name, statement, keyword }: BatchRows,
  { client, relations, reference }: CountPlan,
): TextEdit[] | undefined {
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

function thenClause({ sourceFile, text, call, client, relations, reference }: ThenClauseInput): string | undefined {
  const rows = freshName(sourceFile, 'pageRows');
  if (!rows) return;
  const indentation = indentationAt(text, call.end);
  const body = countLines(sourceFile, client, relations, reference, rows);
  body.push(`return ${body.pop()}`);
  const lines = [`.then(async (${rows}) => {`, ...body.map((line) => `  ${line}`), '})'];
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  return lines.map((line, index) => (index ? indentation + line : line)).join(eol);
}

// Statements that count each relation over the ids of `rows`; the last line is the merged rows
// expression.
function countLines(
  sourceFile: SourceFile,
  client: string,
  relations: RelationCount[],
  reference: string,
  rows: string,
): string[] {
  const fresh = (base: string) => freshName(sourceFile, base);
  const ids = fresh('pageIds');
  const groupCall = (relation: RelationCount) => {
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

export default {
  'prisma-distinct-in-memory': requireReview(
    'groupBy orders and nulls rows differently from findMany distinct, so the returned order and rows can change.',
    distinctFix,
  ),
  'prisma-relation-count-in-list': requireReview(
    'Counts are read in separate queries, outside any batch transaction, so they can disagree with the page.',
    relationCountFix,
  ),
};
