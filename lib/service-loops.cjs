'use strict';

const path = require('node:path');
const { syntax: ts, isDefaultLibrary } = require('./compiler.cjs');
const { findRepeatOwner, isStandardArrayCall, outerExpression } = require('./repeated.cjs');
const { shouldReportLoopQuery } = require('./query-loops.cjs');
const { isSequentialByDesign } = require('./sequential-loops.cjs');
const { isGeneratedPrismaFile } = require('./prisma.cjs');
const { packageOf, relativeFile, resolvedSymbol } = require('./schema/ts-helpers.cjs');

const RULE_ID = 'service-query-in-loop';
// The message names a few operations; the rest are summarized by the count.
const MAX_LISTED_OPERATIONS = 4;
const MAX_LABEL_LENGTH = 60;
// Wrappers up to this many statements are followed into the project functions they call.
const MAX_WRAPPER_STATEMENTS = 5;
const MAX_CONSTANT_DEPTH = 6;
const objectReaders = new Set(['keys', 'values', 'entries']);
const arrayNarrowers = new Set(['filter', 'slice', 'map']);
const testSource = /[.-]i?(?:spec|test)\.[cm]?[jt]sx?$|(?:^|\/)(?:__tests__|tests?)\//i;
const seedSource = /(?:^|\/)(?:seeds?|seeders?|rich-data|demo-data|sample-data)\/|[.-]seed\.[cm]?[jt]sx?$/i;
const benchmarkSource = /(?:^|[/.-])bench(?:mark)?[.-][^/]*$|\/(?:bench|benchmarks)\//i;
const toolingSource = /(?:^|\/)(?:scripts?|migrations?)\//i;

const prismaOperations = new Set([
  'findUnique',
  'findUniqueOrThrow',
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'count',
  'aggregate',
  'groupBy',
  'create',
  'createMany',
  'createManyAndReturn',
  'update',
  'updateMany',
  'updateManyAndReturn',
  'upsert',
  'delete',
  'deleteMany',
  '$queryRaw',
  '$queryRawUnsafe',
  '$executeRaw',
  '$executeRawUnsafe',
]);
// Repository.create and merge build entities in memory and are deliberately absent.
const typeormOperations = new Set([
  'find',
  'findBy',
  'findByIds',
  'findOne',
  'findOneBy',
  'findOneById',
  'findOneOrFail',
  'findOneByOrFail',
  'findAndCount',
  'findAndCountBy',
  'count',
  'countBy',
  'exist',
  'exists',
  'existsBy',
  'sum',
  'average',
  'minimum',
  'maximum',
  'save',
  'insert',
  'update',
  'upsert',
  'delete',
  'softDelete',
  'restore',
  'remove',
  'softRemove',
  'increment',
  'decrement',
  'query',
  'getOne',
  'getOneOrFail',
  'getMany',
  'getManyAndCount',
  'getRawOne',
  'getRawMany',
  'getCount',
  'getExists',
  'execute',
]);
const sequelizeOperations = new Set([
  'findAll',
  'findOne',
  'findByPk',
  'findAndCountAll',
  'findOrCreate',
  'count',
  'min',
  'max',
  'sum',
  'create',
  'bulkCreate',
  'update',
  'destroy',
  'upsert',
  'increment',
  'decrement',
  'save',
  'reload',
  'query',
]);
const mongooseOperations = new Set([
  'find',
  'findOne',
  'findById',
  'exists',
  'countDocuments',
  'estimatedDocumentCount',
  'distinct',
  'create',
  'insertMany',
  'updateOne',
  'updateMany',
  'replaceOne',
  'deleteOne',
  'deleteMany',
  'findOneAndUpdate',
  'findByIdAndUpdate',
  'findOneAndDelete',
  'findByIdAndDelete',
  'aggregate',
  'bulkWrite',
  'save',
]);
// Only the call that starts a Drizzle statement is counted, so one chained statement is one operation.
const drizzleOperations = new Set([
  'select',
  'selectDistinct',
  'selectDistinctOn',
  'insert',
  'update',
  'delete',
  'execute',
  'findFirst',
  'findMany',
]);
const redisOperations = new Set([
  'get',
  'set',
  'setex',
  'getdel',
  'getex',
  'mget',
  'mset',
  'hget',
  'hset',
  'hmget',
  'hgetall',
  'hdel',
  'hincrby',
  'del',
  'unlink',
  'exists',
  'incr',
  'incrby',
  'decr',
  'expire',
  'pexpire',
  'ttl',
  'sadd',
  'srem',
  'smembers',
  'sismember',
  'zadd',
  'zrem',
  'zrange',
  'zscore',
  'lpush',
  'rpush',
  'lpop',
  'rpop',
  'lrange',
  'eval',
  'evalsha',
]);
const queueOperations = new Set(['add', 'remove', 'getJob']);
const transactionMethods = new Set(['transaction', '$transaction']);
const literalFlags =
  ts.TypeFlags.StringLiteral | ts.TypeFlags.NumberLiteral | ts.TypeFlags.BooleanLiteral | ts.TypeFlags.EnumLiteral;

