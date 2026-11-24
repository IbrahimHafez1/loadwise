import path from 'node:path';
import { loadSyntax } from './compiler.cjs';
import { elementBinding, findRepeatOwner, promiseCombinatorOf } from './repeated.cjs';
import { familyEntry, isProjectFunction, operationFamily, signatureDeclaration } from './service-call-resolution.cjs';
import {
  hasLiteralDomain,
  isConstantCollection,
  isConstantObject,
  iteratedCollection,
  passesCollection,
} from './service-loop-collections.cjs';
import { isMemoised, shouldReportLoopQuery } from './query-loops.cjs';
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
import { declaredTypeormOwner } from './orm-queries.cjs';
import {
  executingTagPackages,
  prismaRawTags,
  transactionMethods,
  typeormOperations,
} from './service-loop-operations.cjs';
import type {
  CallExpression,
  Expression,
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

// Callbacks handed to these wrappers run only on a cache miss.
const cacheWrapperName =
  /^(?:(?:get|fetch|load|read)Or(?:Set|Fetch|Load|Compute|Cache)|remember|memoi[sz]e|cached|withCache)/i;

// Per callee declaration: { operations, callees }, computed once per program.
const bodySummaries = new WeakMap<FunctionWithBody, BodySummary>();

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

interface MemberCallSite {
  readonly summary: BodySummary;
  readonly file: SourceFile;
  readonly node: CallExpression;
  readonly access: PropertyAccessExpression;
  readonly chained: Set<Node>;
  readonly checker: CheckerAdapter;
}

function summarizeMemberCall({ summary, file, node, access, chained, checker }: MemberCallSite): void {
  const method = access.name.text;
  const operationLabel = `${receiverLabel(access.expression)}.${method}`;
  const target = signatureDeclaration(node, checker);
  const family = target && transactionMethods.has(method) && !isProjectFunction(target) && transactionFamily(target);
  // BEGIN and COMMIT add a round trip around the work inside the callback, which is counted
  // too.
  if (family) summary.operations.push(operationAt(file, access.name, family, operationLabel));
  if (target && isProjectFunction(target)) {
    summary.callees.push(target);
    return;
  }
  if (target) {
    const targetFamily = chained.has(node) ? undefined : operationFamily(method, target);
    if (!targetFamily) return;
    markInnerQueryCalls(access, chained);
    summary.operations.push(operationAt(file, access.name, targetFamily, operationLabel));
    return;
  }
  if (!chained.has(node) && typeormOperations.has(method) && declaredTypeormOwner(access.expression, checker)) {
    // TypeORM's types are not installed, but the receiver is declared as one of its
    // repositories.
    markInnerQueryCalls(access, chained);
    summary.operations.push(operationAt(file, access.name, 'typeorm', operationLabel));
  }
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
        summarizeMemberCall({ summary, file, node, access, chained, checker });
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

interface LoopCall {
  readonly owner: RepeatOwner;
  readonly declaration: FunctionWithBody;
}

function loopCallOf(node: CallExpression, checker: CheckerAdapter): LoopCall | undefined {
  const callee = node.expression;
  if (!ts.isPropertyAccessExpression(callee) && !ts.isIdentifier(callee)) return;
  const owner = findRepeatOwner(node, checker);
  // Syntax first: on the native engine every checker request is a synchronous round trip.
  if (!owner || !iteratedCollection(owner) || insideCatch(node, owner)) return;
  const declaration = signatureDeclaration(node, checker);
  if (!isProjectFunction(declaration) || contains(declaration, node)) return;
  return { owner, declaration };
}

interface ReachedViaCall extends ReachedOperations {
  readonly deep: ReachedOperations | undefined;
}

function reachedOperations(
  node: CallExpression,
  declaration: FunctionWithBody,
  context: PerformanceRuleContext,
): ReachedViaCall {
  // The callee summary is cached per declaration, and most project callees do no database work, so
  // it rules out a call before the per-call loop and argument checks.
  const shallow = calleeOperations(declaration, context.checker);
  // Without operations of its own or in a short wrapper, the callee may still reach one several
  // hops down.
  const deep = shallow.operations.length ? undefined : summarizedOperations(node, context.checker, context.program);
  const { operations, complete } = deep ?? shallow;
  return { operations, complete, deep };
}

function isReportedElsewhere(
  node: CallExpression,
  loopCall: LoopCall,
  operations: readonly LoopOperation[],
  context: PerformanceRuleContext,
): boolean {
  const { checker } = context;
  const { owner, declaration } = loopCall;
  if (shouldSkipLoop(node, owner, checker) || passesCollection(node, declaration, owner, checker)) return true;
  // typeorm-transaction-in-loop already reports a per-item call to a transaction wrapper.
  if (transactionLoopTarget(node, checker)) return true;
  // queue-add-in-loop already reports a per-item call to a wrapper that only enqueues.
  return operations.every((operation) => operation.family === 'queue') && wrappedQueueAdd(node, context) !== undefined;
}

// Operations on separate branches are listed together, so a complete count is an upper bound.
// Deeper project calls are not followed, so an incomplete count is a lower bound.
function roundTrips(count: number, complete: boolean): { amount: string; trips: string } {
  const amount = complete ? (count === 1 ? 'a' : `up to ${count}`) : `at least ${count === 1 ? 'one' : count}`;
  return { amount, trips: `${amount} round ${count === 1 ? 'trip' : 'trips'}` };
}

// Calls started together overlap in time, but each still costs its own round trips and a pooled
// connection.
function perItemCost(owner: RepeatOwner, trips: string): string {
  const combinator = promiseCombinatorOf(owner);
  return combinator
    ? `and \`Promise.${combinator}\` starts every item at once, so the waits overlap but each item still costs ${trips} and a pooled connection, and the load grows with the list`
    : `so the loop pays ${trips} for every item it handles`;
}

function check(node: CallExpression, context: PerformanceRuleContext): void {
  const { checker } = context;
  const callee = node.expression;
  const loopCall = loopCallOf(node, checker);
  if (!loopCall) return;
  const { operations, complete, deep } = reachedOperations(node, loopCall.declaration, context);
  if (!operations.length) return;
  if (isReportedElsewhere(node, loopCall, operations, context)) return;
  const label = calleeLabel(node);
  const count = operations.length;
  const families = new Set(operations.map((operation) => operation.family));
  const { amount, trips } = roundTrips(count, complete);
  const reachedVia = deep && operationPath(operations);
  const cost = perItemCost(loopCall.owner, trips);
  context.report(
    ts.isPropertyAccessExpression(callee) ? callee.name : callee,
    RULE_ID,
    `\`${label}()\` makes ${amount} ${operationNoun(families, count)} per item (${describe(operations)}${reachedVia ? `, reached through ${reachedVia}` : ''}), ${cost}. Add a batch variant that takes all ids (${batchAdvice(families)}) and call it once outside the loop. Keep per-item validation, error isolation, ordering and transaction needs.`,
    perItemTransactionReason(node, loopCall.owner, operations, checker) ?? (deep && DEEP_REASON),
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
