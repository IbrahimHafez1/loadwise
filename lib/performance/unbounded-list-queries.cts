// A list query with no row limit whose rows are returned from a request handler: the response grows
// with the table.
import { loadSyntax } from './compiler.cjs';
import { prismaModelName } from './prisma.cjs';
import { querySite } from './schema/query-sites.cjs';
import { declaredInPackage, propertyName, objectProperty } from './schema/ts-helpers.cjs';
import { drizzleColumn } from './schema/drizzle-schema.cjs';
import {
  enclosingRequestHandler,
  isFunctionLikeDeclaration,
  reachesResponse,
  isRequestHandler,
} from './request-handlers.cjs';
import { traceInputs, boundOf, requestInputOf, leafName } from './request-inputs.cjs';
import type {
  CallExpression,
  Expression,
  FunctionLikeDeclaration,
  Node,
  ObjectLiteralElementLike,
  ParameterDeclaration,
  PropertyAccessExpression,
  VariableDeclaration,
} from 'typescript';
import type { CheckerAdapter, PerformanceRuleContext } from '../shared/types.cjs';
import type { FunctionWithBody } from '../shared/types/function-summaries.cjs';
import type { RequestHandlerFunction } from './types/request-handler.cjs';
import type { SchemaTable } from './types/schema-model.cjs';
const ts = loadSyntax();

/**
 * A list query that has no row limit; `top` is the call whose result is returned, `idList` the ids
 * it is matched against.
 */
interface ListQuery {
  label: string;
  top: CallExpression;
  reportNode: Node;
  idList?: Expression;
}

type ListRecogniser = (
  call: CallExpression,
  access: PropertyAccessExpression,
  context: PerformanceRuleContext,
) => ListQuery | undefined;

/** The method steps and string arguments of one builder chain. */
interface BuilderChain {
  methods: Set<string>;
  strings: string[];
  root: Expression;
}

/** Where a service method reads a request value from: the position of the parameter. */
interface ParameterPosition {
  parameterIndex: number;
}

/** A page-size expression of a list call, with the call that carries it. */
interface LimitCall {
  call: CallExpression;
  value: Expression;
}

/**
 * How a call sets its page size: the methods it applies to and the option or argument that holds
 * the size.
 */
interface LimitOptionSite {
  methods: ReadonlySet<string>;
  option: string;
  isOrm(access: PropertyAccessExpression, context: PerformanceRuleContext): boolean;
}

const RULE_ID = 'unbounded-list-query';
const PG_PACKAGES = ['pg', '@types/pg', 'pg-pool', '@types/pg-pool'];
const PG_RECEIVERS = ['Pool', 'Client', 'ClientBase', 'PoolClient'];
const TYPEORM_LIST_METHODS = new Set(['find', 'findBy']);
const SEQUELIZE_PACKAGES = ['sequelize', 'sequelize-typescript'];
const SEQUELIZE_LIST_METHODS = new Set(['findAll', 'findAndCountAll']);
// Query steps that keep a Mongoose find() a list of documents; `limit` among them bounds it.
const MONGOOSE_CHAIN_STEPS = new Set(['sort', 'select', 'lean', 'populate', 'skip', 'limit', 'exec']);
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
// Service queries are only judged by their text: catalogs and per-parent child lists look the same
// as large tables.
const SERVICE_QUERY_REASON =
  'The query is in a service method a handler returns, so how large the table is and whether paging is applied upstream could not be checked.';
const PAGING_PARAMETER = /pagin|page|take|limit|first|cursor|offset|skip|size/i;
const SQL_ID_ANY = /\b(?:\w+\.)?_?id\s*=\s*any\s*\(\s*\$(\d+)\s*\)/i;
const ID_LIST_OPERATORS = new Set(['in', '$in']);
const ID_LIST_REASON =
  'The id list comes from request input and no size cap on it was found; a cap applied by the caller or a validation layer could not be ruled out.';
const BUILDER_PINNED_ROW = /(?:^|\.)id\s*=\s*:/i;

function unwrap(node: Expression): Expression;
function unwrap(node: Expression | undefined): Expression | undefined;
function unwrap(node: Expression | undefined): Expression | undefined {
  return node && ts.skipOuterExpressions(node);
}

