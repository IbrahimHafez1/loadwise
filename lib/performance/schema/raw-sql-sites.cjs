'use strict';

const { syntax: ts } = require('../compiler.cjs');
const { noteOnce } = require('../../shared/coverage-notes.cjs');
const { createTable } = require('./model.cjs');
const { currentSnapshot } = require('./context.cjs');
const { loadPrismaSchema } = require('./prisma-schema.cjs');
const { projectRootOf, projectDialect } = require('./project-indexes.cjs');
const { declaredInPackage, resolvedSymbol, stringValue } = require('./ts-helpers.cjs');

// Raw SQL sites: a literal Postgres statement passed to a driver or ORM escape hatch. Coverage rules need a table
// model, which only a Prisma schema or a snapshot provides; without one the site is marked `modelless`.

const rawMethods = {
  query: ['pg', '@types/pg', 'typeorm', 'sequelize', '@sequelize/core', 'sequelize-typescript'],
  $queryRawUnsafe: undefined,
  $executeRawUnsafe: undefined,
};
const comparisons = { '=': 'eq', '<': 'range', '>': 'range', '<=': 'range', '>=': 'range' };
const expressionFunctions = new Set(['lower', 'upper', 'date', 'coalesce', 'trim']);

function rawDialect(access, packages, root, checker) {
  if (!packages) return loadPrismaSchema(root)?.dialect;
  if (!declaredInPackage(access, checker, packages)) return;
  return declaredInPackage(access, checker, ['pg', '@types/pg']) ? 'postgres' : projectDialect(root);
}

// A Prisma client belongs to the project whose schema generated it, which may not be the calling file's.
function rootFile(access, checker) {
  const isPrisma = !rawMethods[access.name.text];
  const declaration = isPrisma ? resolvedSymbol(access, checker)?.declarations?.[0] : undefined;
  return (declaration ?? access).getSourceFile().fileName;
}

function parse(text) {
  let statements;
  try {
    statements = require('../sql/pg-parser.cjs').parseStatements(text);
  } catch (error) {
    // The parser loads asynchronously; a scan that did not load it has no raw SQL coverage.
    noteOnce('sql-parser', `Note: the SQL parser is not available (${error.message}); skipped the raw SQL checks.`);
    return;
  }
  if (statements.length !== 1 || statements[0].error) return;
  return statements[0].node;
}

// The statement's one table and the parts the rules read; joins, set operations and subqueries are skipped.
function statementParts(node) {
  if (node?.SelectStmt) {
    const select = node.SelectStmt;
    if (select.op !== 'SETOP_NONE' || select.fromClause?.length !== 1) return;
    const relation = select.fromClause[0].RangeVar;
    if (!relation) return;
    return { relation, where: select.whereClause, sort: select.sortClause, limited: Boolean(select.limitCount) };
  }
  const modify = node?.UpdateStmt ?? node?.DeleteStmt;
  if (modify && !modify.fromClause?.length && !modify.usingClause?.length) {
    return { relation: modify.relation, where: modify.whereClause, limited: false };
  }
}

function snapshotTable(relation) {
  const snapshot = currentSnapshot();
  const qualified = `${relation.schemaname ?? 'public'}.${relation.relname}`;
  if (!snapshot || (!snapshot.tables[qualified] && !snapshot.tables[relation.relname])) return;
  const table = createTable({ name: relation.relname, dialect: snapshot.dialect });
  table.orm = 'sql';
  return table;
}

function resolveTable(relation, root) {
  const schema = loadPrismaSchema(root);
  const model = [...(schema?.models.values() ?? [])].find((candidate) => candidate.dbName === relation.relname);
  if (model && !relation.schemaname) return { table: model, byDbName: dbNameIndex(model) };
  const fromSnapshot = snapshotTable(relation);
  if (fromSnapshot) return { table: fromSnapshot };
  const table = createTable({ name: relation.relname, dialect: 'postgres' });
  table.orm = 'sql';
  table.modelless = true;
  return { table };
}

const dbNameIndexes = new WeakMap();

function dbNameIndex(table) {
  if (!dbNameIndexes.has(table)) {
    dbNameIndexes.set(table, new Map([...table.columns.values()].map((column) => [column.dbName, column.name])));
  }
  return dbNameIndexes.get(table);
}

function columnOf(reference, context) {
  const fields = reference?.ColumnRef?.fields;
  if (!fields || fields.some((field) => !field.String)) return;
  const names = fields.map((field) => field.String.sval);
  if (names.length === 2 && !context.qualifiers.has(names[0])) return;
  if (names.length > 2) return;
  const dbName = names.at(-1);
  if (!context.byDbName) return dbName;
  return context.byDbName.get(dbName);
}

function isValue(node) {
  if (node?.TypeCast) return isValue(node.TypeCast.arg);
  return Boolean(node?.A_Const || node?.ParamRef);
}