const packageOperations = [
  { family: 'typeorm', packages: ['typeorm'], operations: typeormOperations },
  { family: 'pg', packages: ['pg', '@types/pg', 'pg-pool', '@types/pg-pool'], operations: new Set(['query']) },
  { family: 'drizzle', packages: ['drizzle-orm'], operations: drizzleOperations },
  { family: 'sequelize', packages: ['sequelize', '@sequelize/core'], operations: sequelizeOperations },
  { family: 'mongoose', packages: ['mongoose'], operations: mongooseOperations },
  { family: 'redis', packages: ['ioredis', 'redis', '@redis/client'], operations: redisOperations },
  { family: 'queue', packages: ['bullmq'], operations: queueOperations },
];

// Per callee declaration: { operations, callees, transaction }, computed once per program.
const bodySummaries = new WeakMap();

function signatureDeclaration(call, checker) {
  const declaration = checker.getResolvedSignature(call)?.declaration;
  if (declaration) return declaration;
  const name = ts.isPropertyAccessExpression(call.expression) ? call.expression.name : call.expression;
  return checker.getSymbolAtLocation(name)?.declarations?.[0];
}

function isProjectFunction(declaration) {
  if (!declaration || !ts.isFunctionLike(declaration) || !declaration.body) return false;
  const file = declaration.getSourceFile();
  return !file.isDeclarationFile && !file.fileName.replaceAll('\\', '/').includes('/node_modules/');
}

function methodName(call) {
  const callee = call.expression;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
}

// The client family of a database or cache call, or undefined for anything else.
function operationFamily(method, declaration) {
  const owningPackage = packageOf(declaration);
  if (
    owningPackage === '@prisma/client' ||
    owningPackage === '.prisma' ||
    isGeneratedPrismaFile(declaration.getSourceFile())
  )
    return prismaOperations.has(method) ? 'prisma' : undefined;
  const entry = owningPackage && packageOperations.find(({ packages }) => packages.includes(owningPackage));
  if (!entry) return;
  // Redis clients expose each command in both lower and camel case.
  const command = entry.family === 'redis' ? method.toLowerCase() : method;
  if (entry.operations.has(command)) return entry.family;
}

function receiverLabel(receiver) {
  let current = ts.skipOuterExpressions(receiver);
  // Walk a builder chain back to the object it started from.
  while (ts.isCallExpression(current) && ts.isPropertyAccessExpression(current.expression))
    current = ts.skipOuterExpressions(current.expression.expression);
  if (ts.isIdentifier(current)) return current.text;
  if (ts.isPropertyAccessExpression(current)) return current.name.text;
  return 'db';
}

// Callbacks passed to a call run as part of it; functions only returned or stored run later, if ever.
function runsWithBody(node) {
  if (!ts.isArrowFunction(node) && !ts.isFunctionExpression(node)) return false;
  let expression = node;
  while (ts.isParenthesizedExpression(expression.parent)) expression = expression.parent;
  return ts.isCallExpression(expression.parent) && expression.parent.arguments.includes(expression);
}