function isUniqueColumn(table: SchemaTable | undefined, name: string): boolean {
  if (!table) return name === 'id';
  return table.indexes.some((index) => index.unique && index.keys.length === 1 && index.keys[0].column === name);
}

// A fixed-size literal list or a single value; an `in` over a variable can hold any number of ids.
function isBoundedValue(value: Expression): boolean {
  const node = unwrap(value);
  if (ts.isArrayLiteralExpression(node)) return true;
  if (ts.isObjectLiteralExpression(node)) {
    return node.properties.some((property) => {
      if (!ts.isPropertyAssignment(property)) return false;
      const name = propertyName(property);
      return name === 'equals' || (name === 'in' && ts.isArrayLiteralExpression(unwrap(property.initializer)));
    });
  }
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
    const [argument] = node.arguments;
    if (node.expression.text === 'In') return !!argument && ts.isArrayLiteralExpression(unwrap(argument));
  }
  return true;
}

function isIdListOperator(property: ObjectLiteralElementLike): boolean {
  if (!ts.isPropertyAssignment(property)) return false;
  const name = propertyName(property);
  if (name) return ID_LIST_OPERATORS.has(name);
  return ts.isComputedPropertyName(property.name) && property.name.expression.getText().endsWith('.in');
}

// `id: { in: ids }`, `_id: { $in: ids }`, `id: { [Op.in]: ids }` and `id: In(ids)`: the list a
// unique column is matched against. Such a query returns at most as many rows as the list holds.
function idListOf(filter: Expression | undefined, table: SchemaTable | undefined): Expression | undefined {
  const literal = unwrap(filter);
  if (!literal || !ts.isObjectLiteralExpression(literal)) return;
  for (const property of literal.properties) {
    const name = ts.isPropertyAssignment(property) && propertyName(property);
    if (!name || !(name === '_id' || isUniqueColumn(table, name))) continue;
    const value = unwrap(property.initializer);
    if (ts.isCallExpression(value) && ts.isIdentifier(value.expression) && value.expression.text === 'In') {
      return value.arguments[0];
    }
    const operator = ts.isObjectLiteralExpression(value) ? value.properties.find(isIdListOperator) : undefined;
    if (operator && ts.isPropertyAssignment(operator)) return operator.initializer;
  }
}

function pinsUniqueRow(where: Expression | undefined, table: SchemaTable | undefined): boolean {
  const filter = unwrap(where);
  if (!filter || !ts.isObjectLiteralExpression(filter)) return false;
  return filter.properties.some((property) => {
    if (ts.isShorthandPropertyAssignment(property)) return isUniqueColumn(table, property.name.text);
    if (!ts.isPropertyAssignment(property)) return false;
    const name = propertyName(property);
    return !!name && isUniqueColumn(table, name) && isBoundedValue(property.initializer);
  });
}

// Whether an options argument carries no limit; a spread or a variable could hold one, so those are
// not judged.
function lacksLimit(options: Expression | undefined, limitName: string): boolean {
  if (!options) return true;
  const literal = unwrap(options);
  if (!ts.isObjectLiteralExpression(literal) || literal.properties.some(ts.isSpreadAssignment)) return false;
  return !literal.properties.some((property) => propertyName(property) === limitName);
}

const prismaList: ListRecogniser = (call, access, context) => {
  if (access.name.text !== 'findMany' || !prismaModelName(access.name, context.checker)) return;
  const [options] = call.arguments;
  if (!lacksLimit(options, 'take')) return;
  const table = querySite(call, context.checker)?.table;
  const where = objectProperty(unwrap(options), 'where');
  if (pinsUniqueRow(where, table)) return;
  return { label: 'findMany()', top: call, reportNode: access.name, idList: idListOf(where, table) };
};

