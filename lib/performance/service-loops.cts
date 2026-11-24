import path from 'node:path';
import { loadSyntax, isDefaultLibrary } from './compiler.cjs';
import {
  elementBinding,
  findRepeatOwner,
  isStandardArrayCall,
  outerExpression,
  promiseCombinatorOf,
} from './repeated.cjs';
import { isFunctionLikeDeclaration } from './request-handlers.cjs';
import { isBatchCollection, isGrownLater, isMemoised, shouldReportLoopQuery } from './query-loops.cjs';
import { transactionLoopTarget } from './typeorm-transaction-loops.cjs';
import { wrappedQueueAdd } from './queue-loops.cjs';
import {
  isSequentialByDesign,
  passesTransactionClient,
  sortedBeforeLoop,
  stopsOnLostLease,
} from './sequential-loops.cjs';
import { isGeneratedPrismaFile } from './prisma.cjs';
import { packageOf, relativeFile, resolvedSymbol } from './schema/ts-helpers.cjs';
import { declaredTypeormOwner, isTypeormPackage, typeormImportOf } from './orm-queries.cjs';
import type {
  CallExpression,
  EnumDeclaration,
  Expression,
  ForStatement,
  Node,
  PropertyAccessExpression,
  SourceFile,
  TaggedTemplateExpression,
} from 'typescript';
import type { CheckerAdapter, PerformanceRuleContext, ProgramAdapter } from '../shared/types.cjs';
import type { EffectSite, FunctionWithBody } from '../shared/types/function-summaries.cjs';
import type { RepeatOwner } from './types/repeat-owner.cjs';
import type * as FunctionSummaries from '../shared/function-summaries.cjs';
const ts = loadSyntax();

/**
 * A database, cache or queue call: the client family, the label shown to the reader, and where it
 * is.
 */
interface Operation extends EffectSite {
  family: string;
  label: string;
}

/**
 * An operation, with the project functions between the callee and it when it was reached through
 * them.
 */
type LoopOperation = Operation & { via?: readonly string[] };

/** What a function body does by itself: its operations, and the project functions it calls. */
interface BodySummary {
  operations: Operation[];
  callees: FunctionWithBody[];
}

/**
 * The operations a loop's call reaches, and whether every project function that does work was
 * followed.
 */
interface ReachedOperations {
  operations: LoopOperation[];
  complete: boolean;
}

/** A client package family and the methods of it that cost a round trip. */
interface PackageOperations {
  family: string;
  packages: readonly string[];
  operations: ReadonlySet<string>;
  /** Only methods declared on these types count. */
  owners?: ReadonlySet<string>;
}

/** A tagged template that sends a statement when awaited. */
interface TaggedQuery {
  family: string;
  label: string;
  at: Node;
}

const RULE_ID = 'service-query-in-loop';
const DEEP_REASON =
  'The database work is reached through project functions deeper than the callee or the short wrapper it calls, which can be incidental bookkeeping or work that runs only on some paths. Review the listed operations before batching.';
// The message names a few operations; the rest are summarized by the count.
const MAX_LISTED_OPERATIONS = 4;
const MAX_LABEL_LENGTH = 60;
// Wrappers up to this many statements are followed into the project functions they call.
const MAX_WRAPPER_STATEMENTS = 5;
const MAX_CONSTANT_DEPTH = 6;
// `list.slice(0, 2)` keeps a handful of items whatever the list holds.
const MAX_SLICED_ITEMS = 5;
// Output arguments are followed this many calls deep to find where they are appended to.
const MAX_FORWARDING_DEPTH = 3;
const appendingMethods = new Set(['push', 'unshift', 'splice']);
const objectReaders = new Set(['keys', 'values', 'entries']);
const arrayNarrowers = new Set(['filter', 'slice', 'map']);
const listOperators = new Set(['in', '$in']);

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
// Only the call that starts a Drizzle statement is counted, so one chained statement is one
// operation.
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
// EntityManager and EntityRepository calls; persist() only queues a change for the next flush.
const mikroOrmOperations = new Set([
  'find',
  'findOne',
  'findOneOrFail',
  'findAll',
  'findAndCount',
  'findByCursor',
  'count',
  'insert',
  'insertMany',
  'nativeInsert',
  'nativeUpdate',
  'nativeDelete',
  'upsert',
  'upsertMany',
  'flush',
  'persistAndFlush',
  'removeAndFlush',
  'refresh',
  'populate',
]);
// Payload's Local API, each call one or more database round trips.
const payloadOperations = new Set([
  'find',
  'findByID',
  'findGlobal',
  'findVersions',
  'findVersionByID',
  'create',
  'update',
  'updateGlobal',
  'delete',
  'count',
  'duplicate',
]);
const queueOperations = new Set(['add', 'remove', 'getJob']);
const transactionMethods = new Set(['transaction', '$transaction']);
const literalFlags =
  ts.TypeFlags.StringLiteral | ts.TypeFlags.NumberLiteral | ts.TypeFlags.BooleanLiteral | ts.TypeFlags.EnumLiteral;