function summarize(declaration, checker) {
  const cached = bodySummaries.get(declaration);
  if (cached) return cached;
  const summary = { operations: [], callees: [], transaction: false };
  bodySummaries.set(declaration, summary);
  const file = declaration.getSourceFile();
  // Inner steps of a chain that already ends in a counted operation, such as update() before execute().
  const chained = new Set();
  (function visit(node) {
    if (ts.isFunctionLike(node) && node !== declaration && !runsWithBody(node)) return;
    // Work in a catch block runs on failures only, not once per item.
    if (ts.isClassLike(node) || ts.isCatchClause(node)) return;
    if (ts.isCallExpression(node)) {
      const method = methodName(node);
      const target = method && signatureDeclaration(node, checker);
      if (target && transactionMethods.has(method) && !isProjectFunction(target)) summary.transaction = true;
      if (target && isProjectFunction(target)) summary.callees.push(target);
      else if (target && !chained.has(node) && operationFamily(method, target)) {
        for (let step = node.expression.expression; ts.isCallExpression(step);) {
          chained.add(step);
          if (!ts.isPropertyAccessExpression(step.expression)) break;
          step = step.expression.expression;
        }
        const { line, character } = file.getLineAndCharacterOfPosition(node.expression.name.getStart(file));
        summary.operations.push({
          family: operationFamily(method, target),
          label: `${receiverLabel(node.expression.expression)}.${method}`,
          file: file.fileName,
          line: line + 1,
          column: character + 1,
        });
      } else if (!method && ts.isIdentifier(node.expression)) {
        const local = signatureDeclaration(node, checker);
        if (isProjectFunction(local)) summary.callees.push(local);
      }
    }
    ts.forEachChild(node, visit);
  })(declaration.body);
  return summary;
}

// The callee's own operations, plus those of the project functions a short wrapper calls (two levels).
// In a longer function a nested call is usually incidental bookkeeping, such as an audit row.
function calleeOperations(callee, checker) {
  const summary = summarize(callee, checker);
  if (summary.transaction) return [];
  const operations = [...summary.operations];
  const statements = ts.isBlock(callee.body) ? callee.body.statements.length : 1;
  if (statements <= MAX_WRAPPER_STATEMENTS) {
    for (const nested of new Set(summary.callees)) {
      if (nested !== callee) operations.push(...summarize(nested, checker).operations);
    }
  }
  // One entry per distinct operation keeps branches that run the same query from inflating the count.
  const seen = new Set();
  return operations.filter((operation) => !seen.has(operation.label) && seen.add(operation.label));
}

function contains(outer, inner) {
  return outer.getSourceFile() === inner.getSourceFile() && outer.pos <= inner.pos && inner.end <= outer.end;
}

function passesCollection(call, checker) {
  return call.arguments.some((argument) => {
    const symbol = checker.getTypeAtLocation(argument).getSymbol();
    return (
      (symbol?.name === 'Array' || symbol?.name === 'ReadonlyArray') &&
      symbol.declarations?.some((declaration) => isDefaultLibrary(checker, declaration.getSourceFile()))
    );
  });
}

function lengthBoundCollection(loop) {
  const condition = loop.condition && ts.skipOuterExpressions(loop.condition);
  if (
    condition &&
    ts.isBinaryExpression(condition) &&
    (condition.operatorToken.kind === ts.SyntaxKind.LessThanToken ||
      condition.operatorToken.kind === ts.SyntaxKind.LessThanEqualsToken) &&
    ts.isPropertyAccessExpression(condition.right) &&
    condition.right.name.text === 'length'
  )
    return condition.right.expression;
}

// The collection a per-item loop walks; undefined for retry, polling and queue-draining loops.
function iteratedCollection(owner) {
  if (ts.isForOfStatement(owner)) return owner.expression;
  if (ts.isForStatement(owner)) return lengthBoundCollection(owner);
  if (!ts.isFunctionLike(owner)) return;
  const call = outerExpression(owner).parent;
  if (ts.isCallExpression(call) && ts.isPropertyAccessExpression(call.expression)) return call.expression.expression;
}

function constantInitializer(expression, checker) {
  const value = ts.skipOuterExpressions(expression);
  if (!ts.isIdentifier(value)) return;
  const declaration = resolvedSymbol(value, checker)?.valueDeclaration;
  if (declaration && ts.isEnumDeclaration(declaration)) return declaration;
  if (
    declaration &&
    ts.isVariableDeclaration(declaration) &&
    declaration.parent.flags & ts.NodeFlags.Const &&
    declaration.initializer
  )
    return ts.skipOuterExpressions(declaration.initializer);
}

