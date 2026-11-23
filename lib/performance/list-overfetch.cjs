'use strict';

// A list query with no projection that drags large columns or deeply nested relations along with every row.
const { syntax: ts } = require('./compiler.cjs');
const { prismaModelName } = require('./prisma.cjs');
const { querySite } = require('./schema/query-sites.cjs');
const { declaredInPackage, objectProperty } = require('./schema/ts-helpers.cjs');
const { awaitedResult } = require('./query-results.cjs');
const { returnedRowMap, wideTypes } = require('./typeorm-projection.cjs');

const RULE_ID = 'list-query-overfetch';
const MIN_NESTED_RELATIONS = 2;
// A small page of wide rows is cheap enough that the projection advice is not worth the noise.
const SMALL_PAGE_ROWS = 100;
const PRISMA_WIDE_TYPES = new Set(['Json', 'Bytes']);
const PRISMA_WIDE_NATIVE_TYPES = new Set(['Text', 'MediumText', 'LongText', 'Xml']);
const UNFOLLOWED_ROWS_REASON =
  'The rows are returned or passed on whole, so whether the large columns are used downstream could not be shown.';
const ROW_CALLBACK_METHODS = new Set(['map', 'filter', 'forEach', 'some', 'every', 'find', 'flatMap']);
const NO_SCHEMA_REASON = 'No schema was found for this model, so the loaded columns could not be checked.';

function unwrap(node) {
  return node && ts.skipOuterExpressions(node);
}

function objectArgument(call) {
  const options = unwrap(call.arguments[0]);
  return options && ts.isObjectLiteralExpression(options) ? options : undefined;
}

function isSmallPage(options) {
  const take = objectProperty(options, 'take');
  return !!take && ts.isNumericLiteral(take) && Number(take.text) <= SMALL_PAGE_ROWS;
}

function wideColumns(table, isWide) {
  return [...table.columns.values()].filter(isWide);
}

function columnLabel(column) {
  return `${column.name} (${column.nativeType ?? column.type})`;
}

function isWidePrismaColumn(column) {
  return (
    PRISMA_WIDE_TYPES.has(column.type.replace('[]', '')) ||
    (column.type === 'String' && PRISMA_WIDE_NATIVE_TYPES.has(column.nativeType))
  );
}

function isWideTypeormColumn(column) {
  return !column.array && wideTypes.has(column.type.toLowerCase());
}

// `include` inside `include`: how many relation levels one query loads.
function prismaIncludeDepth(options) {
  const include = objectProperty(options, 'include');
  if (!include || !ts.isObjectLiteralExpression(include)) return 0;
  const nested = include.properties.map((property) => {
    const value = ts.isPropertyAssignment(property) && unwrap(property.initializer);
    return value && ts.isObjectLiteralExpression(value) ? prismaIncludeDepth(value) : 0;
  });
  return 1 + Math.max(0, ...nested);
}

function relationObjectDepth(relations) {
  const nested = relations.properties.map((property) => {
    const value = ts.isPropertyAssignment(property) && unwrap(property.initializer);
    return value && ts.isObjectLiteralExpression(value) ? relationObjectDepth(value) : 0;
  });
  return 1 + Math.max(0, ...nested);
}

// 'a.b' in the array form and `{ a: { b: true } }` in the object form both load two levels.
function typeormRelationDepth(options) {
  const relations = objectProperty(options, 'relations');
  if (!relations) return 0;
  if (ts.isObjectLiteralExpression(relations)) return relationObjectDepth(relations);
  if (!ts.isArrayLiteralExpression(relations)) return 0;
  const depths = relations.elements.map((element) =>
    ts.isStringLiteralLike(element) ? element.text.split('.').length : 0,
  );
  return Math.max(0, ...depths);
}

function bodyUsesOnlyFields(name, body, fields) {
  if (ts.isObjectBindingPattern(name)) {
    for (const element of name.elements) {
      const field = element.propertyName ?? element.name;
      if (element.dotDotDotToken || !ts.isIdentifier(field)) return false;
      fields.add(field.text);
    }
    return true;
  }
  if (!ts.isIdentifier(name)) return false;
  return identifierUses(body, name.text, name).every((use) => {
    const access = use.parent;
    if (!ts.isPropertyAccessExpression(access) || access.expression !== use) return false;
    fields.add(access.name.text);
    return true;
  });
}

function identifierUses(root, name, declaration) {
  const uses = [];
  (function visit(node) {
    if (ts.isIdentifier(node) && node.text === name && node !== declaration) uses.push(node);
    ts.forEachChild(node, visit);
  })(root);
  return uses;
}