const packageOperations: readonly PackageOperations[] = [
  { family: 'typeorm', packages: ['typeorm'], operations: typeormOperations },
  { family: 'pg', packages: ['pg', '@types/pg', 'pg-pool', '@types/pg-pool'], operations: new Set(['query']) },
  { family: 'drizzle', packages: ['drizzle-orm'], operations: drizzleOperations },
  { family: 'sequelize', packages: ['sequelize', '@sequelize/core'], operations: sequelizeOperations },
  { family: 'mongoose', packages: ['mongoose'], operations: mongooseOperations },
  {
    family: 'mikro-orm',
    packages: [
      '@mikro-orm/core',
      '@mikro-orm/knex',
      '@mikro-orm/sql',
      '@mikro-orm/postgresql',
      '@mikro-orm/mysql',
      '@mikro-orm/mariadb',
      '@mikro-orm/sqlite',
      '@mikro-orm/libsql',
      '@mikro-orm/mssql',
      '@mikro-orm/mongodb',
    ],
    operations: mikroOrmOperations,
  },
  // The payload package exports much more than the Local API, so only BasePayload's methods count.
  { family: 'payload', packages: ['payload'], operations: payloadOperations, owners: new Set(['BasePayload']) },
  { family: 'redis', packages: ['ioredis', 'redis', '@redis/client'], operations: redisOperations },
  { family: 'queue', packages: ['bullmq', 'bull', '@types/bull'], operations: queueOperations },
];
// Tagged templates of these clients send the statement when awaited; builder tags such as Drizzle's
// `sql` do not.
const executingTagPackages = new Set(['postgres', '@vercel/postgres', '@neondatabase/serverless']);
const prismaRawTags = new Set(['$queryRaw', '$executeRaw']);
// Callbacks handed to these wrappers run only on a cache miss.
const cacheWrapperName =
  /^(?:(?:get|fetch|load|read)Or(?:Set|Fetch|Load|Compute|Cache)|remember|memoi[sz]e|cached|withCache)/i;

// Per callee declaration: { operations, callees }, computed once per program.
const bodySummaries = new WeakMap<FunctionWithBody, BodySummary>();

function signatureDeclaration(call: CallExpression, checker: CheckerAdapter): Node | undefined {
  const declaration = checker.getResolvedSignature(call)?.declaration;
  if (declaration) return declaration;
  const name = ts.isPropertyAccessExpression(call.expression) ? call.expression.name : call.expression;
  return checker.getSymbolAtLocation(name)?.declarations?.[0];
}

function isProjectFunction(declaration: Node | undefined): declaration is FunctionWithBody {
  if (!declaration || !isFunctionLikeDeclaration(declaration) || !declaration.body) return false;
  const file = declaration.getSourceFile();
  return !file.isDeclarationFile && !file.fileName.replaceAll('\\', '/').includes('/node_modules/');
}

function methodName(call: CallExpression): string | undefined {
  const callee = call.expression;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
}

// The client family of a database or cache call, or undefined for anything else.
function operationFamily(method: string, declaration: Node): string | undefined {
  const owningPackage = packageOf(declaration);
  if (
    owningPackage === '@prisma/client' ||
    owningPackage === '.prisma' ||
    isGeneratedPrismaFile(declaration.getSourceFile())
  )
    return prismaOperations.has(method) ? 'prisma' : undefined;
  const entry = owningPackage && familyEntry(owningPackage);
  if (!entry) return;
  const typeName = enclosingTypeName(declaration);
  if (entry.owners && (typeName === undefined || !entry.owners.has(typeName))) return;
  // Redis clients expose each command in both lower and camel case.
  const command = entry.family === 'redis' ? method.toLowerCase() : method;
  if (entry.operations.has(command)) return entry.family;
}

// Forks published under a scope, such as @n8n/typeorm, keep TypeORM's API.
function familyEntry(owningPackage: string): PackageOperations | undefined {
  const name = isTypeormPackage(owningPackage) ? 'typeorm' : owningPackage;
  return packageOperations.find(({ packages }) => packages.includes(name));
}

function enclosingTypeName(declaration: Node): string | undefined {
  let current: Node | undefined = declaration;
  while (current && !ts.isClassLike(current) && !ts.isInterfaceDeclaration(current)) current = current.parent;
  return current?.name?.text;
}

