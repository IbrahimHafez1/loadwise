// A total count and the page of rows for the same filter, awaited one after another.
import { loadSyntax } from './compiler.cjs';
import { prismaModelName } from './prisma.cjs';
import { createReferenceChecks } from './reference-checks.cjs';
import type { CallExpression, Expression, Node, Statement } from 'typescript';
import type { PerformanceRuleContext } from '../shared/types.cjs';
import type { CountedCall, PageCountKind, PageCountMatch, PageCountPair } from './types/page-count-pair.cjs';
import type * as TypeScriptModule from 'typescript';
const ts = loadSyntax();

type Syntax = typeof TypeScriptModule;

// How a pair of calls is recognised as a count and a page.
interface PaginatedPairOptions {
  kind: PageCountKind;
  rowsMethod: string;
  filterOptions: readonly string[];
  extraRejected: ReadonlySet<string>;
}

// Builder methods that only shape the page, so `getCount()` before or after them counts the same
// rows.
const PAGE_SHAPING_METHODS = new Set(['skip', 'take', 'offset', 'limit', 'orderBy', 'addOrderBy']);
const REPOSITORY_FILTER_OPTIONS = ['where', 'withDeleted'];
const PRISMA_FILTER_OPTIONS = ['where'];
// Options that change which rows the page holds, so a count without them would differ.
const PRISMA_ROW_SET_OPTIONS = new Set(['distinct', 'cursor']);

