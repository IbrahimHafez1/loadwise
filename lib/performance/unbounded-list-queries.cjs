'use strict';

// A list query with no row limit whose rows are returned from a request handler: the response grows with the table.
const { syntax: ts } = require('./compiler.cjs');
const { prismaModelName } = require('./prisma.cjs');
const { querySite } = require('./schema/query-sites.cjs');
const { declaredInPackage, propertyName, objectProperty } = require('./schema/ts-helpers.cjs');
const { drizzleColumn } = require('./schema/drizzle-schema.cjs');
const { enclosingRequestHandler, reachesResponse } = require('./request-handlers.cjs');

const RULE_ID = 'unbounded-list-query';
const PG_PACKAGES = ['pg', '@types/pg', 'pg-pool', '@types/pg-pool'];
const PG_RECEIVERS = ['Pool', 'Client', 'ClientBase', 'PoolClient'];
const TYPEORM_LIST_METHODS = new Set(['find', 'findBy']);
const BUILDER_LIMITS = new Set(['take', 'limit']);
const DRIZZLE_SELECTS = new Set(['select', 'selectDistinct']);
const DRIZZLE_CHAIN_STEPS = new Set([
  'where',
  'orderBy',
  'leftJoin',
  'rightJoin',
  'innerJoin',
  'fullJoin',
  '$dynamic',
  'for',
  'groupBy',
  'having',
  'limit',
  'offset',
]);
const AGGREGATES = new Set(['count', 'sum', 'avg', 'min', 'max', 'countDistinct']);
const SQL_LIMIT = /\blimit\b|\bfetch\s+first\b/i;
const SQL_AGGREGATE = /\b(?:count|sum|avg|min|max)\s*\(|\bgroup\s+by\b|\bdistinct\s+on\b/i;
const SQL_PINNED_ROW = /\bwhere\s+(?:\w+\.)?id\s*=\s*(?:\$\d+|\?)/i;
const BUILDER_PINNED_ROW = /(?:^|\.)id\s*=\s*:/i;

function unwrap(node) {
  return node && ts.skipOuterExpressions(node);
}

function isUniqueColumn(table, name) {
  if (!table) return name === 'id';
  return table.indexes.some((index) => index.unique && index.keys.length === 1 && index.keys[0].column === name);
}

// A fixed-size literal list or a single value; an `in` over a variable can hold any number of ids.
function isBoundedValue(value) {
  const node = unwrap(value);
  if (ts.isArrayLiteralExpression(node)) return true;
  if (ts.isObjectLiteralExpression(node)) {
    return node.properties.some((property) => {
      const name = ts.isPropertyAssignment(property) && propertyName(property);
      return name === 'equals' || (name === 'in' && ts.isArrayLiteralExpression(unwrap(property.initializer)));
    });
  }
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
    const [argument] = node.arguments;
    if (node.expression.text === 'In') return !!argument && ts.isArrayLiteralExpression(unwrap(argument));
  }
  return true;
}

function pinsUniqueRow(where, table) {
  const filter = unwrap(where);
  if (!filter || !ts.isObjectLiteralExpression(filter)) return false;
  return filter.properties.some((property) => {
    if (ts.isShorthandPropertyAssignment(property)) return isUniqueColumn(table, property.name.text);
    if (!ts.isPropertyAssignment(property)) return false;
    const name = propertyName(property);
    return !!name && isUniqueColumn(table, name) && isBoundedValue(property.initializer);
  });
}

// Whether an options argument carries no limit; a spread or a variable could hold one, so those are not judged.
function lacksLimit(options, limitName) {
  if (!options) return true;
  const literal = unwrap(options);
  if (!ts.isObjectLiteralExpression(literal) || literal.properties.some(ts.isSpreadAssignment)) return false;
  return !literal.properties.some((property) => propertyName(property) === limitName);
}

function prismaList(call, access, context) {
  if (access.name.text !== 'findMany' || !prismaModelName(access.name, context.checker)) return;
  const [options] = call.arguments;
  if (!lacksLimit(options, 'take')) return;
  const table = querySite(call, context.checker)?.table;
  if (pinsUniqueRow(objectProperty(unwrap(options), 'where'), table)) return;
  return { label: 'findMany()', top: call, reportNode: access.name };
}

function typeormFind(call, access, context) {
  if (!TYPEORM_LIST_METHODS.has(access.name.text) || !declaredInPackage(access, context.checker, ['typeorm'])) return;
  const [first] = call.arguments;
  const site = querySite(call, context.checker);
  if (!site) return;
  if (access.name.text === 'findBy') {
    if (pinsUniqueRow(first, site.table)) return;
  } else {
    if (!lacksLimit(first, 'take')) return;
    if (pinsUniqueRow(objectProperty(unwrap(first), 'where'), site.table)) return;
  }
  return { label: `${access.name.text}()`, top: call, reportNode: access.name };
}

function chainSteps(expression) {
  const methods = new Set();
  const strings = [];
  let current = unwrap(expression);
  while (ts.isCallExpression(current) && ts.isPropertyAccessExpression(current.expression)) {
    methods.add(current.expression.name.text);
    for (const argument of current.arguments) {
      if (ts.isStringLiteralLike(argument)) strings.push(argument.text);
    }
    current = unwrap(current.expression.expression);
  }
  return { methods, strings, root: current };
}