// `lower(email)` or `created_at::date` around a plain column.
function expressionOf(node, context) {
  const call = node?.FuncCall;
  if (call) {
    const name = call.funcname.at(-1)?.String?.sval?.toLowerCase();
    if (!expressionFunctions.has(name) || call.args?.length !== 1) return;
    const column = columnOf(call.args[0], context);
    return column && { column, expression: `${name}(${call.args[0].ColumnRef.fields.at(-1).String.sval})` };
  }
  const cast = node?.TypeCast;
  if (cast?.arg?.ColumnRef) {
    const column = columnOf(cast.arg, context);
    const type = cast.typeName.names.at(-1)?.String?.sval;
    return column && type && { column, expression: `${cast.arg.ColumnRef.fields.at(-1).String.sval}::${type}` };
  }
}

// The leftmost literal of a `'%' || $1 || '%'` chain, or the literal itself.
function patternStart(node) {
  if (node?.A_Const) return node.A_Const.sval?.sval;
  const concatenation = node?.A_Expr;
  if (concatenation?.kind === 'AEXPR_OP' && concatenation.name[0]?.String?.sval === '||') {
    return patternStart(concatenation.lexpr);
  }
}

function addCondition(site, context, condition) {
  site.conditions.push({ table: context.table, node: site.node, ...condition });
}

function readPattern(site, context, expression) {
  const column = columnOf(expression.lexpr, context);
  const start = patternStart(expression.rexpr);
  const negated = expression.name[0]?.String?.sval?.startsWith('!');
  if (!column || start === undefined || negated) {
    site.uncertain = true;
    return;
  }
  const insensitive = expression.kind === 'AEXPR_ILIKE';
  const kind = start.startsWith('%') ? 'pattern' : 'other';
  addCondition(site, context, { column, kind, operator: insensitive ? 'ILIKE' : 'LIKE', insensitive });
}

function readComparison(site, context, expression) {
  const operator = expression.name[0]?.String?.sval;
  const kind = comparisons[operator];
  const [subject, value] = isValue(expression.lexpr)
    ? [expression.rexpr, expression.lexpr]
    : [expression.lexpr, expression.rexpr];
  if (!isValue(value)) {
    site.uncertain = true;
    return;
  }
  const column = columnOf(subject, context);
  if (column) {
    addCondition(site, context, { column, kind: kind ?? 'other' });
    return;
  }
  const wrapped = kind && expressionOf(subject, context);
  if (wrapped) addCondition(site, context, { ...wrapped, kind: 'expression' });
  else site.uncertain = true;
}

function readConjunct(site, context, node) {
  if (node?.BoolExpr?.boolop === 'AND_EXPR') {
    for (const argument of node.BoolExpr.args) readConjunct(site, context, argument);
    return;
  }
  const expression = node?.A_Expr;
  const nullTest = node?.NullTest;
  if (nullTest) {
    const column = columnOf(nullTest.arg, context);
    if (column) addCondition(site, context, { column, kind: nullTest.nulltesttype === 'IS_NULL' ? 'null' : 'other' });
    else site.uncertain = true;
  } else if (expression?.kind === 'AEXPR_LIKE' || expression?.kind === 'AEXPR_ILIKE') {
    readPattern(site, context, expression);
  } else if (expression?.kind === 'AEXPR_IN' && expression.name[0]?.String?.sval === '=') {
    const column = columnOf(expression.lexpr, context);
    if (column) addCondition(site, context, { column, kind: 'in' });
    else site.uncertain = true;
  } else if (expression?.kind === 'AEXPR_OP') {
    readComparison(site, context, expression);
  } else {
    site.uncertain = true;
  }
}

function readOrder(site, context, sort) {
  const order = [];
  for (const item of sort) {
    const column = columnOf(item.SortBy?.node, context);
    if (!column) return null;
    order.push({ table: context.table, column, node: site.node });
  }
  return order;
}

function rawSqlSite(call, checker) {
  const access = call.expression;
  if (!ts.isPropertyAccessExpression(access) || !Object.hasOwn(rawMethods, access.name.text)) return;
  const text = stringValue(call.arguments[0]);
  if (!text || !/^\s*(?:select|update|delete)\b/i.test(text)) return;
  const root = projectRootOf(rootFile(access, checker));
  if (rawDialect(access, rawMethods[access.name.text], root, checker) !== 'postgres') return;
  const parts = statementParts(parse(text));
  if (!parts) return;
  const { table, byDbName } = resolveTable(parts.relation, root);
  table.root ??= root;
  const qualifiers = new Set([parts.relation.relname, parts.relation.alias?.aliasname].filter(Boolean));
  const context = { table, byDbName, qualifiers };
  const site = {
    orm: table.orm,
    node: call.arguments[0],
    conditions: [],
    order: undefined,
    limited: parts.limited,
    uncertain: false,
  };
  if (parts.where) readConjunct(site, context, parts.where);
  if (parts.sort) site.order = readOrder(site, context, parts.sort);
  return site;
}

module.exports = { rawSqlSite };
