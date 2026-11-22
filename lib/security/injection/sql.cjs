'use strict';

// The SQL-text rules share one detector. The text argument is assembled here (a template, a `+` concatenation, or a
// local variable built from them) and some runtime part is neither a constant fragment (`analyzeFragment`), a
// number-like value, nor an identifier validated against an allowlist or closed regex; or the whole argument is
// request data. A part traced to the request makes the finding default. Assembled text with no traced part is
// contextual: it is usually an internal identifier or a placeholder list, and only a reader can tell.
const { syntax: ts } = require('../../performance/compiler.cjs');
const { analyzeFragment } = require('../../performance/pg-fragments.cjs');
const { operandsOf, isValidatedIdentifier } = require('../pg-identifier-guards.cjs');
const { isPrunedType } = require('../taint/sanitizers.cjs');
const { assignmentsTo } = require('../taint/guards.cjs');
const { sourceSuffix, reportTraced, methodName, calledExport, createdBy } = require('./shared.cjs');

const untracedReason =
  'No request value was traced into this SQL text; confirm every runtime part is a fixed or allowlisted fragment.';
const maxVariableDepth = 4;

const prismaUnsafeMethods = new Set(['$queryRawUnsafe', '$executeRawUnsafe']);
const typeormBuilderMethods = new Set([
  'where',
  'andWhere',
  'orWhere',
  'having',
  'andHaving',
  'orHaving',
  'orderBy',
  'addOrderBy',
  'groupBy',
  'addGroupBy',
  'select',
  'addSelect',
]);
// Join methods take the joined relation first and the join condition third.
const typeormJoinMethods = new Set([
  'leftJoin',
  'leftJoinAndSelect',
  'innerJoin',
  'innerJoinAndSelect',
  'leftJoinAndMapOne',
  'leftJoinAndMapMany',
  'innerJoinAndMapOne',
  'innerJoinAndMapMany',
]);
const knexRawMethods = new Set(['whereRaw', 'havingRaw', 'orderByRaw', 'groupByRaw', 'joinRaw', 'fromRaw']);
const sequelizeModules = new Set(['sequelize', 'sequelize-typescript']);

const messages = {
  'prisma-raw-unsafe-dynamic': (suffix) =>
    `This raw Prisma query builds SQL text from a runtime value${suffix}, which allows SQL injection. Use the tagged form \`$queryRaw\`...\${value}\`\` so values are bound, and choose identifiers from a fixed allowlist.`,
  'typeorm-dynamic-query-text': (suffix) =>
    `This TypeORM query builds SQL text from a runtime value${suffix}. Write \`:name\` in the text and pass \`{ name: value }\`; pick column names and sort directions from a fixed allowlist.`,
  'knex-raw-dynamic-text': (suffix) =>
    `This Knex raw fragment builds SQL text from a runtime value${suffix}. Use \`?\` for values and \`??\` for identifiers with a bindings array.`,
  'mysql-dynamic-query-text': (suffix) =>
    `This MySQL query builds SQL text from a runtime value${suffix}. Use \`?\` placeholders with a values array; choose identifiers from a fixed allowlist.`,
  'sequelize-dynamic-query-text': (suffix) =>
    `This Sequelize query builds SQL text from a runtime value${suffix}. Use \`replacements\` or \`bind\` instead of interpolation.`,
  'drizzle-sql-raw-dynamic': (suffix) =>
    `\`sql.raw\` inserts this runtime value${suffix} into the query unescaped. Use the \`sql\` template tag for values and \`sql.identifier()\` with an allowlist for names.`,
};

function isAssembled(node) {
  return (
    ts.isTemplateExpression(node) ||
    (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken)
  );
}

function isFixedPart(part, call, checker) {
  if (analyzeFragment(part, checker) !== undefined || isPrunedType(part, checker)) return true;
  return ts.isIdentifier(part) && isValidatedIdentifier(part, call, checker);
}