const typeormFind: ListRecogniser = (call, access, context) => {
  if (!TYPEORM_LIST_METHODS.has(access.name.text) || !declaredInPackage(access, context.checker, ['typeorm'])) return;
  const [first] = call.arguments;
  const site = querySite(call, context.checker);
  if (!site) return;
  const where = access.name.text === 'findBy' ? first : objectProperty(unwrap(first), 'where');
  if (access.name.text !== 'findBy' && !lacksLimit(first, 'take')) return;
  if (pinsUniqueRow(where, site.table)) return;
  return {
    label: `${access.name.text}()`,
    top: call,
    reportNode: access.name,
    idList: idListOf(where, site.table),
  };
};

// `group` makes the rows one per group, so it is not judged.
const sequelizeList: ListRecogniser = (call, access, context) => {
  const method = access.name.text;
  if (!SEQUELIZE_LIST_METHODS.has(method) || !declaredInPackage(access, context.checker, SEQUELIZE_PACKAGES)) return;
  const [options] = call.arguments;
  if (!lacksLimit(options, 'limit') || objectProperty(unwrap(options), 'group')) return;
  const where = objectProperty(unwrap(options), 'where');
  if (pinsUniqueRow(where, undefined)) return;
  return { label: `${method}()`, top: call, reportNode: access.name, idList: idListOf(where, undefined) };
};

function pinsDocumentId(filter: Expression | undefined): boolean {
  const literal = unwrap(filter);
  if (!literal || !ts.isObjectLiteralExpression(literal)) return false;
  return literal.properties.some((property) => {
    if (ts.isShorthandPropertyAssignment(property)) return property.name.text === '_id';
    return (
      ts.isPropertyAssignment(property) && propertyName(property) === '_id' && isBoundedValue(property.initializer)
    );
  });
}

const mongooseList: ListRecogniser = (call, access, context) => {
  if (access.name.text !== 'find' || !declaredInPackage(access, context.checker, ['mongoose'])) return;
  const [filter, , options] = call.arguments;
  if (!lacksLimit(options, 'limit') || pinsDocumentId(filter)) return;
  let top = call;
  while (
    ts.isPropertyAccessExpression(top.parent) &&
    top.parent.expression === top &&
    ts.isCallExpression(top.parent.parent) &&
    MONGOOSE_CHAIN_STEPS.has(top.parent.name.text)
  ) {
    if (top.parent.name.text === 'limit') return;
    top = top.parent.parent;
  }
  return { label: 'find()', top, reportNode: access.name, idList: idListOf(filter, undefined) };
};

function chainSteps(expression: Expression): BuilderChain {
  const methods = new Set<string>();
  const strings: string[] = [];
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

function declarationsNamed(scope: Node, name: string): VariableDeclaration[] {
  const declared: VariableDeclaration[] = [];
  (function visit(node: Node): void {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) declared.push(node);
    ts.forEachChild(node, visit);
  })(scope);
  return declared;
}

// Builder steps made on a local after its declaration, such as `qb.take(limit)` under an `if`.
function stepsOnLocal(name: string, scope: Node): BuilderChain[] {
  const steps: BuilderChain[] = [];
  (function visit(node: Node): void {
    if (ts.isCallExpression(node)) {
      const chain = chainSteps(node);
      if (ts.isIdentifier(chain.root) && chain.root.text === name) steps.push(chain);
    }
    ts.forEachChild(node, visit);
  })(scope);
  return steps;
}

// The steps of a builder chain, following one local variable; undefined when the builder comes from
// elsewhere.
function builderSteps(
  expression: Expression,
  call: CallExpression,
): { methods: Set<string>; strings: string[] } | undefined {
  const chain = chainSteps(expression);
  const steps = [chain];
  if (!chain.methods.has('createQueryBuilder') && ts.isIdentifier(chain.root)) {
    const owner = ts.findAncestor(call, isFunctionLikeDeclaration);
    const scope = owner?.body;
    const declared = scope && declarationsNamed(scope, chain.root.text);
    if (!declared || declared.length !== 1 || !declared[0].initializer) return;
    steps.push(chainSteps(declared[0].initializer), ...stepsOnLocal(chain.root.text, scope));
  }
  const methods = new Set(steps.flatMap((step) => [...step.methods]));
  if (methods.has('createQueryBuilder')) return { methods, strings: steps.flatMap((step) => step.strings) };
}

