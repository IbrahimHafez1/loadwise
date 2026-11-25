// list-count-per-request: a request handler that counts every matching row on each list request and
// puts the total in the response. A serial count then page pair is already reported by
// count-then-page-serial, which wins.
import { ts } from './compiler.js';
import { prismaModelName } from './prisma.js';
import { createPairMatcher } from './page-counts.js';
import { declaredInPackage, initializerOf, propertyName } from './schema/ts-helpers.js';
import { enclosingRequestHandler, reachesResponse } from './request-handlers.js';
import { hasFunctionBody } from './function-kinds.js';
import type {
  ArrayBindingElement,
  ArrayBindingPattern,
  BinaryExpression,
  CallExpression,
  Expression,
  Identifier,
  Node,
  ObjectBindingPattern,
  PropertyAccessExpression,
  Statement,
  VariableDeclaration,
} from 'typescript';
import type { PerformanceRuleContext, RuleContext } from '../shared/types.js';
import type { FunctionWithBody } from '../shared/types/function-summaries.js';

const RULE_ID = 'list-count-per-request';
const PG_PACKAGES = ['pg', '@types/pg', 'pg-pool', '@types/pg-pool'];
const PG_RECEIVERS = ['Pool', 'Client', 'ClientBase', 'PoolClient'];
const SQL_COUNT_ALL = /^\s*select\s+count\s*\(/i;
const SQL_GROUP_BY = /\bgroup\s+by\b/i;
const TYPEORM_COUNTS = new Set(['count', 'countBy', 'findAndCount', 'findAndCountBy', 'getCount', 'getManyAndCount']);
const SEQUELIZE_COUNTS = new Set(['count', 'findAndCountAll']);
// Methods that return the rows together with the total: `[rows, total]`, or `{ rows, count }` for
// Sequelize.
const TUPLE_COUNTS = new Set(['findAndCount', 'findAndCountBy', 'getManyAndCount']);
const OBJECT_COUNTS = new Set(['findAndCountAll']);
const COUNT_FIELD = 'count';
const TOTAL_INDEX = 1;
const PAGE_QUERY_METHODS = new Set([
  'findMany',
  'find',
  'findAll',
  'findBy',
  'getMany',
  'limit',
  'take',
  'skip',
  'offset',
]);
// Conditions that mean the total is optional or only worked out once.
const OPTIONAL_TOTAL_CONDITION =
  /total|count|cache|redis|first|page\s*(?:===?|<=?)\s*[01]\b|offset\s*===?\s*0|!\s*(?:cursor|skip|offset)/i;
const CACHE_CALLEE = /cache|memo|remember|getOrSet|wrap/i;
const PARENT_KEY = /^(?:_?id|\w+Id|\w+_id)$/;
const PROMISE_ALL_METHODS = new Set(['all', 'allSettled']);
const MAX_ALIAS_DEPTH = 3;
const NUMERIC_CALLEE = /^(?:Math\.|Number$)/;
const MESSAGE =
  'A full count of the matching rows runs on every request of this list endpoint and its total goes into the response, so each page pays for a scan of all rows that match. Return the total only when the client asks for it (a `withTotal` flag) or on the first page, cache it, or page with a cursor and a `take + 1` look-ahead instead. Ignore if clients need an exact total on every page and the filter keeps the table small.';
const PARENT_FILTER_REASON =
  'The count is filtered by an id column, so it may be bounded by the parent row; whether that column is indexed and how many rows one parent has could not be checked.';
const CONDITION_REASON =
  'The count only runs under a condition, so it may not happen on every request; what the condition tests could not be judged.';
const PAGED_SAME_WHERE_REASON =
  'The list query is limited to one page and count() uses the same where filter, so the total is likely shown with pagination; confirm whether clients need an exact total on every page.';

// The filter a count runs over, when the call spells one out.
interface CountSite {
  filter?: Expression;
}

// A step into the result of a count call: a tuple index or an object field name.
type ResultSlot = number | string;

type TotalGuard = 'skip' | 'conditional';

const pageCountPair = createPairMatcher(ts);

function optionValue(options: Expression | undefined, name: string): Expression | undefined {
  const literal = options && ts.skipOuterExpressions(options);
  if (!literal || !ts.isObjectLiteralExpression(literal)) return;
  const property = literal.properties.find((candidate) => propertyName(candidate) === name);
  return property && ts.isPropertyAssignment(property) ? ts.skipOuterExpressions(property.initializer) : undefined;
}

function pgCounts(call: CallExpression, access: PropertyAccessExpression, context: RuleContext): CountSite | undefined {
  if (access.name.text !== 'query' || !context.isPackageType(access.expression, PG_PACKAGES, PG_RECEIVERS)) return;
  const text = call.arguments[0] && ts.skipOuterExpressions(call.arguments[0]);
  if (!text || !ts.isStringLiteralLike(text)) return;
  if (SQL_COUNT_ALL.test(text.text) && !SQL_GROUP_BY.test(text.text)) return {};
}

// Which count API the call is, with the filter object the count runs over; undefined for any other
// call.
function countSite(call: CallExpression, context: RuleContext): CountSite | undefined {
  const callee = ts.skipOuterExpressions(call.expression);
  if (ts.isIdentifier(callee)) {
    return callee.text === COUNT_FIELD && declaredInPackage(callee, context.checker, ['drizzle-orm']) ? {} : undefined;
  }
  if (!ts.isPropertyAccessExpression(callee)) return;
  const method = callee.name.text;
  const where = () => optionValue(call.arguments[0], 'where');
  if (method === 'query') return pgCounts(call, callee, context);
  if (method === COUNT_FIELD && prismaModelName(callee.name, context.checker)) return { filter: where() };
  if (TYPEORM_COUNTS.has(method) && declaredInPackage(callee, context.checker, ['typeorm'])) {
    return { filter: where() ?? (call.arguments[0] && ts.skipOuterExpressions(call.arguments[0])) };
  }
  if (
    SEQUELIZE_COUNTS.has(method) &&
    declaredInPackage(callee, context.checker, ['sequelize', 'sequelize-typescript'])
  ) {
    return { filter: where() };
  }
  if (method === 'countDocuments' && declaredInPackage(callee, context.checker, ['mongoose'])) {
    return { filter: call.arguments[0] && ts.skipOuterExpressions(call.arguments[0]) };
  }
}

function filtersByParentId(filter: Expression | undefined, context: RuleContext): boolean {
  const literal = filter && ts.isIdentifier(filter) ? initializerOf(filter, context.checker) : filter;
  if (!literal || !ts.isObjectLiteralExpression(literal)) return false;
  return literal.properties.some((property) => PARENT_KEY.test(propertyName(property) ?? ''));
}

const PAGINATED_LIST_METHODS = new Set(['findMany', 'find', 'findAll', 'findBy']);

function normalizedText(node: Node | undefined): string {
  return node ? node.getText().replaceAll(/\s+/g, '') : '';
}

// An offset alone still returns every later row, so only a row limit makes the list one page.
function limitsRows(options: Expression | undefined): boolean {
  return Boolean(optionValue(options, 'take') || optionValue(options, 'limit'));
}

// True when the handler runs a list query limited to one page with the same where filter as the
// count.
function hasPagedListWithSameWhere(handler: FunctionWithBody, countFilter: Expression | undefined): boolean {
  const expectedWhere = normalizedText(countFilter);
  let matched = false;
  (function visit(node: Node): void {
    if (matched) return;
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      PAGINATED_LIST_METHODS.has(node.expression.name.text)
    ) {
      const options = node.arguments[0];
      if (limitsRows(options)) {
        const listWhere = normalizedText(optionValue(options, 'where'));
        if (listWhere === expectedWhere) {
          matched = true;
          return;
        }
      }
    }
    ts.forEachChild(node, visit);
  })(handler.body);
  return matched;
}