// The syntax module is a parameter because site fixes parse with TypeScript while the checker may
// run on the native compiler, and the two disagree on node kinds.
function createPairMatcher(ts: Syntax) {
  function textOf(node: Node) {
    return node.getText();
  }

  const { isPlainReference, mentionsIdentifier } = createReferenceChecks(ts);

  // `const name = await receiver.method(args)` as { name, call, method, receiver }.
  function awaitedConstCall(statement: Statement): CountedCall | undefined {
    if (!ts.isVariableStatement(statement) || !(statement.declarationList.flags & ts.NodeFlags.Const)) return;
    if (statement.declarationList.declarations.length !== 1) return;
    const [declaration] = statement.declarationList.declarations;
    if (!ts.isIdentifier(declaration.name)) return;
    const awaited = declaration.initializer;
    if (!awaited || !ts.isAwaitExpression(awaited) || !ts.isCallExpression(awaited.expression)) return;
    const call = awaited.expression;
    if (!ts.isPropertyAccessExpression(call.expression) || call.expression.questionDotToken) return;
    return { name: declaration.name.text, call, method: call.expression.name, receiver: call.expression.expression };
  }

  // Option name -> source text of its value, or undefined when the argument is not a plain object
  // literal.
  function optionsOf(call: CallExpression): Map<string, string> | undefined {
    const [options] = call.arguments;
    if (call.arguments.length !== 1 || !ts.isObjectLiteralExpression(options)) return;
    const entries = new Map<string, string>();
    for (const property of options.properties) {
      const named = ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property);
      if (!named || !(ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))) return;
      entries.set(
        property.name.text,
        ts.isShorthandPropertyAssignment(property) ? property.name.text : textOf(property.initializer),
      );
    }
    return entries;
  }

  // The filter options a count call carries; an absent argument is an empty filter.
  function countOptions(call: CallExpression, allowed: readonly string[]): Map<string, string> | undefined {
    if (call.arguments.length === 0) return new Map<string, string>();
    const entries = optionsOf(call);
    if (!entries || [...entries.keys()].some((name) => !allowed.includes(name))) return;
    return entries;
  }

  function sameFilter(count: Map<string, string>, rows: Map<string, string>, names: readonly string[]) {
    return names.every((name) => (count.get(name) ?? '') === (rows.get(name) ?? ''));
  }

  function isPageShapingChain(expression: Expression): boolean {
    const root =
      ts.isCallExpression(expression) && ts.isPropertyAccessExpression(expression.expression) && chainRoot(expression);
    return !!root && isPlainReference(root);
  }

  // `qb.skip(a).take(b)` -> qb; undefined when the chain does anything but shape the page.
  function chainRoot(expression: Expression): Expression | undefined {
    let current = expression;
    while (ts.isCallExpression(current) && ts.isPropertyAccessExpression(current.expression)) {
      if (!PAGE_SHAPING_METHODS.has(current.expression.name.text)) return;
      current = current.expression.expression;
    }
    return current;
  }

  function byMethods(
    first: CountedCall,
    second: CountedCall,
    countMethod: string,
    rowsMethod: string,
  ): [CountedCall, CountedCall] | undefined {
    if (first.method.text === countMethod && second.method.text === rowsMethod) return [first, second];
    if (second.method.text === countMethod && first.method.text === rowsMethod) return [second, first];
  }

  function builderPair(first: CountedCall, second: CountedCall): PageCountMatch | undefined {
    const found = byMethods(first, second, 'getCount', 'getMany');
    if (!found) return;
    const [count, rows] = found;
    if (count.call.arguments.length || rows.call.arguments.length) return;
    const root = chainRoot(rows.receiver);
    if (!root || !isPlainReference(count.receiver) || textOf(root) !== textOf(count.receiver)) return;
    return { kind: 'query-builder', count, rows, receiver: count.receiver };
  }

  function paginatedPair(
    first: CountedCall,
    second: CountedCall,
    { kind, rowsMethod, filterOptions, extraRejected }: PaginatedPairOptions,
  ): PageCountMatch | undefined {
    const found = byMethods(first, second, 'count', rowsMethod);
    if (!found) return;
    const [count, rows] = found;
    if (!isPlainReference(count.receiver) || textOf(count.receiver) !== textOf(rows.receiver)) return;
    const countEntries = countOptions(count.call, filterOptions);
    const rowEntries = optionsOf(rows.call);
    if (!countEntries || !rowEntries || !(rowEntries.has('skip') || rowEntries.has('take'))) return;
    if ([...rowEntries.keys()].some((name) => extraRejected.has(name))) return;
    if (!sameFilter(countEntries, rowEntries, filterOptions)) return;
    return { kind, count, rows, receiver: count.receiver };
  }

  const MAX_STATEMENTS_BETWEEN = 4;

  function hasCallOrAwait(node: Node): boolean {
    return (
      ts.isCallExpression(node) ||
      ts.isAwaitExpression(node) ||
      !!ts.forEachChild(node, (child) => hasCallOrAwait(child) || undefined)
    );
  }

  // `qb.offset(a).limit(b);` or `const skip = (page - 1) * limit;`, which cannot change what the
  // count sees.
  function isHarmlessBetween(statement: Statement) {
    if (ts.isExpressionStatement(statement)) return isPageShapingChain(statement.expression);
    if (!ts.isVariableStatement(statement)) return false;
    return statement.declarationList.declarations.every(
      (declaration) => !!declaration.initializer && !hasCallOrAwait(declaration.initializer),
    );
  }

  // Syntactic match of the statement and the awaited const after it. Receiver types are confirmed
  // by the caller. Only query builders tolerate statements in between, since those can only add
  // paging to the same builder.
  function pageCountPair(statement: Statement): PageCountPair | undefined {
    const block = statement.parent;
    if (!ts.isBlock(block) && !ts.isSourceFile(block) && !ts.isModuleBlock(block)) return;
    const first = awaitedConstCall(statement);
    if (!first) return;
    const start = block.statements.indexOf(statement);
    for (
      let index = start + 1;
      index < block.statements.length && index <= start + MAX_STATEMENTS_BETWEEN + 1;
      index++
    ) {
      const nextStatement = block.statements[index];
      const second = awaitedConstCall(nextStatement);
      const between = block.statements.slice(start + 1, index);
      if (second) return pairOf(first, second, [statement, ...between, nextStatement]);
      if (!isHarmlessBetween(nextStatement)) return;
    }
  }

  function pairOf(first: CountedCall, second: CountedCall, statements: Statement[]): PageCountPair | undefined {
    if (first.name === second.name || statements.slice(1).some((later) => mentionsIdentifier(later, first.name)))
      return;
    const adjacent = statements.length === 2;
    const pair =
      builderPair(first, second) ||
      (adjacent
        ? paginatedPair(first, second, {
            kind: 'repository',
            rowsMethod: 'find',
            filterOptions: REPOSITORY_FILTER_OPTIONS,
            extraRejected: new Set<string>(),
          }) ||
          paginatedPair(first, second, {
            kind: 'prisma',
            rowsMethod: 'findMany',
            filterOptions: PRISMA_FILTER_OPTIONS,
            extraRejected: PRISMA_ROW_SET_OPTIONS,
          })
        : undefined);
    return pair && { ...pair, first, second, statements };
  }

  return pageCountPair;
}