const typeormBuilder: ListRecogniser = (call, access, context) => {
  if (access.name.text !== 'getMany' || !declaredInPackage(access, context.checker, ['typeorm'])) return;
  const builder = builderSteps(access.expression, call);
  if (!builder || [...builder.methods].some((method) => BUILDER_LIMITS.has(method))) return;
  if (builder.strings.some((text) => BUILDER_PINNED_ROW.test(text))) return;
  return { label: 'getMany()', top: call, reportNode: access.name };
};

function isAggregateSelect(selectCall: Node): boolean {
  let aggregate = false;
  (function visit(node: Node): void {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && AGGREGATES.has(node.expression.text)) {
      aggregate = true;
    }
    ts.forEachChild(node, visit);
  })(selectCall);
  return aggregate;
}

function drizzlePinsUniqueRow(whereCall: CallExpression | undefined, checker: CheckerAdapter): boolean {
  const condition = whereCall && unwrap(whereCall.arguments[0]);
  if (!condition || !ts.isCallExpression(condition) || !ts.isIdentifier(condition.expression)) return false;
  if (condition.expression.text !== 'eq' || !condition.arguments[0]) return false;
  const reference = drizzleColumn(condition.arguments[0], checker);
  return reference ? isUniqueColumn(reference.table, reference.column) : false;
}

// `inArray(users.id, ids)`: the list of ids a unique column is matched against.
function drizzleIdList(whereCall: CallExpression | undefined, checker: CheckerAdapter): Expression | undefined {
  const condition = whereCall && unwrap(whereCall.arguments[0]);
  if (!condition || !ts.isCallExpression(condition) || !ts.isIdentifier(condition.expression)) return;
  if (condition.expression.text !== 'inArray' || condition.arguments.length < 2) return;
  const reference = drizzleColumn(condition.arguments[0], checker);
  return reference && isUniqueColumn(reference.table, reference.column) ? condition.arguments[1] : undefined;
}

const drizzleList: ListRecogniser = (call, access, context) => {
  if (access.name.text !== 'from') return;
  const select = unwrap(access.expression);
  if (!ts.isCallExpression(select) || !ts.isPropertyAccessExpression(select.expression)) return;
  if (!DRIZZLE_SELECTS.has(select.expression.name.text)) return;
  if (!declaredInPackage(select.expression, context.checker, ['drizzle-orm']) || isAggregateSelect(select)) return;
  let top = call;
  const steps = new Map<string, CallExpression>();
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
  return {
    label: 'select().from()',
    top,
    reportNode: access.name,
    idList: drizzleIdList(steps.get('where'), context.checker),
  };
};

const pgList: ListRecogniser = (call, access, context) => {
  if (access.name.text !== 'query' || !context.isPackageType(access.expression, PG_PACKAGES, PG_RECEIVERS)) return;
  const text = call.arguments[0] && unwrap(call.arguments[0]);
  if (!text || !ts.isStringLiteralLike(text) || !/^\s*select\b/i.test(text.text)) return;
  if (SQL_LIMIT.test(text.text) || SQL_AGGREGATE.test(text.text) || SQL_PINNED_ROW.test(text.text)) return;
  const idParameter = SQL_ID_ANY.exec(text.text);
  const values = call.arguments[1] && unwrap(call.arguments[1]);
  const idList =
    idParameter && values && ts.isArrayLiteralExpression(values)
      ? values.elements[Number(idParameter[1]) - 1]
      : undefined;
  return { label: 'SELECT without LIMIT', top: call, reportNode: access.name, idList };
};

const recognisers: readonly ListRecogniser[] = [
  prismaList,
  typeormFind,
  typeormBuilder,
  drizzleList,
  pgList,
  sequelizeList,
  mongooseList,
];

function recognised(call: CallExpression, context: PerformanceRuleContext): ListQuery | undefined {
  const access = call.expression;
  if (!ts.isPropertyAccessExpression(access)) return;
  for (const recognise of recognisers) {
    const list = recognise(call, access, context);
    if (list) return list;
  }
}

function handlerLabel(handler: FunctionLikeDeclaration): string {
  const name = handler.name && ts.isIdentifier(handler.name) ? handler.name.text : '';
  return name ? `${name}()` : 'a request handler';
}