function isConstantTable(expression, checker, depth) {
  const table = constantInitializer(expression, checker);
  if (table && ts.isEnumDeclaration(table)) return true;
  return (
    !!table &&
    ts.isObjectLiteralExpression(table) &&
    table.properties.length > 0 &&
    table.properties.every(
      (property) => ts.isPropertyAssignment(property) && isConstantCollection(property.initializer, checker, depth + 1),
    )
  );
}

// Lists written into the source, such as fallback chains or enum values, have a size fixed by the code.
function isConstantCollection(expression, checker, depth = 0) {
  if (!expression || depth > MAX_CONSTANT_DEPTH) return false;
  const value = ts.skipOuterExpressions(expression);
  const follow = (child) => isConstantCollection(child, checker, depth + 1);
  if (ts.isArrayLiteralExpression(value)) return value.elements.length > 0 && !value.elements.some(ts.isSpreadElement);
  if (ts.isConditionalExpression(value)) return follow(value.whenTrue) && follow(value.whenFalse);
  if (ts.isIdentifier(value)) return follow(constantInitializer(value, checker));
  if (ts.isElementAccessExpression(value) || ts.isPropertyAccessExpression(value))
    return isConstantTable(value.expression, checker, depth);
  if (!ts.isCallExpression(value)) return false;
  if (!ts.isPropertyAccessExpression(value.expression)) return returnsConstantCollection(value, checker, depth);
  const method = value.expression.name.text;
  const receiver = ts.skipOuterExpressions(value.expression.expression);
  if (ts.isIdentifier(receiver) && receiver.text === 'Object' && objectReaders.has(method))
    return value.arguments.length === 1 && isConstantObject(value.arguments[0], checker);
  return arrayNarrowers.has(method) && isStandardArrayCall(value, checker) && follow(receiver);
}

function isConstantObject(expression, checker) {
  const table = constantInitializer(expression, checker);
  return (
    !!table &&
    (ts.isEnumDeclaration(table) ||
      (ts.isObjectLiteralExpression(table) && !table.properties.some(ts.isSpreadAssignment)))
  );
}

// A project helper such as `selectSources()` that only returns a filtered constant list.
function returnsConstantCollection(call, checker, depth) {
  const declaration = signatureDeclaration(call, checker);
  if (!isProjectFunction(declaration) || !ts.isBlock(declaration.body)) return false;
  const results = [];
  (function visit(node) {
    if (ts.isFunctionLike(node)) return;
    if (ts.isReturnStatement(node)) results.push(node.expression);
    ts.forEachChild(node, visit);
  })(declaration.body);
  return results.length > 0 && results.every((result) => isConstantCollection(result, checker, depth + 1));
}

function elementBinding(owner) {
  if (ts.isForOfStatement(owner) && ts.isVariableDeclarationList(owner.initializer))
    return owner.initializer.declarations[0]?.name;
  if (ts.isFunctionLike(owner)) return owner.parameters[0]?.name;
}

// Items drawn from a literal union (an enum or a list of known names) are a fixed, small domain.
function hasLiteralDomain(owner, checker) {
  const binding = elementBinding(owner);
  if (!binding || !ts.isIdentifier(binding)) return false;
  const type = checker.getTypeAtLocation(binding);
  const members = type.isUnion() ? type.types : [type];
  return members.every((member) => member.flags & literalFlags);
}

function calleeLabel(call) {
  const text = call.expression.getText().replace(/\s+/g, '');
  const name = ts.isPropertyAccessExpression(call.expression) ? call.expression.name.text : text;
  return text.length <= MAX_LABEL_LENGTH ? text : name;
}

const batchReads = {
  prisma: 'one `{ in: ids }` read',
  typeorm: 'one `In(ids)` read',
  sequelize: 'one `[Op.in]: ids` read',
  mongoose: 'one `$in` read',
  drizzle: 'one `inArray()` read',
  pg: 'one `= ANY($1)` read',
};
const cacheFamilies = new Set(['redis', 'queue']);