function declarationsNamed(scope, name) {
  const declared = [];
  (function visit(node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) declared.push(node);
    ts.forEachChild(node, visit);
  })(scope);
  return declared;
}

// Builder steps made on a local after its declaration, such as `qb.take(limit)` under an `if`.
function stepsOnLocal(name, scope) {
  const steps = [];
  (function visit(node) {
    if (ts.isCallExpression(node)) {
      const chain = chainSteps(node);
      if (ts.isIdentifier(chain.root) && chain.root.text === name) steps.push(chain);
    }
    ts.forEachChild(node, visit);
  })(scope);
  return steps;
}

// The steps of a builder chain, following one local variable; undefined when the builder comes from elsewhere.
function builderSteps(expression, call) {
  const chain = chainSteps(expression);
  const steps = [chain];
  if (!chain.methods.has('createQueryBuilder') && ts.isIdentifier(chain.root)) {
    const scope = ts.findAncestor(call, ts.isFunctionLike)?.body;
    const declared = scope && declarationsNamed(scope, chain.root.text);
    if (!declared || declared.length !== 1 || !declared[0].initializer) return;
    steps.push(chainSteps(declared[0].initializer), ...stepsOnLocal(chain.root.text, scope));
  }
  const methods = new Set(steps.flatMap((step) => [...step.methods]));
  if (methods.has('createQueryBuilder')) return { methods, strings: steps.flatMap((step) => step.strings) };
}

function typeormBuilder(call, access, context) {
  if (access.name.text !== 'getMany' || !declaredInPackage(access, context.checker, ['typeorm'])) return;
  const builder = builderSteps(access.expression, call);
  if (!builder || [...builder.methods].some((method) => BUILDER_LIMITS.has(method))) return;
  if (builder.strings.some((text) => BUILDER_PINNED_ROW.test(text))) return;
  return { label: 'getMany()', top: call, reportNode: access.name };
}

function isAggregateSelect(selectCall) {
  let aggregate = false;
  (function visit(node) {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && AGGREGATES.has(node.expression.text)) {
      aggregate = true;
    }
    ts.forEachChild(node, visit);
  })(selectCall);
  return aggregate;
}

function drizzlePinsUniqueRow(whereCall, checker) {
  const condition = whereCall && unwrap(whereCall.arguments[0]);
  if (!condition || !ts.isCallExpression(condition) || !ts.isIdentifier(condition.expression)) return false;
  if (condition.expression.text !== 'eq' || !condition.arguments[0]) return false;
  const reference = drizzleColumn(condition.arguments[0], checker);
  return reference ? isUniqueColumn(reference.table, reference.column) : false;
}

function drizzleList(call, access, context) {
  if (access.name.text !== 'from') return;
  const select = unwrap(access.expression);
  if (!ts.isCallExpression(select) || !ts.isPropertyAccessExpression(select.expression)) return;
  if (!DRIZZLE_SELECTS.has(select.expression.name.text)) return;
  if (!declaredInPackage(select.expression, context.checker, ['drizzle-orm']) || isAggregateSelect(select)) return;
  let top = call;
  const steps = new Map();
  while (
    ts.isPropertyAccessExpression(top.parent) &&
    top.parent.expression === top &&
    ts.isCallExpression(top.parent.parent) &&
    DRIZZLE_CHAIN_STEPS.has(top.parent.name.text)
  ) {
    steps.set(top.parent.name.text, top.parent.parent);
    top = top.parent.parent;
  }
  if (steps.has('limit') || steps.has('groupBy')) return;
  if (drizzlePinsUniqueRow(steps.get('where'), context.checker)) return;
  return { label: 'select().from()', top, reportNode: access.name };
}

function pgList(call, access, context) {
  if (access.name.text !== 'query' || !context.isPackageType(access.expression, PG_PACKAGES, PG_RECEIVERS)) return;
  const text = call.arguments[0] && unwrap(call.arguments[0]);
  if (!text || !ts.isStringLiteralLike(text) || !/^\s*select\b/i.test(text.text)) return;
  if (SQL_LIMIT.test(text.text) || SQL_AGGREGATE.test(text.text) || SQL_PINNED_ROW.test(text.text)) return;
  return { label: 'SELECT without LIMIT', top: call, reportNode: access.name };
}

const recognisers = [prismaList, typeormFind, typeormBuilder, drizzleList, pgList];

function check(call, context) {
  const access = call.expression;
  if (!ts.isPropertyAccessExpression(access)) return;
  const handler = enclosingRequestHandler(call);
  if (!handler) return;
  for (const recognise of recognisers) {
    const list = recognise(call, access, context);
    if (!list) continue;
    if (!reachesResponse(list.top, handler)) return;
    context.report(
      list.reportNode,
      RULE_ID,
      `${list.label} has no row limit and its rows are returned from a request handler, so the response, memory use and query time grow with the table. Add paging (\`take\`/\`limit\` with a stable order, or a cursor) and cap the page size. Ignore if the table is small by construction.`,
    );
    return;
  }
}

module.exports = { check };