function message(label: string, exposure: string): string {
  return `${label} has no row limit and its rows are returned from ${exposure}, so the response, memory use and query time grow with the table. Add paging (\`take\`/\`limit\` with a stable order, or a cursor) and cap the page size. Ignore if the table is small by construction.`;
}

// A method, a function, or a function assigned to a variable (`export const list = async () =>
// ...`).
function isProjectFunction(declaration: Node): declaration is FunctionLikeDeclaration {
  if (ts.isMethodDeclaration(declaration) || ts.isFunctionDeclaration(declaration)) return true;
  return (
    (ts.isArrowFunction(declaration) || ts.isFunctionExpression(declaration)) &&
    ts.isVariableDeclaration(declaration.parent) &&
    declaration.parent.initializer === declaration
  );
}

// A project method with a body that is not itself a route: the one hop a handler's returned call is
// followed through.
function calledProjectMethod(call: CallExpression, checker: CheckerAdapter): FunctionWithBody | undefined {
  const declaration = checker.getResolvedSignature(call)?.declaration;
  if (!declaration || !isProjectFunction(declaration)) return;
  const file = declaration.getSourceFile();
  if (!hasBody(declaration) || file.isDeclarationFile || /[\\/]node_modules[\\/]/.test(file.fileName)) return;
  return isRequestHandler(declaration) ? undefined : declaration;
}

function hasBody(fn: FunctionLikeDeclaration): fn is FunctionWithBody {
  return fn.body !== undefined;
}

function definedNames(names: readonly (string | undefined)[]): string[] {
  return names.filter((name): name is string => Boolean(name));
}

// A method that takes paging parameters is assumed to apply them, even conditionally.
function acceptsPaging(method: FunctionLikeDeclaration): boolean {
  return method.parameters.some((parameter) => PAGING_PARAMETER.test(parameter.getText()));
}

const reportedServiceQueries = new WeakSet<Node>();

interface ServiceQueryReport {
  node: Node;
  list: ListQuery;
  call: CallExpression;
  handler: RequestHandlerFunction;
  context: PerformanceRuleContext;
}

function reportServiceQuery({ node, list, call, handler, context }: ServiceQueryReport): void {
  reportedServiceQueries.add(node);
  const file = node.getSourceFile();
  const { line, character } = file.getLineAndCharacterOfPosition(list.reportNode.getStart(file));
  const exposure = `the request handler ${handlerLabel(handler)}, which returns this method's result`;
  // The finding is placed on the query itself, which lives in another file than the handler being
  // scanned.
  context.report(call, RULE_ID, message(list.label, exposure), SERVICE_QUERY_REASON, {
    file: file.fileName,
    line: line + 1,
    column: character + 1,
  });
}

interface ServiceIdListCheck {
  list: ListQuery;
  call: CallExpression;
  method: FunctionWithBody;
  handler: RequestHandlerFunction;
  context: PerformanceRuleContext;
}

// An id list a service method reads from its parameters is as long as the argument the handler
// passes, so the cap is looked for on the request input and in the method. The finding sits on the
// handler's call, where the input arrives.
function checkServiceIdList({ list, call, method, handler, context }: ServiceIdListCheck): void {
  const { idList } = list;
  if (!idList) return;
  const parameterInput = (parameter: ParameterDeclaration): ParameterPosition => ({
    parameterIndex: method.parameters.indexOf(parameter),
  });
  const listName = leafName(idList);
  for (const source of traceInputs(idList, method, parameterInput)) {
    const argument = call.arguments[source.parameterIndex];
    if (!argument || hasLengthCheck(definedNames([source.name, listName]), method)) continue;
    const argumentName = leafName(argument);
    const uncapped = traceInputs(argument, handler, requestInputOf(handler)).some(
      (input) =>
        boundOf(input, handler, context) === 'unbounded' &&
        !hasLengthCheck(definedNames([input.name, argumentName]), handler),
    );
    if (uncapped) return context.report(call, RULE_ID, idListMessage(list.label), ID_LIST_REASON);
  }
}