// How one use of the result list touches its rows: only counts and per-row field reads can be followed.
function followRowUse(use, fields) {
  const parent = use.parent;
  if (ts.isForOfStatement(parent) && parent.expression === use) {
    const [declaration] = ts.isVariableDeclarationList(parent.initializer) ? parent.initializer.declarations : [];
    return !!declaration && bodyUsesOnlyFields(declaration.name, parent.statement, fields);
  }
  if (!ts.isPropertyAccessExpression(parent) || parent.expression !== use) return false;
  if (parent.name.text === 'length') return true;
  const call = parent.parent;
  const callback = ts.isCallExpression(call) && call.expression === parent ? unwrap(call.arguments[0]) : undefined;
  if (!callback || !ROW_CALLBACK_METHODS.has(parent.name.text) || !ts.isFunctionLike(callback)) return false;
  const [row] = callback.parameters;
  return !row || bodyUsesOnlyFields(row.name, callback.body, fields);
}

// The row fields read from the awaited result, or undefined when the rows are used in a way that cannot be followed.
function fieldsRead(call) {
  const awaited = awaitedResult(call);
  const declaration = awaited && ts.isParenthesizedExpression(awaited.parent) ? undefined : awaited?.parent;
  if (!declaration || !ts.isVariableDeclaration(declaration) || !ts.isIdentifier(declaration.name)) return;
  const scope = ts.findAncestor(call, ts.isFunctionLike)?.body;
  if (!scope) return;
  const fields = new Set();
  const followed = identifierUses(scope, declaration.name.text, declaration.name).every((use) =>
    followRowUse(use, fields),
  );
  return followed ? fields : undefined;
}

// Large columns the code provably never reads, and whether the rows were followed far enough to say so.
function unreadWide(call, wide) {
  const read = fieldsRead(call);
  return read ? { columns: wide.filter((column) => !read.has(column.name)), followed: true } : { columns: wide };
}

function describe(wide, depth, relationNoun) {
  const parts = [];
  if (wide.length) parts.push(`loads large columns for every row (${wide.map(columnLabel).join(', ')})`);
  if (depth >= MIN_NESTED_RELATIONS) parts.push(`${relationNoun} ${depth} relation levels deep`);
  return parts.join(' and ');
}

function report(context, node, label, problem, contextualReason) {
  context.report(
    node,
    RULE_ID,
    `${label} has no projection and ${problem}. Select only the fields the list needs (\`select\`, or \`omit\` for the large ones) and load details when one row is opened. Ignore if every field is shown.`,
    contextualReason,
  );
}

function checkPrisma(call, access, context) {
  if (access.name.text !== 'findMany' || !prismaModelName(access.name, context.checker)) return;
  const options = objectArgument(call);
  if (!options || objectProperty(options, 'select') || objectProperty(options, 'omit')) return;
  const table = querySite(call, context.checker)?.table;
  const found = table && !isSmallPage(options) ? wideColumns(table, isWidePrismaColumn) : [];
  const { columns: wide, followed } = unreadWide(call, found);
  const depth = prismaIncludeDepth(options);
  if (!wide.length && depth < MIN_NESTED_RELATIONS) return;
  const onlyUnfollowedColumns = !followed && depth < MIN_NESTED_RELATIONS;
  const reason = table ? (onlyUnfollowedColumns ? UNFOLLOWED_ROWS_REASON : undefined) : NO_SCHEMA_REASON;
  report(context, access.name, 'findMany()', describe(wide, depth, 'includes'), reason);
}

function checkTypeorm(call, access, context) {
  if (access.name.text !== 'find' || !declaredInPackage(access, context.checker, ['typeorm'])) return;
  const options = objectArgument(call);
  if (!options || objectProperty(options, 'select')) return;
  const awaited = awaitedResult(call);
  if (awaited && returnedRowMap(awaited)) return;
  const table = querySite(call, context.checker)?.table;
  if (!table) return;
  const found = isSmallPage(options) ? [] : wideColumns(table, isWideTypeormColumn);
  const { columns: wide, followed } = unreadWide(call, found);
  const depth = typeormRelationDepth(options);
  if (!wide.length && depth < MIN_NESTED_RELATIONS) return;
  const onlyUnfollowedColumns = !followed && depth < MIN_NESTED_RELATIONS;
  report(
    context,
    access.name,
    'find()',
    describe(wide, depth, 'loads'),
    onlyUnfollowedColumns ? UNFOLLOWED_ROWS_REASON : undefined,
  );
}

function check(call, context) {
  const access = call.expression;
  if (!ts.isPropertyAccessExpression(access)) return;
  checkPrisma(call, access, context);
  checkTypeorm(call, access, context);
}

module.exports = { check };