// Every value a local variable can hold: its initializer and, for `let` and `var`, each `=` and `+=` in its scope.
function localValues(identifier, checker) {
  const declaration = checker.getSymbolAtLocation(identifier)?.valueDeclaration;
  if (!declaration || !ts.isVariableDeclaration(declaration) || !ts.isIdentifier(declaration.name)) return;
  const values = declaration.initializer ? [declaration.initializer] : [];
  if (declaration.parent.flags & ts.NodeFlags.Const) return values;
  const scope = ts.findAncestor(declaration, (node) => ts.isFunctionLike(node) || ts.isSourceFile(node));
  for (const assignment of assignmentsTo(declaration, scope, checker)) values.push(assignment.right);
  return values;
}

// The runtime parts of SQL text that are not provably fixed, or undefined when the text is not assembled here.
function unresolvedParts(node, call, checker, depth = 0) {
  const text = ts.skipOuterExpressions(node);
  if (isAssembled(text))
    return operandsOf(text).flatMap((part) =>
      isFixedPart(part, call, checker) ? [] : (unresolvedParts(part, call, checker, depth + 1) ?? [part]),
    );
  if (!ts.isIdentifier(text) || depth >= maxVariableDepth) return;
  const values = localValues(text, checker);
  if (!values?.some((value) => isAssembled(ts.skipOuterExpressions(value)))) return;
  if (isFixedPart(text, call, checker)) return [];
  return values.flatMap((value) =>
    isFixedPart(value, call, checker) ? [] : (unresolvedParts(value, call, checker, depth + 1) ?? [value]),
  );
}

// { trace } when the SQL text argument is dynamic (trace undefined when no part reaches the request), else undefined.
function dynamicText(argument, call, context) {
  const parts = unresolvedParts(argument, call, context.checker);
  if (parts === undefined) {
    const trace = context.taint.trace(argument, 'sql');
    return trace && { trace };
  }
  if (!parts.length) return;
  for (const part of parts) {
    const trace = context.taint.trace(part, 'sql');
    if (trace) return { trace };
  }
  return { trace: undefined };
}

function checkText(argument, call, ruleId, context) {
  if (!argument || ts.isSpreadElement(argument)) return;
  const dynamic = dynamicText(argument, call, context);
  if (!dynamic) return;
  const { trace } = dynamic;
  reportTraced(
    context,
    argument,
    ruleId,
    messages[ruleId](sourceSuffix(trace)),
    trace,
    trace ? undefined : untracedReason,
  );
}

function receiverOf(call) {
  return ts.skipOuterExpressions(call.expression).expression;
}

function prismaText(call, method) {
  if (prismaUnsafeMethods.has(method)) return call.arguments[0];
  const receiver = ts.skipOuterExpressions(receiverOf(call));
  if (method === 'raw' && ts.isIdentifier(receiver) && receiver.text === 'Prisma') return call.arguments[0];
}

// The builder comes from `createQueryBuilder(...)` in the same chain, or through a local `const qb = ...`.
function isQueryBuilderChain(expression, checker, depth = 0) {
  let node = ts.skipOuterExpressions(expression);
  while (node && (ts.isCallExpression(node) || ts.isPropertyAccessExpression(node))) {
    if (ts.isCallExpression(node) && methodName(node) === 'createQueryBuilder') return true;
    node = ts.skipOuterExpressions(node.expression);
  }
  if (!node || !ts.isIdentifier(node) || depth >= maxVariableDepth) return false;
  const declaration = checker.getSymbolAtLocation(node)?.valueDeclaration;
  return (
    !!declaration &&
    ts.isVariableDeclaration(declaration) &&
    !!declaration.initializer &&
    isQueryBuilderChain(declaration.initializer, checker, depth + 1)
  );
}