function receiverLabel(receiver: Expression): string {
  let current = ts.skipOuterExpressions(receiver);
  // Walk a builder chain back to the object it started from.
  while (ts.isCallExpression(current) && ts.isPropertyAccessExpression(current.expression))
    current = ts.skipOuterExpressions(current.expression.expression);
  if (ts.isIdentifier(current)) return current.text;
  if (ts.isPropertyAccessExpression(current)) return current.name.text;
  return 'db';
}

// Callbacks passed to a call run as part of it; functions only returned or stored run later, if
// ever. A loader handed to a cache wrapper runs only on a miss.
function runsWithBody(node: Node): boolean {
  if (!ts.isArrowFunction(node) && !ts.isFunctionExpression(node)) return false;
  let expression: Node = node;
  while (ts.isParenthesizedExpression(expression.parent)) expression = expression.parent;
  return (
    ts.isCallExpression(expression.parent) &&
    expression.parent.arguments.some((argument) => argument === expression) &&
    !isCacheWrapper(expression.parent)
  );
}

function isCacheWrapper(call: CallExpression): boolean {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return cacheWrapperName.test(callee.text);
  return (
    ts.isPropertyAccessExpression(callee) &&
    (cacheWrapperName.test(callee.name.text) ||
      // cache-manager style `cache.wrap(key, load)`.
      (callee.name.text === 'wrap' && /cache/i.test(receiverLabel(callee.expression))))
  );
}

function transactionFamily(target: Node): string | undefined {
  const owningPackage = packageOf(target);
  if (
    owningPackage === '@prisma/client' ||
    owningPackage === '.prisma' ||
    isGeneratedPrismaFile(target.getSourceFile())
  )
    return 'prisma';
  return owningPackage ? familyEntry(owningPackage)?.family : undefined;
}

// `tx.$executeRaw` and `sql` tagged templates of an executing client are queries written as
// templates.
function taggedQuery(node: TaggedTemplateExpression, checker: CheckerAdapter): TaggedQuery | undefined {
  const tag = node.tag;
  if (ts.isPropertyAccessExpression(tag) && prismaRawTags.has(tag.name.text)) {
    const declaration = checker.getSymbolAtLocation(tag.name)?.declarations?.[0];
    if (declaration && operationFamily(tag.name.text, declaration) === 'prisma')
      return { family: 'prisma', label: `${receiverLabel(tag.expression)}.${tag.name.text}`, at: tag.name };
    return;
  }
  if (!ts.isIdentifier(tag) && !ts.isPropertyAccessExpression(tag)) return;
  const declarations = checker.getTypeAtLocation(tag).getSymbol()?.declarations ?? [];
  if (declarations.some((declaration) => executingTagPackages.has(packageOf(declaration) ?? '')))
    return { family: 'pg', label: ts.isIdentifier(tag) ? tag.text : tag.name.text, at: tag };
}

function operationAt(file: SourceFile, node: Node, family: string, label: string): Operation {
  const { line, character } = file.getLineAndCharacterOfPosition(node.getStart(file));
  return { family, label, file: file.fileName, line: line + 1, column: character + 1 };
}

function summarize(declaration: FunctionWithBody, checker: CheckerAdapter): BodySummary {
  const cached = bodySummaries.get(declaration);
  if (cached) return cached;
  const summary: BodySummary = { operations: [], callees: [] };
  bodySummaries.set(declaration, summary);
  const file = declaration.getSourceFile();
  // Inner steps of a chain that already ends in a counted operation, such as update() before
  // execute().
  const chained = new Set<Node>();
  (function visit(node: Node): void {
    if (ts.isFunctionLike(node) && node !== declaration && !runsWithBody(node)) return;
    // Work in a catch block runs on failures only, not once per item.
    if (ts.isClassLike(node) || ts.isCatchClause(node)) return;
    if (ts.isTaggedTemplateExpression(node)) {
      const query = taggedQuery(node, checker);
      if (query) summary.operations.push(operationAt(file, query.at, query.family, query.label));
    }
    if (ts.isCallExpression(node)) {
      // A memoised load runs once per distinct key, not once per call.
      if (isMemoised(node, checker)) return;
      const access = ts.isPropertyAccessExpression(node.expression) ? node.expression : undefined;
      if (access) {
        const method = access.name.text;
        const operationLabel = `${receiverLabel(access.expression)}.${method}`;
        const target = signatureDeclaration(node, checker);
        const family =
          target && transactionMethods.has(method) && !isProjectFunction(target) && transactionFamily(target);
        // BEGIN and COMMIT add a round trip around the work inside the callback, which is counted
        // too.
        if (family) summary.operations.push(operationAt(file, access.name, family, operationLabel));
        if (target && isProjectFunction(target)) summary.callees.push(target);
        else if (target) {
          const targetFamily = chained.has(node) ? undefined : operationFamily(method, target);
          if (targetFamily) {
            markInnerQueryCalls(access, chained);
            summary.operations.push(operationAt(file, access.name, targetFamily, operationLabel));
          }
        } else if (
          !chained.has(node) &&
          typeormOperations.has(method) &&
          declaredTypeormOwner(access.expression, checker)
        ) {
          // TypeORM's types are not installed, but the receiver is declared as one of its
          // repositories.
          markInnerQueryCalls(access, chained);
          summary.operations.push(operationAt(file, access.name, 'typeorm', operationLabel));
        }
      } else if (ts.isIdentifier(node.expression)) {
        const local = signatureDeclaration(node, checker);
        if (isProjectFunction(local)) summary.callees.push(local);
      }
    }
    ts.forEachChild(node, visit);
  })(declaration.body);
  return summary;
}