// The handler pages rows too: a handler that only counts is a statistics endpoint, not a list.
function pagesRows(handler: FunctionWithBody): boolean {
  let pages = false;
  (function visit(node: Node): void {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      if (PAGE_QUERY_METHODS.has(node.expression.name.text)) pages = true;
    }
    ts.forEachChild(node, visit);
  })(handler.body);
  return pages;
}

function statementsOf(node: Node | undefined): readonly Statement[] | undefined {
  if (!node) return;
  if (ts.isBlock(node) || ts.isSourceFile(node) || ts.isModuleBlock(node) || ts.isCaseOrDefaultClause(node)) {
    return node.statements;
  }
}

function isReportedAsSerialPair(call: CallExpression): boolean {
  const statement = call.parent?.parent?.parent?.parent;
  const statements = statementsOf(statement?.parent);
  if (!statement || !ts.isVariableStatement(statement) || !statements) return false;
  const index = statements.indexOf(statement);
  return statements.slice(0, index + 1).some((candidate) => pageCountPair(candidate)?.count.call === call);
}

function outerValue(node: Node): Node {
  let current = node;
  while (
    current.parent &&
    (ts.isAwaitExpression(current.parent) ||
      ts.isParenthesizedExpression(current.parent) ||
      ts.isAsExpression(current.parent) ||
      ts.isNonNullExpression(current.parent))
  ) {
    current = current.parent;
  }
  return current;
}