const pageCountPair = createPairMatcher(ts);

function isInsideTransactionCallback(node: Node) {
  for (let current = node.parent; current; current = current.parent) {
    if (!ts.isFunctionLike(current)) continue;
    const call = current.parent;
    if (ts.isCallExpression(call) && ts.isPropertyAccessExpression(call.expression)) {
      if (call.expression.name.text === '$transaction') return true;
    }
  }
  return false;
}

const OFFSET_PAGING_METHODS = new Set(['limit', 'offset']);
const JOIN_METHOD = /Join/;

function callsMethod(node: Node, matches: (name: string) => boolean): boolean {
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
    if (matches(node.expression.name.text)) return true;
  }
  return !!ts.forEachChild(node, (child) => callsMethod(child, matches) || undefined);
}

function enclosingFunctionBody(node: Node): Node | undefined {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isFunctionLike(current)) return 'body' in current ? current.body : undefined;
  }
}

// A builder declared in the same function from `createQueryBuilder(...)` that nothing joins onto.
function isVisiblyJoinFree(receiver: Node): boolean {
  if (!ts.isIdentifier(receiver)) return false;
  const body = enclosingFunctionBody(receiver);
  if (!body) return false;
  let declared = false;
  let joined = false;
  (function visit(node: Node): void {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === receiver.text) {
      declared = !!node.initializer && callsMethod(node.initializer, (name) => name === 'createQueryBuilder');
    }
    const isJoinCall =
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      JOIN_METHOD.test(node.expression.name.text);
    if (isJoinCall) joined = true;
    ts.forEachChild(node, visit);
  })(body);
  return declared && !joined;
}

// TypeORM's getManyAndCount always runs the count when a builder with joins pages with
// limit/offset, so the suggested change would save nothing. Silent unless the builder is visibly
// join-free.
function countsEveryPage(pair: PageCountPair) {
  if (pair.kind !== 'query-builder') return false;
  const offsetPaged = pair.statements.some((statement) =>
    callsMethod(statement, (name) => OFFSET_PAGING_METHODS.has(name)),
  );
  return offsetPaged && !isVisiblyJoinFree(pair.receiver);
}

const MESSAGES: Record<PageCountKind, string> = {
  'query-builder':
    'getCount() and getMany() on the same query builder run one after the other, so the page waits for the count. `const [rows, total] = await qb.getManyAndCount()` skips the count when the page comes back partly filled; a full page still runs it serially after the rows. Ignore if the count intentionally uses a different filter.',
  repository:
    'count() and find() with the same `where` run one after the other, so the page waits for the count. `const [rows, total] = await repo.findAndCount({ where, skip, take })` skips the count when the page comes back partly filled; a full page still runs it serially after the rows. Ignore if the count needs a different filter than the page.',
  prisma:
    'count() and findMany() with the same `where` run one after the other, so the page waits for the count and costs two round trips. Start both together with `const [total, rows] = await Promise.all([model.count({ where }), model.findMany({ where, skip, take })])`. Ignore inside an interactive transaction, where both share one connection.',
};

function isExpectedReceiver(pair: PageCountPair, context: PerformanceRuleContext) {
  if (pair.kind === 'prisma') {
    return (
      !!prismaModelName(pair.count.method, context.checker) &&
      !!prismaModelName(pair.rows.method, context.checker) &&
      !isInsideTransactionCallback(pair.first.call)
    );
  }
  const typeName = pair.kind === 'query-builder' ? 'SelectQueryBuilder' : 'Repository';
  return context.isPackageType(pair.receiver, ['typeorm'], [typeName]);
}

function check(node: CallExpression, context: PerformanceRuleContext) {
  // call -> await -> declaration -> declaration list -> statement
  const statement = node.parent?.parent?.parent?.parent;
  if (!statement || !ts.isVariableStatement(statement)) return;
  const pair = pageCountPair(statement);
  if (!pair || pair.first.call !== node || !isExpectedReceiver(pair, context) || countsEveryPage(pair)) return;
  context.report(pair.first.method, 'count-then-page-serial', MESSAGES[pair.kind]);
}

export { check, createPairMatcher };