function markInnerQueryCalls(access: PropertyAccessExpression, chained: Set<Node>): void {
  for (let step = access.expression; ts.isCallExpression(step);) {
    chained.add(step);
    if (!ts.isPropertyAccessExpression(step.expression)) break;
    step = step.expression.expression;
  }
}

function doesWork(declaration: FunctionWithBody, checker: CheckerAdapter): boolean {
  const summary = summarize(declaration, checker);
  return summary.operations.length > 0 || summary.callees.length > 0;
}

// The callee's own operations, plus those of the project functions a short wrapper calls (two
// levels). In a longer function a nested call is usually incidental bookkeeping, such as an audit
// row.
// `complete` is false when a project function that was not followed may add more operations.
function calleeOperations(callee: FunctionWithBody, checker: CheckerAdapter): ReachedOperations {
  const summary = summarize(callee, checker);
  const operations: LoopOperation[] = [...summary.operations];
  const statements = ts.isBlock(callee.body) ? callee.body.statements.length : 1;
  const followed = statements <= MAX_WRAPPER_STATEMENTS;
  let complete = true;
  for (const nested of new Set(summary.callees)) {
    if (nested === callee) continue;
    if (!followed) {
      if (doesWork(nested, checker)) complete = false;
      continue;
    }
    const inner = summarize(nested, checker);
    operations.push(...inner.operations);
    if (inner.callees.some((deeper) => deeper !== nested && doesWork(deeper, checker))) complete = false;
  }
  // One entry per distinct operation keeps branches that run the same query from inflating the
  // count.
  const seen = new Set<string>();
  return {
    operations: operations.filter((operation) => !seen.has(operation.label) && seen.add(operation.label)),
    complete,
  };
}

// Database, Redis and queue calls the shared summaries reach from `callee` through project
// functions, to the depth the summaries follow; HTTP calls belong to http-call-without-timeout.
function summarizedOperations(
  call: CallExpression,
  checker: CheckerAdapter,
  program: ProgramAdapter,
): ReachedOperations {
  // Lazy: function-summaries.cjs requires this module for `summarize`.
  const { functionSummaries }: typeof FunctionSummaries = require('../shared/function-summaries.cjs');
  const summary = functionSummaries(program).summaryOfCall(call);
  if (!summary) return { operations: [], complete: true };
  const operations = summary.queries.filter((query) => query.kind !== 'http');
  // One entry per distinct operation keeps branches that run the same query from inflating the
  // count.
  const seen = new Set<string>();
  return {
    operations: operations.filter((operation) => !seen.has(operation.label) && seen.add(operation.label)),
    complete: summary.complete,
  };
}

function contains(outer: Node, inner: Node): boolean {
  return outer.getSourceFile() === inner.getSourceFile() && outer.pos <= inner.pos && inner.end <= outer.end;
}

function isArrayValue(node: Node, checker: CheckerAdapter): boolean {
  const symbol = checker.getTypeAtLocation(node).getSymbol();
  return (
    (symbol?.name === 'Array' || symbol?.name === 'ReadonlyArray') &&
    !!symbol.declarations?.some((declaration) => isDefaultLibrary(checker, declaration.getSourceFile()))
  );
}

// `{ in: ids }`, Mongo's `{ _id: { $in: ids } }` or TypeORM's `{ where: { id: In(ids) } }` hands
// the callee a whole key set; a relation filter such as `{ where: { folder: { id: In(ids) } } }`
// nests one level deeper.
function carriesInList(argument: Expression, checker: CheckerAdapter, depth = 0): boolean {
  const value = ts.skipOuterExpressions(argument);
  if (depth > 2 || !ts.isObjectLiteralExpression(value)) return false;
  return value.properties.some(
    (property) =>
      ts.isPropertyAssignment(property) &&
      ((!ts.isComputedPropertyName(property.name) &&
        listOperators.has(property.name.text) &&
        isArrayValue(property.initializer, checker)) ||
        isTypeormInList(property.initializer, checker) ||
        carriesInList(property.initializer, checker, depth + 1)),
  );
}