function isPromiseAll(call: CallExpression): boolean {
  const callee = ts.skipOuterExpressions(call.expression);
  return (
    ts.isPropertyAccessExpression(callee) &&
    callee.expression.getText() === 'Promise' &&
    PROMISE_ALL_METHODS.has(callee.name.text)
  );
}

// The slots to descend, outermost first, from the declared variable to the count: the `Promise.all`
// position, then the position inside a tuple or object result.
function resultSlots(call: CallExpression, method: string): { slots: ResultSlot[]; value: Node } {
  const slots: ResultSlot[] = [];
  if (TUPLE_COUNTS.has(method)) slots.push(TOTAL_INDEX);
  if (OBJECT_COUNTS.has(method)) slots.push(COUNT_FIELD);
  let value = outerValue(call);
  const list = value.parent;
  if (
    list &&
    ts.isArrayLiteralExpression(list) &&
    list.parent &&
    ts.isCallExpression(list.parent) &&
    isPromiseAll(list.parent)
  ) {
    slots.unshift(list.elements.findIndex((element) => element === value));
    value = outerValue(list.parent);
  }
  return { slots, value };
}

function elementNamed(
  pattern: ObjectBindingPattern | ArrayBindingPattern,
  slot: ResultSlot,
): ArrayBindingElement | undefined {
  if (typeof slot === 'number') {
    return ts.isArrayBindingPattern(pattern) ? pattern.elements[slot] : undefined;
  }
  if (!ts.isObjectBindingPattern(pattern)) return;
  return pattern.elements.find((element) => {
    const key = element.propertyName ?? element.name;
    return 'text' in key && key.text === slot;
  });
}

function declaredCountName(declaration: VariableDeclaration, slots: readonly ResultSlot[]): Identifier | undefined {
  let name = declaration.name;
  for (const slot of slots) {
    if (ts.isIdentifier(name)) return name;
    const element = elementNamed(name, slot);
    if (!element || ts.isOmittedExpression(element)) return;
    name = element.name;
  }
  return ts.isIdentifier(name) ? name : undefined;
}

function usesOf(handler: FunctionWithBody, name: Identifier): Identifier[] {
  const uses: Identifier[] = [];
  (function visit(node: Node): void {
    if (ts.isIdentifier(node) && node.text === name.text && node !== name) uses.push(node);
    ts.forEachChild(node, visit);
  })(handler.body);
  return uses;
}