function checkOneHop(call: CallExpression, handler: RequestHandlerFunction, context: PerformanceRuleContext): void {
  const method = calledProjectMethod(call, context.checker);
  if (!method || acceptsPaging(method) || !reachesResponse(call, handler)) return;
  (function visit(node: Node): void {
    if (ts.isCallExpression(node) && !reportedServiceQueries.has(node)) {
      const list = recognised(node, context);
      if (list && reachesResponse(list.top, method)) {
        if (list.idList) checkServiceIdList({ list, call, method, handler, context });
        else reportServiceQuery({ node, list, call, handler, context });
      }
    }
    // Callbacks inside the method do not return to the handler.
    if (!ts.isFunctionLike(node)) ts.forEachChild(node, visit);
  })(method.body);
}

// A page size read from request input with no upper cap lets one request ask for the whole table.
const SQL_LIMIT_PARAMETER = /\blimit\s+\$(\d+)/i;
const LIMIT_OPTION_SITES: readonly LimitOptionSite[] = [
  {
    methods: new Set(['findMany']),
    option: 'take',
    isOrm: (access, context) => !!prismaModelName(access.name, context.checker),
  },
  {
    methods: new Set(['find', 'findAndCount']),
    option: 'take',
    isOrm: (access, context) => declaredInPackage(access, context.checker, ['typeorm']),
  },
  {
    methods: new Set(['findAll', 'findAndCountAll']),
    option: 'limit',
    isOrm: (access, context) => declaredInPackage(access, context.checker, SEQUELIZE_PACKAGES),
  },
];
const LIMIT_CHAIN_SITES = [
  { method: 'take', packages: ['typeorm'] },
  { method: 'limit', packages: ['typeorm', 'mongoose', 'knex', 'drizzle-orm'] },
];

function optionValue(options: Expression | undefined, name: string): Expression | undefined {
  const literal = unwrap(options);
  if (!literal || !ts.isObjectLiteralExpression(literal)) return;
  for (const property of literal.properties) {
    if (propertyName(property) !== name) continue;
    if (ts.isShorthandPropertyAssignment(property)) return property.name;
    if (ts.isPropertyAssignment(property)) return property.initializer;
  }
}

function pgLimitValue(
  call: CallExpression,
  access: PropertyAccessExpression,
  context: PerformanceRuleContext,
): Expression | undefined {
  const [text, values] = call.arguments;
  const sql = unwrap(text);
  const isPg = context.isPackageType(access.expression, PG_PACKAGES, PG_RECEIVERS);
  if (!sql || !ts.isStringLiteralLike(sql) || !isPg) return;
  const parameter = SQL_LIMIT_PARAMETER.exec(sql.text);
  const list = unwrap(values);
  if (parameter && list && ts.isArrayLiteralExpression(list)) return list.elements[Number(parameter[1]) - 1];
}

// The expression holding the page size of a list call, or undefined when the call does not set one.
function limitValue(call: CallExpression, context: PerformanceRuleContext): Expression | undefined {
  const access = call.expression;
  if (!ts.isPropertyAccessExpression(access)) return;
  const method = access.name.text;
  if (method === 'query') return pgLimitValue(call, access, context);
  const chainSite = LIMIT_CHAIN_SITES.find((site) => site.method === method);
  if (chainSite && declaredInPackage(access, context.checker, chainSite.packages)) return call.arguments[0];
  const optionSite = LIMIT_OPTION_SITES.find((site) => site.methods.has(method));
  if (optionSite?.isOrm(access, context)) return optionValue(call.arguments[0], optionSite.option);
}

function limitMessage(label: string): string {
  return `${label} comes from request input with no upper cap, so one request can ask for the whole table and the response, memory use and query time grow with it. Cap the page size (e.g. \`Math.min(limit, 100)\`, or a \`max\` on the schema field).`;
}

function limitLabel(access: PropertyAccessExpression): string {
  return `The page size of ${access.name.text}()`;
}