function isTypeormInList(expression: Expression, checker: CheckerAdapter): boolean {
  const value = ts.skipOuterExpressions(expression);
  if (!ts.isCallExpression(value) || !ts.isIdentifier(value.expression) || value.arguments.length !== 1) return false;
  return typeormImportOf(value.expression, checker) === 'In' && isArrayValue(value.arguments[0], checker);
}

// A list the callee appends to, such as `warnings` or a lookup cache, is an output rather than a
// key batch.
function appendsTo(declaration: FunctionWithBody, name: string, checker: CheckerAdapter, depth = 0): boolean {
  if (depth > MAX_FORWARDING_DEPTH) return false;
  return !!(function visit(node: Node): true | undefined {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (
        ts.isPropertyAccessExpression(callee) &&
        appendingMethods.has(callee.name.text) &&
        ts.isIdentifier(callee.expression) &&
        callee.expression.text === name
      )
        return true;
      const index = node.arguments.findIndex((argument) => ts.isIdentifier(argument) && argument.text === name);
      const target = index >= 0 ? signatureDeclaration(node, checker) : undefined;
      if (isProjectFunction(target)) {
        const parameter = target.parameters[index];
        if (parameter && ts.isIdentifier(parameter.name) && appendsTo(target, parameter.name.text, checker, depth + 1))
          return true;
      }
    }
    return ts.forEachChild(node, visit);
  })(declaration.body);
}

function isDrizzleBatchFilter(argument: Expression, owner: RepeatOwner, checker: CheckerAdapter): boolean {
  if (!ts.isCallExpression(argument)) return false;
  const symbol = resolvedSymbol(argument.expression, checker);
  if (!symbol?.declarations?.some((item) => packageOf(item) === 'drizzle-orm')) return false;
  if (symbol.name === 'inArray')
    return argument.arguments.length === 2 && isBatchCollection(argument.arguments[1], owner, checker);
  return symbol.name === 'and' && argument.arguments.some((term) => isDrizzleBatchFilter(term, owner, checker));
}

function usesSqlFilter(declaration: FunctionWithBody, checker: CheckerAdapter): boolean {
  const parameter = declaration.parameters[0]?.name;
  if (!parameter || !ts.isIdentifier(parameter)) return false;
  const binding = checker.getSymbolAtLocation(parameter);
  if (!binding) return false;
  function visit(node: Node): boolean | undefined {
    if (ts.isFunctionLike(node)) return false;
    if (ts.isCallExpression(node) && methodName(node) === 'execute' && node.arguments.length === 1) {
      const query = node.arguments[0];
      if (!ts.isTaggedTemplateExpression(query) || !ts.isTemplateExpression(query.template)) return false;
      const tag = resolvedSymbol(query.tag, checker);
      const execute = signatureDeclaration(node, checker);
      if (
        tag?.name === 'sql' &&
        execute &&
        operationFamily('execute', execute) === 'drizzle' &&
        tag.declarations?.some((item) => packageOf(item) === 'drizzle-orm')
      ) {
        const spans = query.template.templateSpans;
        const predicate = spans.at(-1);
        const precedingSql = spans.at(-2)?.literal.text ?? query.template.head.text;
        return (
          predicate !== undefined &&
          /\bWHERE\s*$/i.test(precedingSql) &&
          /^\s*;?\s*$/.test(predicate.literal.text) &&
          checker.getSymbolAtLocation(predicate.expression) === binding
        );
      }
    }
    return ts.forEachChild(node, (child) => visit(child) || undefined);
  }
  return !!visit(declaration.body);
}

// A callee that takes the item keys as a list is already a batch API called per group.
function passesCollection(
  call: CallExpression,
  declaration: FunctionWithBody,
  owner: RepeatOwner,
  checker: CheckerAdapter,
): boolean {
  return call.arguments.some((argument, index) => {
    if (carriesInList(argument, checker)) return true;
    if (
      call.arguments.length === 1 &&
      isDrizzleBatchFilter(argument, owner, checker) &&
      usesSqlFilter(declaration, checker)
    )
      return true;
    if (!isArrayValue(argument, checker)) return false;
    const parameter = declaration.parameters[index];
    return (
      !parameter ||
      !!parameter.dotDotDotToken ||
      !ts.isIdentifier(parameter.name) ||
      !appendsTo(declaration, parameter.name.text, checker)
    );
  });
}