// Follows a count through arithmetic such as `Math.ceil(total / size)` and one level of local
// variables.
function flowsToResponse(use: Node, handler: FunctionWithBody, depth: number): boolean {
  let current = use;
  for (let parent: Node | undefined = current.parent; parent; current = parent, parent = parent.parent) {
    const isArithmetic =
      ts.isBinaryExpression(parent) || ts.isParenthesizedExpression(parent) || ts.isConditionalExpression(parent);
    if (isArithmetic) continue;
    const isNumericCall =
      ts.isCallExpression(parent) &&
      parent.arguments.some((argument) => argument === current) &&
      NUMERIC_CALLEE.test(parent.expression.getText());
    if (!isNumericCall) break;
  }
  if (reachesResponse(current, handler)) return true;
  const declaration = current.parent;
  if (!declaration || !ts.isVariableDeclaration(declaration) || declaration.initializer !== current) return false;
  if (!ts.isIdentifier(declaration.name) || depth >= MAX_ALIAS_DEPTH) return false;
  return usesOf(handler, declaration.name).some((use) => flowsToResponse(use, handler, depth + 1));
}

function totalReachesResponse(call: CallExpression, method: string, handler: FunctionWithBody): boolean {
  const { slots, value } = resultSlots(call, method);
  const declaration = value.parent;
  if (!declaration || !ts.isVariableDeclaration(declaration) || declaration.initializer !== value) {
    return reachesResponse(value, handler);
  }
  const name = declaredCountName(declaration, slots);
  return !!name && usesOf(handler, name).some((use) => flowsToResponse(use, handler, 0));
}

function isCachedBy(ancestor: Node, handler: Node): boolean {
  if (!ts.isCallExpression(ancestor) || ancestor === handler || isPromiseAll(ancestor)) return false;
  return CACHE_CALLEE.test(ancestor.expression.getText());
}

function isGuardedFallback(ancestor: BinaryExpression, child: Node): boolean {
  const operator = ancestor.operatorToken.kind;
  const isFallback = operator === ts.SyntaxKind.QuestionQuestionToken || operator === ts.SyntaxKind.BarBarToken;
  return isFallback && ancestor.right === child;
}

// 'skip' when the total is cached or optional, 'conditional' when it sits under some other
// condition.
function guardOf(call: CallExpression, handler: FunctionWithBody): TotalGuard | undefined {
  let guard: TotalGuard | undefined;
  let child: Node = call;
  for (
    let ancestor: Node | undefined = call.parent;
    ancestor && ancestor !== handler;
    child = ancestor, ancestor = ancestor.parent
  ) {
    if (isCachedBy(ancestor, handler)) return 'skip';
    const condition =
      (ts.isIfStatement(ancestor) && ancestor.expression !== child && ancestor.expression) ||
      (ts.isConditionalExpression(ancestor) && ancestor.condition !== child && ancestor.condition) ||
      (ts.isBinaryExpression(ancestor) && isGuardedFallback(ancestor, child) && ancestor.left) ||
      (ts.isBinaryExpression(ancestor) &&
        ancestor.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken &&
        ancestor.right === child &&
        ancestor.left);
    if (!condition) continue;
    if (OPTIONAL_TOTAL_CONDITION.test(condition.getText())) return 'skip';
    guard = 'conditional';
  }
  return guard;
}

function reportNodeOf(call: CallExpression): Node {
  const callee = ts.skipOuterExpressions(call.expression);
  return ts.isPropertyAccessExpression(callee) ? callee.name : callee;
}

function check(call: CallExpression, context: PerformanceRuleContext): void {
  const handler = enclosingRequestHandler(call);
  if (!handler || !hasFunctionBody(handler)) return;
  const site = countSite(call, context);
  if (!site) return;
  const method = ts.isPropertyAccessExpression(call.expression) ? call.expression.name.text : COUNT_FIELD;
  const listsRows = TUPLE_COUNTS.has(method) || OBJECT_COUNTS.has(method);
  if (!listsRows && !pagesRows(handler)) return;
  if (isReportedAsSerialPair(call) || !totalReachesResponse(call, method, handler)) return;
  const guard = guardOf(call, handler);
  if (guard === 'skip') return;
  const reason =
    (guard && CONDITION_REASON) ||
    (filtersByParentId(site.filter, context) && PARENT_FILTER_REASON) ||
    (hasPagedListWithSameWhere(handler, site.filter) && PAGED_SAME_WHERE_REASON) ||
    undefined;
  context.report(reportNodeOf(call), RULE_ID, MESSAGE, reason);
}

export { check };
