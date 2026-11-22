'use strict';

// orm-deep-offset: a list query whose offset comes from request input with no upper bound, or a huge literal offset.
// The database reads and discards every skipped row, so the last pages of a big table cost the most.
const { syntax: ts } = require('./compiler.cjs');
const { prismaModelName } = require('./prisma.cjs');
const { declaredInPackage, propertyName } = require('./schema/ts-helpers.cjs');
const { enclosingRequestHandler, isRequestHandler } = require('./request-handlers.cjs');
const { traceInputs, boundOf, requestInputOf } = require('./request-inputs.cjs');

const RULE_ID = 'orm-deep-offset';
// Past this many skipped rows a page is already slow on a large table.
const MAX_LITERAL_OFFSET = 10000;
const PG_PACKAGES = ['pg', '@types/pg', 'pg-pool', '@types/pg-pool'];
const PG_RECEIVERS = ['Pool', 'Client', 'ClientBase', 'PoolClient'];
const SQL_OFFSET_PARAMETER = /\boffset\s+\$(\d+)/i;

const OPTION_SITES = [
  {
    methods: new Set(['findMany', 'findFirst', 'findFirstOrThrow']),
    option: 'skip',
    isOrm: (access, context) => !!prismaModelName(access.name, context.checker),
  },
  {
    methods: new Set(['find', 'findAndCount']),
    option: 'skip',
    isOrm: (access, context) => declaredInPackage(access, context.checker, ['typeorm']),
  },
  {
    methods: new Set(['findAll', 'findAndCountAll']),
    option: 'offset',
    isOrm: (access, context) => declaredInPackage(access, context.checker, ['sequelize', 'sequelize-typescript']),
  },
];
const CHAIN_SITES = [
  { method: 'skip', packages: ['mongoose', 'typeorm'] },
  { method: 'offset', packages: ['typeorm', 'drizzle-orm', 'knex'] },
];

function optionValue(options, name) {
  const literal = options && ts.skipOuterExpressions(options);
  if (!literal || !ts.isObjectLiteralExpression(literal)) return;
  for (const property of literal.properties) {
    if (propertyName(property) !== name) continue;
    if (ts.isShorthandPropertyAssignment(property)) return property.name;
    if (ts.isPropertyAssignment(property)) return property.initializer;
  }
}

function pgOffsetValue(call, context) {
  const [text, values] = call.arguments;
  const sql = text && ts.skipOuterExpressions(text);
  if (
    !sql ||
    !ts.isStringLiteralLike(sql) ||
    !context.isPackageType(call.expression.expression, PG_PACKAGES, PG_RECEIVERS)
  )
    return;
  const parameter = SQL_OFFSET_PARAMETER.exec(sql.text);
  const list = values && ts.skipOuterExpressions(values);
  if (parameter && list && ts.isArrayLiteralExpression(list)) return list.elements[Number(parameter[1]) - 1];
}

// The expression holding the offset of an ORM list call, or undefined when the call does not page by offset.
function offsetValue(call, context) {
  const access = call.expression;
  if (!ts.isPropertyAccessExpression(access)) return;
  const method = access.name.text;
  if (method === 'query') return pgOffsetValue(call, context);
  const chainSite = CHAIN_SITES.find((site) => site.method === method);
  if (chainSite && declaredInPackage(access, context.checker, chainSite.packages)) return call.arguments[0];
  const optionSite = OPTION_SITES.find((site) => site.methods.has(method));
  if (optionSite?.isOrm(access, context)) return optionValue(call.arguments[0], optionSite.option);
}

function calleeText(call) {
  return ts.skipOuterExpressions(call.expression).getText();
}

function statusesOf(sources, scope, context) {
  return sources.map((source) => boundOf(source, scope, context));
}

const SKIPPED_ROWS =
  'the database reads and discards every skipped row, so deep pages get slower the bigger the table grows. Cap the page or offset (`Math.min`, a `max` on the schema field) or page with a keyset cursor (`where id > lastId order by id limit n`, or Prisma `cursor`). Ignore if the table is small by construction.';

function inputMessage(label) {
  return `${label} comes from request input with no upper bound, so ${SKIPPED_ROWS}`;
}

function literalMessage(label, offset) {
  return `${label} is ${offset}, above ${MAX_LITERAL_OFFSET}, so ${SKIPPED_ROWS}`;
}

function offsetLabel(call) {
  return `The offset of ${call.expression.name.text}()`;
}

function literalOffset(value) {
  const literal = ts.skipOuterExpressions(value);
  return ts.isNumericLiteral(literal) ? Number(literal.text) : undefined;
}

function checkHandlerOffset(call, value, handler, context) {
  const sources = traceInputs(value, handler, requestInputOf(handler));
  const statuses = statusesOf(sources, handler, context);
  if (statuses.includes('unbounded'))
    return context.report(call.expression.name, RULE_ID, inputMessage(offsetLabel(call)));
  if (!statuses.includes('unknown')) return;
  const reason = 'The request value is validated by a schema whose limit on this field could not be read.';
  context.report(call.expression.name, RULE_ID, inputMessage(offsetLabel(call)), reason);
}

function isProjectFunction(declaration) {
  if (!declaration || !ts.isFunctionLike(declaration) || !declaration.body) return false;
  const file = declaration.getSourceFile();
  return !file.isDeclarationFile && !file.fileName.includes('node_modules') && !isRequestHandler(declaration);
}

function offsetCallsIn(method, context) {
  const found = [];
  (function visit(node) {
    const value = ts.isCallExpression(node) && offsetValue(node, context);
    if (value) found.push({ call: node, value });
    if (!ts.isFunctionLike(node) || node === method) ts.forEachChild(node, visit);
  })(method);
  return found;
}

// One hop: a service method that pages by an offset taken from its parameters, called with request input.
function checkOneHop(call, handler, context) {
  const method = context.checker.getResolvedSignature(call)?.declaration;
  if (!isProjectFunction(method)) return;
  const parameterInput = (parameter) => ({ parameterIndex: method.parameters.indexOf(parameter) });
  for (const site of offsetCallsIn(method, context)) {
    const methodSources = traceInputs(site.value, method, parameterInput);
    const open = methodSources.filter((source) => boundOf(source, method, context) !== 'bounded');
    for (const source of open) {
      const argument = call.arguments[source.parameterIndex];
      if (!argument) continue;
      const requestSources = traceInputs(argument, handler, requestInputOf(handler)).map((input) => ({
        ...input,
        name: source.name,
      }));
      if (!statusesOf(requestSources, handler, context).includes('unbounded')) continue;
      const reason =
        'The offset is applied in a service method this request handler calls, so a limit applied inside it or by the caller could not be ruled out.';
      return context.report(call, RULE_ID, inputMessage(`The offset applied by ${calleeText(call)}()`), reason);
    }
  }
}

function check(call, context) {
  const value = offsetValue(call, context);
  const handler = enclosingRequestHandler(call);
  if (!value) return handler && checkOneHop(call, handler, context);
  const offset = literalOffset(value);
  if (offset !== undefined) {
    if (offset > MAX_LITERAL_OFFSET)
      context.report(call.expression.name, RULE_ID, literalMessage(offsetLabel(call), offset));
    return;
  }
  if (handler) checkHandlerOffset(call, value, handler, context);
}

module.exports = { check };