function typeormTexts(call, method, library, context) {
  if (method === 'query' && library?.module === 'typeorm') return [call.arguments[0]];
  const isBuilder = typeormBuilderMethods.has(method);
  if (!isBuilder && !typeormJoinMethods.has(method)) return [];
  const fromBuilder =
    (library?.module === 'typeorm' && (library.exported ?? '').endsWith('QueryBuilder')) ||
    isQueryBuilderChain(receiverOf(call), context.checker);
  if (!fromBuilder) return [];
  if (!isBuilder) return [call.arguments[0], call.arguments[2]];
  const [first] = call.arguments;
  return first && ts.isArrayLiteralExpression(ts.skipOuterExpressions(first))
    ? [...ts.skipOuterExpressions(first).elements]
    : [first];
}

function isKnexFactory(created, context) {
  return ts.isCallExpression(created) && context.libraryCall(created)?.module === 'knex';
}

function knexText(call, method, library, context) {
  if (knexRawMethods.has(method)) return call.arguments[0];
  if (method !== 'raw') return;
  const receiver = receiverOf(call);
  if (library?.module === 'knex' || createdBy(receiver, (created) => isKnexFactory(created, context), context.checker))
    return call.arguments[0];
}

function isMysqlModule(module) {
  return module === 'mysql' || module === 'mysql2' || module?.startsWith('mysql2/');
}

function mysqlText(call, method, library, context) {
  if (method !== 'query' && method !== 'execute') return;
  const recognised =
    isMysqlModule(library?.module) ||
    createdBy(
      receiverOf(call),
      (created) => ts.isCallExpression(created) && isMysqlModule(context.libraryCall(created)?.module),
      context.checker,
    );
  return recognised ? call.arguments[0] : undefined;
}

// `sequelize.query(...)`: the receiver is named `sequelize`, is typed or imported from Sequelize, or was created
// with `new Sequelize(...)`.
function isSequelizeInstance(receiver, library, context) {
  if (sequelizeModules.has(library?.module)) return true;
  const node = ts.skipOuterExpressions(receiver);
  const name = ts.isIdentifier(node) ? node.text : ts.isPropertyAccessExpression(node) ? node.name.text : undefined;
  if (name === 'sequelize') return true;
  return createdBy(
    node,
    (created) => ts.isNewExpression(created) && sequelizeModules.has(context.libraryCall(created)?.module),
    context.checker,
  );
}

function sequelizeText(call, method, library, context) {
  if (method === 'query' && isSequelizeInstance(receiverOf(call), library, context)) return call.arguments[0];
  if (calledExport(library) === 'literal' && sequelizeModules.has(library.module)) return call.arguments[0];
  const receiver = method === 'literal' && ts.skipOuterExpressions(receiverOf(call));
  if (receiver && ts.isIdentifier(receiver) && /^[sS]equelize$/.test(receiver.text)) return call.arguments[0];
}

function drizzleText(call, method, library) {
  if (method === 'raw' && library?.exported === 'sql' && library.module?.startsWith('drizzle-orm'))
    return call.arguments[0];
}

function check(call, context) {
  const method = methodName(call);
  const library = context.libraryCall(call);
  const prisma = method && prismaText(call, method);
  if (prisma) return checkText(prisma, call, 'prisma-raw-unsafe-dynamic', context);
  if (!method && calledExport(library) === 'literal' && sequelizeModules.has(library.module))
    return checkText(call.arguments[0], call, 'sequelize-dynamic-query-text', context);
  if (!method) return;
  const drizzle = drizzleText(call, method, library);
  if (drizzle) return checkText(drizzle, call, 'drizzle-sql-raw-dynamic', context);
  const knex = knexText(call, method, library, context);
  if (knex) return checkText(knex, call, 'knex-raw-dynamic-text', context);
  const typeorm = typeormTexts(call, method, library, context);
  if (typeorm.length) {
    for (const text of typeorm) checkText(text, call, 'typeorm-dynamic-query-text', context);
    return;
  }
  const mysql = mysqlText(call, method, library, context);
  if (mysql) return checkText(mysql, call, 'mysql-dynamic-query-text', context);
  const sequelize = sequelizeText(call, method, library, context);
  if (sequelize) checkText(sequelize, call, 'sequelize-dynamic-query-text', context);
}

module.exports = { check };