function lengthBoundCollection(loop: ForStatement): Expression | undefined {
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
function iteratedCollection(owner: RepeatOwner): Expression | undefined {
  if (ts.isForOfStatement(owner) || ts.isForInStatement(owner)) return owner.expression;
  if (ts.isForStatement(owner)) return lengthBoundCollection(owner);
  if (!ts.isFunctionLike(owner)) return;
  const call = outerExpression(owner).parent;
  if (ts.isCallExpression(call) && ts.isPropertyAccessExpression(call.expression)) return call.expression.expression;
}

function constantInitializer(
  expression: Expression,
  checker: CheckerAdapter,
): Expression | EnumDeclaration | undefined {
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

function isConstantTable(expression: Expression, checker: CheckerAdapter, depth: number): boolean {
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

// Lists written into the source, such as fallback chains or enum values, have a size fixed by the
// code.
function isConstantCollection(expression: Expression | undefined, checker: CheckerAdapter, depth = 0): boolean {
  if (!expression || depth > MAX_CONSTANT_DEPTH) return false;
  const value = ts.skipOuterExpressions(expression);
  const follow = (child: Expression | undefined): boolean => isConstantCollection(child, checker, depth + 1);
  if (ts.isArrayLiteralExpression(value))
    return (
      value.elements.length > 0 &&
      value.elements.every((element) => !ts.isSpreadElement(element) || follow(element.expression))
    );
  if (ts.isConditionalExpression(value)) return follow(value.whenTrue) && follow(value.whenFalse);
  // `await Promise.all(pair.map(load))` has as many items as the pair.
  if (ts.isAwaitExpression(value)) return follow(value.expression);
  if (ts.isIdentifier(value)) {
    // A work queue seeded from a literal, such as a tree walk, keeps growing while the loop runs.
    const declaration = resolvedSymbol(value, checker)?.valueDeclaration;
    if (declaration && ts.isVariableDeclaration(declaration) && isGrownLater(declaration, checker)) return false;
    const initializer = constantInitializer(value, checker);
    return initializer !== undefined && !ts.isEnumDeclaration(initializer) && follow(initializer);
  }
  if (ts.isElementAccessExpression(value) || ts.isPropertyAccessExpression(value))
    return isConstantTable(value.expression, checker, depth);
  if (!ts.isCallExpression(value)) return false;
  if (!ts.isPropertyAccessExpression(value.expression)) return returnsConstantCollection(value, checker, depth);
  const method = value.expression.name.text;
  const receiver = ts.skipOuterExpressions(value.expression.expression);
  if (ts.isIdentifier(receiver) && receiver.text === 'Object' && objectReaders.has(method))
    return value.arguments.length === 1 && isConstantObject(value.arguments[0], checker);
  if (ts.isIdentifier(receiver) && receiver.text === 'Promise' && method === 'all')
    return value.arguments.length === 1 && follow(value.arguments[0]);
  if (method === 'slice' && isStandardArrayCall(value, checker) && slicesFewItems(value, checker)) return true;
  if (arrayNarrowers.has(method) && isStandardArrayCall(value, checker)) return follow(receiver);
  return returnsConstantCollection(value, checker, depth);
}

function slicesFewItems(call: CallExpression, checker: CheckerAdapter): boolean {
  const [start, end] = call.arguments.map((argument) => argument && ts.skipOuterExpressions(argument));
  return !!start && !!end && ts.isNumericLiteral(start) && Number(start.text) === 0 && isFewItems(end, checker);
}

// A literal, or a constant such as an imported `BATCH_SIZE = 4`, whose type is that number.
function isFewItems(end: Expression, checker: CheckerAdapter): boolean {
  if (ts.isNumericLiteral(end)) return Number(end.text) <= MAX_SLICED_ITEMS;
  const type = checker.getTypeAtLocation(end);
  return (
    !!(type.flags & ts.TypeFlags.NumberLiteral) && typeof type.value === 'number' && type.value <= MAX_SLICED_ITEMS
  );
}

function isConstantObject(expression: Expression, checker: CheckerAdapter): boolean {
  const table = constantInitializer(expression, checker);
  return (
    !!table &&
    (ts.isEnumDeclaration(table) ||
      (ts.isObjectLiteralExpression(table) && !table.properties.some(ts.isSpreadAssignment)))
  );
}

// A project helper such as `selectSources()` that only returns a filtered constant list.
function returnsConstantCollection(call: CallExpression, checker: CheckerAdapter, depth: number): boolean {
  const declaration = signatureDeclaration(call, checker);
  if (!isProjectFunction(declaration) || !ts.isBlock(declaration.body)) return false;
  const results: (Expression | undefined)[] = [];
  (function visit(node: Node): void {
    if (ts.isFunctionLike(node)) return;
    if (ts.isReturnStatement(node)) results.push(node.expression);
    ts.forEachChild(node, visit);
  })(declaration.body);
  return results.length > 0 && results.every((result) => isConstantCollection(result, checker, depth + 1));
}

// Items drawn from a literal union (an enum or a list of known names) are a fixed, small domain.
function hasLiteralDomain(owner: RepeatOwner, checker: CheckerAdapter): boolean {
  const binding = elementBinding(owner);
  if (!binding || !ts.isIdentifier(binding)) return false;
  const type = checker.getTypeAtLocation(binding);
  const members = type.isUnion() && type.types ? type.types : [type];
  return members.every((member) => member.flags & literalFlags);
}

// The project functions between the callee and the first listed operation, outermost first.
function operationPath(operations: readonly LoopOperation[]): string | undefined {
  const [first] = operations;
  return first.via?.length ? first.via.map((name) => `\`${name}\``).join(' -> ') : undefined;
}

function calleeLabel(call: CallExpression): string {
  const text = call.expression.getText().replaceAll(/\s+/g, '');
  const name = ts.isPropertyAccessExpression(call.expression) ? call.expression.name.text : text;
  return text.length <= MAX_LABEL_LENGTH ? text : name;
}

const batchReads: Readonly<Record<string, string>> = {
  prisma: 'one `{ in: ids }` read',
  typeorm: 'one `In(ids)` read',
  sequelize: 'one `[Op.in]: ids` read',
  mongoose: 'one `$in` read',
  drizzle: 'one `inArray()` read',
  'mikro-orm': 'one `{ id: ids }` read',
  payload: 'one `find` with `where: { id: { in: ids } }`',
  pg: 'one `= ANY($1)` read',
};
const cacheFamilies = new Set(['redis', 'queue']);

function batchAdvice(families: ReadonlySet<string>): string {
  const read = [...families].map((family) => batchReads[family]).find(Boolean);
  const parts: string[] = [];
  if (read) parts.push(read, 'one bulk write');
  if (families.has('redis')) parts.push('one Redis pipeline or multi-key command');
  if (families.has('queue')) parts.push('one `addBulk()`');
  if (!parts.length) parts.push('one set-based read', 'one bulk write');
  return parts.join(', ');
}

function operationNoun(families: ReadonlySet<string>, count: number): string {
  const plural = count === 1 ? '' : 's';
  if ([...families].every((family) => cacheFamilies.has(family))) return `Redis command${plural}`;
  if ([...families].some((family) => cacheFamilies.has(family))) return `database and Redis call${plural}`;
  return `database call${plural}`;
}

function describe(operations: readonly LoopOperation[]): string {
  const groups = new Map<string, LoopOperation[]>();
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

function insideCatch(node: Node, owner: Node): boolean {
  for (let current = node.parent; current && current !== owner; current = current.parent)
    if (ts.isCatchClause(current)) return true;
  return false;
}

// A callee that commits or locks in its own transaction step, called one item at a time on purpose:
// - ids sorted before the loop and the caller's transaction client passed in, so every caller takes
// the
//   row locks in the same order and concurrent writers cannot deadlock;
// - a leased job that stops between items, so each finished item stays committed for the next run.
// Test, seed and tooling sources get their context from review-context, like the other per-item
// query rules.
function perItemTransactionReason(
  node: CallExpression,
  owner: RepeatOwner,
  operations: readonly LoopOperation[],
  checker: CheckerAdapter,
): string | undefined {
  if (!operations.some((operation) => transactionMethods.has(operation.label.split('.').pop() ?? ''))) return;
  if (sortedBeforeLoop(owner, checker) && passesTransactionClient(node, checker))
    return 'The loop walks ids sorted just before it and hands each call the transaction client, and the callee runs its own transaction step that locks rows, so the fixed order keeps concurrent writers from deadlocking. A batch version must lock every row in the same order in one statement (for example `SELECT ... ORDER BY id FOR UPDATE`). Review if the list can grow large.';
  if (stopsOnLostLease(owner, checker))
    return 'The job stops between items once its lease is lost, and each call commits in its own transaction, so finished items stay done and the next run resumes the rest. A batch version must keep those commit points. Review if the list can grow large.';
}

// `a ?? []` and `a || []` walk `a`; the fallback only keeps the loop valid.
function withoutFallback(expression: Expression): Expression {
  const value = ts.skipOuterExpressions(expression);
  const isFallback =
    ts.isBinaryExpression(value) &&
    (value.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
      value.operatorToken.kind === ts.SyntaxKind.BarBarToken);
  return isFallback ? withoutFallback(value.left) : value;
}

function chainRoot(expression: Expression): Expression {
  let current = ts.skipOuterExpressions(expression);
  while (
    ts.isPropertyAccessExpression(current) ||
    ts.isElementAccessExpression(current) ||
    ts.isNonNullExpression(current)
  )
    current = ts.skipOuterExpressions(current.expression);
  return current;
}

// `this.dependency.stores`: the first property read from `this` is a constructor-injected
// dependency.
function isInjectedDependencyMember(collection: Expression, checker: CheckerAdapter): boolean {
  let current = withoutFallback(collection);
  let field: PropertyAccessExpression | undefined;
  while (ts.isPropertyAccessExpression(current)) {
    field = current;
    current = ts.skipOuterExpressions(current.expression);
  }
  if (!field || current.kind !== ts.SyntaxKind.ThisKeyword) return false;
  const declaration = resolvedSymbol(field.name, checker)?.valueDeclaration;
  return !!declaration && ts.isParameter(declaration) && ts.isConstructorDeclaration(declaration.parent);
}

// Walking the handful of clients or stores a service was constructed with and calling each one is
// not a per-record loop: the number of iterations is fixed by how the application is wired, not by
// the data.
function callsInjectedInstance(node: CallExpression, owner: RepeatOwner, checker: CheckerAdapter): boolean {
  const collection = iteratedCollection(owner);
  const element = elementBinding(owner);
  const callee = node.expression;
  if (!collection || !element || !ts.isIdentifier(element) || !ts.isPropertyAccessExpression(callee)) return false;
  const receiver = chainRoot(callee.expression);
  return ts.isIdentifier(receiver) && receiver.text === element.text && isInjectedDependencyMember(collection, checker);
}

function shouldSkipLoop(node: CallExpression, owner: RepeatOwner, checker: CheckerAdapter): boolean {
  const collection = iteratedCollection(owner);
  return (
    callsInjectedInstance(node, owner, checker) ||
    isConstantCollection(collection, checker) ||
    (ts.isForInStatement(owner) && collection !== undefined && isConstantObject(collection, checker)) ||
    hasLiteralDomain(owner, checker) ||
    isSequentialByDesign(node, owner) ||
    !shouldReportLoopQuery(node, checker, { owner })
  );
}

function check(node: CallExpression, context: PerformanceRuleContext): void {
  const { checker } = context;
  const callee = node.expression;
  if (!ts.isPropertyAccessExpression(callee) && !ts.isIdentifier(callee)) return;
  const owner = findRepeatOwner(node, checker);
  // Syntax first: on the native engine every checker request is a synchronous round trip.
  if (!owner || !iteratedCollection(owner) || insideCatch(node, owner)) return;
  const declaration = signatureDeclaration(node, checker);
  if (!isProjectFunction(declaration) || contains(declaration, node)) return;
  // The callee summary is cached per declaration, and most project callees do no database work, so
  // it rules out a call before the per-call loop and argument checks.
  const shallow = calleeOperations(declaration, checker);
  // Without operations of its own or in a short wrapper, the callee may still reach one several
  // hops down.
  const deep = shallow.operations.length ? undefined : summarizedOperations(node, checker, context.program);
  const { operations, complete } = deep ?? shallow;
  if (!operations.length) return;
  if (shouldSkipLoop(node, owner, checker) || passesCollection(node, declaration, owner, checker)) return;
  // typeorm-transaction-in-loop already reports a per-item call to a transaction wrapper.
  if (transactionLoopTarget(node, checker)) return;
  // queue-add-in-loop already reports a per-item call to a wrapper that only enqueues.
  if (operations.every((operation) => operation.family === 'queue') && wrappedQueueAdd(node, context)) return;
  const label = calleeLabel(node);
  const count = operations.length;
  const families = new Set(operations.map((operation) => operation.family));
  // Operations on separate branches are listed together, so a complete count is an upper bound.
  // Deeper project calls are not followed, so an incomplete count is a lower bound.
  const amount = complete ? (count === 1 ? 'a' : `up to ${count}`) : `at least ${count === 1 ? 'one' : count}`;
  const trips = `${amount} round ${count === 1 ? 'trip' : 'trips'}`;
  const reachedVia = deep && operationPath(operations);
  const combinator = promiseCombinatorOf(owner);
  // Calls started together overlap in time, but each still costs its own round trips and a pooled
  // connection.
  const cost = combinator
    ? `and \`Promise.${combinator}\` starts every item at once, so the waits overlap but each item still costs ${trips} and a pooled connection, and the load grows with the list`
    : `so the loop pays ${trips} for every item it handles`;
  context.report(
    ts.isPropertyAccessExpression(callee) ? callee.name : callee,
    RULE_ID,
    `\`${label}()\` makes ${amount} ${operationNoun(families, count)} per item (${describe(operations)}${reachedVia ? `, reached through ${reachedVia}` : ''}), ${cost}. Add a batch variant that takes all ids (${batchAdvice(families)}) and call it once outside the loop. Keep per-item validation, error isolation, ordering and transaction needs.`,
    perItemTransactionReason(node, owner, operations, checker) ?? (deep && DEEP_REASON),
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

export { check, operationFamily, runsWithBody, signatureDeclaration, summarize };