function batchAdvice(families) {
  const read = [...families].map((family) => batchReads[family]).find(Boolean);
  const parts = [];
  if (read) parts.push(read, 'one bulk write');
  if (families.has('redis')) parts.push('one Redis pipeline or multi-key command');
  if (families.has('queue')) parts.push('one `addBulk()`');
  if (!parts.length) parts.push('one set-based read', 'one bulk write');
  return parts.join(', ');
}

function operationNoun(families, count) {
  const plural = count === 1 ? '' : 's';
  if ([...families].every((family) => cacheFamilies.has(family))) return `Redis command${plural}`;
  if ([...families].some((family) => cacheFamilies.has(family))) return `database and Redis call${plural}`;
  return `database call${plural}`;
}

function describe(operations) {
  const groups = new Map();
  for (const operation of operations.slice(0, MAX_LISTED_OPERATIONS)) {
    const group = groups.get(operation.file) ?? [];
    group.push(operation);
    groups.set(operation.file, group);
  }
  const parts = [...groups].map(([file, group]) => {
    group.sort((left, right) => left.line - right.line);
    return `${group.map((operation) => operation.label).join(', ')} in ${path.basename(file)}:${group[0].line}`;
  });
  const unlisted = operations.length - MAX_LISTED_OPERATIONS;
  return parts.join('; ') + (unlisted > 0 ? ` and ${unlisted} more` : '');
}

function insideCatch(node, owner) {
  for (let current = node.parent; current && current !== owner; current = current.parent)
    if (ts.isCatchClause(current)) return true;
  return false;
}

// Matches the review context other per-item query rules give to code outside request paths.
function sourceContext(file) {
  const relative = relativeFile(file);
  const where = testSource.test(relative)
    ? 'a test source'
    : seedSource.test(relative)
      ? 'seed or demo-data setup'
      : benchmarkSource.test(relative)
        ? 'a benchmark'
        : toolingSource.test(relative)
          ? 'operator tooling (scripts or migrations)'
          : undefined;
  return (
    where &&
    `A per-item query in ${where} rather than a request path. Review only if the data set can grow large or setup time matters.`
  );
}

function shouldSkipLoop(node, owner, checker) {
  const collection = iteratedCollection(owner);
  return (
    !collection ||
    insideCatch(node, owner) ||
    isConstantCollection(collection, checker) ||
    hasLiteralDomain(owner, checker) ||
    isSequentialByDesign(node, owner) ||
    !shouldReportLoopQuery(node, checker, { owner })
  );
}

function check(node, context) {
  const { checker } = context;
  const callee = node.expression;
  if (!ts.isPropertyAccessExpression(callee) && !ts.isIdentifier(callee)) return;
  const owner = findRepeatOwner(node, checker);
  if (!owner) return;
  const declaration = signatureDeclaration(node, checker);
  if (!isProjectFunction(declaration) || contains(declaration, node)) return;
  if (shouldSkipLoop(node, owner, checker) || passesCollection(node, checker)) return;
  const operations = calleeOperations(declaration, checker);
  if (!operations.length) return;
  const label = calleeLabel(node);
  const count = operations.length;
  const families = new Set(operations.map((operation) => operation.family));
  // Operations on separate branches are listed together, so the count is an upper bound.
  const amount = count === 1 ? 'a' : `up to ${count}`;
  context.report(
    ts.isPropertyAccessExpression(callee) ? callee.name : callee,
    RULE_ID,
    `\`${label}()\` makes ${amount} ${operationNoun(families, count)} per item (${describe(operations)}), so the loop pays ${amount} round ${count === 1 ? 'trip' : 'trips'} for every item and the cost grows with the list. Add a batch variant that takes all ids (${batchAdvice(families)}) and call it once outside the loop. Keep per-item validation, error isolation and transaction needs.`,
    sourceContext(node.getSourceFile().fileName),
    {
      related: operations.slice(0, MAX_LISTED_OPERATIONS).map((operation) => ({
        file: relativeFile(operation.file),
        line: operation.line,
        column: operation.column,
        message: `\`${operation.label}\` runs here once per item of the loop that calls \`${label}()\`.`,
      })),
    },
  );
}

module.exports = { check };