function checkHandlerLimit(
  call: CallExpression,
  access: PropertyAccessExpression,
  value: Expression,
  handler: RequestHandlerFunction,
  context: PerformanceRuleContext,
): void {
  const statuses = traceInputs(value, handler, requestInputOf(handler)).map((source) =>
    boundOf(source, handler, context),
  );
  if (statuses.includes('unbounded')) {
    return context.report(access.name, RULE_ID, limitMessage(limitLabel(access)));
  }
  if (!statuses.includes('unknown')) return;
  const reason = 'The request value is validated by a schema whose limit on this field could not be read.';
  context.report(access.name, RULE_ID, limitMessage(limitLabel(access)), reason);
}

function limitCallsIn(method: FunctionWithBody, context: PerformanceRuleContext): LimitCall[] {
  const found: LimitCall[] = [];
  (function visit(node: Node): void {
    const value = ts.isCallExpression(node) ? limitValue(node, context) : undefined;
    if (ts.isCallExpression(node) && value) found.push({ call: node, value });
    if (!ts.isFunctionLike(node) || node === method) ts.forEachChild(node, visit);
  })(method);
  return found;
}

// One hop: a service method that sets its page size from a parameter, called with request input.
function checkLimitOneHop(
  call: CallExpression,
  handler: RequestHandlerFunction,
  context: PerformanceRuleContext,
): boolean {
  const method = calledProjectMethod(call, context.checker);
  if (!method || !hasBody(method)) return false;
  const parameterInput = (parameter: ParameterDeclaration): ParameterPosition => ({
    parameterIndex: method.parameters.indexOf(parameter),
  });
  for (const site of limitCallsIn(method, context)) {
    const open = traceInputs(site.value, method, parameterInput).filter(
      (source) => boundOf(source, method, context) !== 'bounded',
    );
    for (const source of open) {
      const argument = call.arguments[source.parameterIndex];
      if (!argument) continue;
      const requestSources = traceInputs(argument, handler, requestInputOf(handler)).map((input) => ({
        ...input,
        name: source.name,
      }));
      if (!requestSources.some((input) => boundOf(input, handler, context) === 'unbounded')) continue;
      const reason =
        'The page size is applied in a service method this request handler calls, so a cap applied inside it or by the caller could not be ruled out.';
      const label = `The page size applied by ${unwrap(call.expression).getText()}()`;
      context.report(call, RULE_ID, limitMessage(label), reason);
      return true;
    }
  }
  return false;
}

function idListMessage(label: string): string {
  return `${label} filters by an id list taken from request input with no size cap, so one request can send ids for the whole table and the response, memory use and query time grow with it. Cap the list length (for example reject more than 100 ids).`;
}

// A query matched against an id list returns at most as many rows as the list holds, so it only
// matters when a request can make that list arbitrarily long.
// `ids.length > 100` on the field or on the local the list was read into.
function hasLengthCheck(names: readonly string[], handler: FunctionWithBody): boolean {
  const text = handler.body.getText();
  return names.some((name) => {
    const escaped = name.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(String.raw`(?<![\w$])${escaped}(?![\w$])\.length\s*[<>]`).test(text);
  });
}

function checkIdList(
  list: ListQuery,
  idList: Expression,
  handler: RequestHandlerFunction,
  context: PerformanceRuleContext,
): void {
  const listName = leafName(idList);
  const sources = traceInputs(idList, handler, requestInputOf(handler));
  const uncapped = sources.some(
    (source) =>
      boundOf(source, handler, context) === 'unbounded' &&
      !hasLengthCheck(definedNames([source.name, listName]), handler),
  );
  if (uncapped) context.report(list.reportNode, RULE_ID, idListMessage(list.label), ID_LIST_REASON);
}

function check(call: CallExpression, context: PerformanceRuleContext): void {
  const handler = enclosingRequestHandler(call);
  if (!handler) return;
  const pageSize = limitValue(call, context);
  const access = call.expression;
  if (pageSize && ts.isPropertyAccessExpression(access))
    return checkHandlerLimit(call, access, pageSize, handler, context);
  if (checkLimitOneHop(call, handler, context)) return;
  const list = recognised(call, context);
  if (!list) return checkOneHop(call, handler, context);
  if (!reachesResponse(list.top, handler)) return;
  if (list.idList) return checkIdList(list, list.idList, handler, context);
  context.report(list.reportNode, RULE_ID, message(list.label, 'a request handler'));
}

export { check };
