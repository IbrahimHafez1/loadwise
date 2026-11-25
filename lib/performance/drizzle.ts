import { ts } from './compiler.js';
import { modelFallback } from './models/index.js';
import { shouldReportLoopQuery } from './query-loops.js';
import { findRepeatOwner } from './repeated.js';
import { isSequentialByDesign } from './sequential-loops.js';
import { awaitedResult, outsideWrappers } from './query-results.js';
import type {
  CallExpression,
  Expression,
  MemberName,
  Node,
  ObjectLiteralExpression,
  PropertyAccessExpression,
  PropertyAssignment,
  SignatureDeclaration,
} from 'typescript';
import type { CheckerAdapter, PerformanceRuleContext } from '../shared/types.js';
import type { DrizzleQuery, DrizzleRoot, DrizzleStep } from './types/drizzle-query.js';

/**
 * Where a Drizzle method is declared: its d.ts path, dialect module, file within it, and owning
 * type.
 */
interface DrizzleOrigin {
  path: string;
  module: string;
  file: string;
  owner: string | undefined;
}

/**
 * A Drizzle call that is awaited, returned or executed, with the builder chain it ends, if any.
 */
interface DrizzleChain {
  access: PropertyAccessExpression;
  method: string;
  possibleTerminal: boolean;
  awaited: boolean;
  asyncReturn: boolean;
  query: DrizzleQuery | undefined;
}

const databaseMethods = new Set(['select', 'selectDistinct', 'selectDistinctOn', 'update', 'delete', 'insert']);
const relationalMethods = new Set(['findFirst', 'findMany']);
const builderMethods = new Set([
  'from',
  'set',
  'values',
  'where',
  'returning',
  '$returningId',
  '$dynamic',
  'groupBy',
  'having',
  'orderBy',
  'limit',
  'offset',
  'for',
  'leftJoin',
  'rightJoin',
  'innerJoin',
  'fullJoin',
  'crossJoin',
  'onConflictDoNothing',
  'onConflictDoUpdate',
  'onDuplicateKeyUpdate',
  'prepare',
]);
const terminalMethods = new Set(['execute', 'run', 'all', 'get', 'values']);
const setOperations = new Set(['union', 'unionAll', 'intersect', 'intersectAll', 'except', 'exceptAll']);
const safeWriteSteps = new Set(['set', 'returning', 'orderBy', '$dynamic', 'prepare', ...terminalMethods]);
const drizzleFile = /\/node_modules\/drizzle-orm\/([^/]+)\/(db|session|query-builders\/[\w-]+)\.d\.[cm]?ts$/;
const dialects = new Set(['pg-core', 'mysql-core', 'sqlite-core']);

function declarationFile(name: Node, checker: CheckerAdapter): DrizzleOrigin | undefined {
  const declarations = checker.getSymbolAtLocation(name)?.declarations;
  if (!declarations?.length) return;
  let origin: DrizzleOrigin | undefined;
  for (const declaration of declarations) {
    const source = declaration.getSourceFile().fileName.replaceAll('\\', '/');
    const match = drizzleFile.exec(source);
    if (!match || (origin && source !== origin.path)) return;
    const container = declaration.parent;
    const owner = ts.isInterfaceDeclaration(container) || ts.isClassLike(container) ? container.name?.text : undefined;
    origin = { path: source, module: match[1], file: match[2], owner };
  }
  return origin;
}

const isBuilderRoot = (name: MemberName): name is DrizzleRoot =>
  ts.isPropertyAccessExpression(name.parent) && ts.isCallExpression(name.parent.parent);

// With `withSetOperations`, a chain through union/intersect/except is accepted and marked.
function directBuilder(call: CallExpression, withSetOperations: boolean): DrizzleQuery | undefined {
  const steps: DrizzleStep[] = [];
  let hasSetOperation = false;
  let current: Expression = call;
  while (ts.isCallExpression(current) && ts.isPropertyAccessExpression(current.expression)) {
    const name = current.expression.name;
    if (databaseMethods.has(name.text) || relationalMethods.has(name.text))
      return isBuilderRoot(name) ? { root: name, steps, hasSetOperation } : undefined;
    if (!builderMethods.has(name.text) && !terminalMethods.has(name.text)) {
      if (!withSetOperations || !setOperations.has(name.text)) return;
      hasSetOperation = true;
    }
    steps.push({ name: name.text, call: current });
    current = ts.skipOuterExpressions(current.expression.expression);
  }
}

const isGenerator = (declaration: SignatureDeclaration): boolean =>
  'asteriskToken' in declaration && Boolean(declaration.asteriskToken);

function returnedByAsyncFunction(call: CallExpression): boolean {
  const expression = outsideWrappers(call);
  const parent = expression.parent;
  const owner =
    ts.isArrowFunction(parent) && parent.body === expression
      ? parent
      : ts.isReturnStatement(parent) && parent.expression === expression
        ? ts.findAncestor(parent.parent, ts.isFunctionLike)
        : undefined;
  return Boolean(owner && !isGenerator(owner) && ts.getCombinedModifierFlags(owner) & ts.ModifierFlags.Async);
}

function returnsThenableWrite(call: CallExpression, checker: CheckerAdapter): boolean {
  const declarations = checker.getTypeAtLocation(call).getProperty('then')?.declarations;
  return Boolean(
    declarations?.length &&
    declarations.every(
      (declaration) =>
        (ts.isMethodSignature(declaration) || ts.isMethodDeclaration(declaration)) && !declaration.questionToken,
    ),
  );
}

// Builders chained with these never hold null in a Drizzle column definition.
const notNullBuilders = new Set(['notNull', 'primaryKey']);

// `pgTable('name', { … })` or `pgTable('name', (t) => ({ … }))`: the object literal of column
// definitions.
function columnDefinitions(tableCall: CallExpression): ObjectLiteralExpression | undefined {
  for (const argument of tableCall.arguments) {
    const body = ts.isArrowFunction(argument) ? argument.body : argument;
    if (ts.isBlock(body)) continue;
    const columns = ts.skipOuterExpressions(body);
    if (ts.isObjectLiteralExpression(columns)) return columns;
  }
}

// Reads the table's schema declaration from source (the native checker cannot read a symbol's
// type), so a column is NOT NULL only when its definition visibly chains `.notNull()` or
// `.primaryKey()`.
function isNotNullColumn(table: Expression, fieldName: string, checker: CheckerAdapter): boolean {
  const name = ts.isPropertyAccessExpression(table) ? table.name : table;
  if (!ts.isIdentifier(name)) return false;
  const symbol = checker.getSymbolAtLocation(name);
  const declaration = (symbol && symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol)
    ?.valueDeclaration;
  if (!declaration || !ts.isVariableDeclaration(declaration) || !declaration.initializer) return false;
  const tableCall = ts.skipOuterExpressions(declaration.initializer);
  const columns = ts.isCallExpression(tableCall) ? columnDefinitions(tableCall) : undefined;
  const column = columns?.properties.find(
    (property): property is PropertyAssignment =>
      ts.isPropertyAssignment(property) && ts.isIdentifier(property.name) && property.name.text === fieldName,
  );
  for (let builder: Expression | undefined = column?.initializer; builder && ts.isCallExpression(builder);) {
    if (!ts.isPropertyAccessExpression(builder.expression)) return false;
    if (notNullBuilders.has(builder.expression.name.text)) return true;
    builder = builder.expression.expression;
  }
  return false;
}

const unfilteredMutationMessage =
  'This Drizzle mutation has no effective WHERE condition, so it changes or deletes every row. Add `.where(and(scope, eq(table.id, id)))` unless a whole-table change is intended.';

function unfilteredWriteMessage(query: DrizzleQuery, checker: CheckerAdapter): string {
  if (query.root.text !== 'update') return unfilteredMutationMessage;
  const assignments = query.steps.find((step) => step.name === 'set')?.call.arguments[0];
  const fields = assignments && ts.skipOuterExpressions(assignments);
  if (!fields || !ts.isObjectLiteralExpression(fields) || fields.properties.length !== 1)
    return unfilteredMutationMessage;
  const [field] = fields.properties;
  if (!ts.isPropertyAssignment(field)) return unfilteredMutationMessage;
  const value = ts.skipOuterExpressions(field.initializer);
  if (value.kind !== ts.SyntaxKind.TrueKeyword && value.kind !== ts.SyntaxKind.FalseKeyword)
    return unfilteredMutationMessage;
  const table = query.root.parent.parent.arguments[0];
  if (table && ts.isIdentifier(field.name) && isNotNullColumn(table, field.name.text, checker)) {
    return 'This unfiltered UPDATE rewrites every row with the same boolean, including rows already holding it. The column is declared NOT NULL, so add `.where(ne(column, value))` unless unchanged rows need locks, triggers or returned values.';
  }
  return 'This unfiltered UPDATE rewrites every row with the same boolean, including rows already holding it. Add a null-safe filter such as `.where(sql`${column} is distinct from ${value}`)` unless unchanged rows need locks, triggers or returned values.';
}

function isExecutableChain(query: DrizzleQuery, explicit: boolean, awaited: boolean): boolean {
  const operation = query.root.text;
  const names = query.steps.map((step) => step.name);
  if (operation.startsWith('select') && !names.includes('from')) return false;
  if (operation === 'update' && !names.includes('set')) return false;
  if (operation === 'insert' && !names.includes('values')) return false;
  // prepare() builds a reusable statement; it runs only on a subsequent execution call.
  if (names[0] === 'prepare') return false;
  return explicit || awaited;
}

function ineffectivePredicate(expression: Expression, checker: CheckerAdapter): boolean {
  const argument = ts.skipOuterExpressions(expression);
  if (ts.isVoidExpression(argument)) return true;
  if (ts.isIdentifier(argument)) {
    return argument.text === 'undefined' && !checker.getSymbolAtLocation(argument)?.valueDeclaration;
  }
  if (
    ts.isTaggedTemplateExpression(argument) &&
    ts.isStringLiteralLike(argument.template) &&
    /^(?:true|1\s*=\s*1)$/i.test(argument.template.text.trim())
  ) {
    const declaration = checker.getResolvedSignature(argument)?.declaration;
    return (
      declaration !== undefined &&
      ts.isFunctionDeclaration(declaration) &&
      declaration.name?.text === 'sql' &&
      /\/node_modules\/drizzle-orm\/sql\/sql\.d\.[cm]?ts$/.test(
        declaration.getSourceFile().fileName.replaceAll('\\', '/'),
      )
    );
  }
  if (!ts.isCallExpression(argument)) return false;
  const declaration = checker.getResolvedSignature(argument)?.declaration;
  const declaredName =
    declaration !== undefined && ts.isFunctionDeclaration(declaration) ? declaration.name?.text : undefined;
  if (
    declaration === undefined ||
    declaredName === undefined ||
    !['and', 'or'].includes(declaredName) ||
    !/\/node_modules\/drizzle-orm\/sql\/expressions\/conditions\.d\.[cm]?ts$/.test(
      declaration.getSourceFile().fileName.replaceAll('\\', '/'),
    )
  )
    return false;
  // Drizzle discards undefined arguments in and()/or(), then returns undefined for an empty group.
  // A SQL tautology still has a value, so it cannot be treated as an absent argument to OR/AND.
  return argument.arguments.every(
    (condition: Expression) =>
      !ts.isTaggedTemplateExpression(ts.skipOuterExpressions(condition)) && ineffectivePredicate(condition, checker),
  );
}

// A Drizzle call whose result is awaited, returned or executed, with the builder chain it ends, if
// any.
function chainCall(call: CallExpression, withSetOperations: boolean): DrizzleChain | undefined {
  const access = call.expression;
  if (!ts.isPropertyAccessExpression(access)) return;
  const method = access.name.text;
  const possibleTerminal = terminalMethods.has(method);
  if (
    !possibleTerminal &&
    !builderMethods.has(method) &&
    !databaseMethods.has(method) &&
    !relationalMethods.has(method) &&
    !(withSetOperations && setOperations.has(method))
  )
    return;
  const awaited = Boolean(awaitedResult(call));
  const asyncReturn = !awaited && returnedByAsyncFunction(call);
  if (!awaited && !asyncReturn && !possibleTerminal) return;
  return { access, method, possibleTerminal, awaited, asyncReturn, query: directBuilder(call, withSetOperations) };
}

// On Drizzle insert builders, values(rows) constructs the query rather than executing it.
function isExplicitTerminal(query: DrizzleQuery, method: string, possibleTerminal: boolean): boolean {
  const isInsertValues = query.root.text === 'insert' && method === 'values' && query.steps.length === 1;
  return possibleTerminal && !isInsertValues;
}

// The chain's root resolves to a supported Drizzle dialect's database or relational query API.
function isSupportedRoot(query: DrizzleQuery, method: string, explicit: boolean, checker: CheckerAdapter): boolean {
  const origin = declarationFile(query.root, checker);
  // Without drizzle's types the dialect is unknown, so only a call that is not an explicit terminal
  // can be taken.
  if (!origin && !checker.getSymbolAtLocation(query.root)) {
    return modelFallback(query.root.parent, checker)?.orm === 'drizzle' && (!explicit || method === 'execute');
  }
  if (!origin || !dialects.has(origin.module)) return false;
  if (origin.file !== (relationalMethods.has(query.root.text) ? 'query-builders/query' : 'db')) return false;
  return !explicit || method === 'execute' || origin.module === 'sqlite-core';
}

// The executed Drizzle chain at `call`, including set operations, for checks that inspect the
// tables it reads.
function executedQuery(call: CallExpression, checker: CheckerAdapter): DrizzleQuery | undefined {
  const chain = chainCall(call, true);
  if (!chain?.query) return;
  const explicit = isExplicitTerminal(chain.query, chain.method, chain.possibleTerminal);
  if (!isExecutableChain(chain.query, explicit, chain.awaited || chain.asyncReturn)) return;
  return isSupportedRoot(chain.query, chain.method, explicit, checker) ? chain.query : undefined;
}

function checkDrizzleCall(call: CallExpression, context: PerformanceRuleContext): void {
  const chain = chainCall(call, false);
  if (!chain) return;
  const { access, method, possibleTerminal, awaited, asyncReturn, query } = chain;

  if (!query) {
    // An alias or prepared statement can still prove execution. Its earlier WHERE clauses are
    // unknown.
    if (!possibleTerminal || !context.isRepeated(call)) return;
    const origin = declarationFile(access.name, context.checker);
    if (
      !origin ||
      !(origin.file.startsWith('query-builders/') || origin.file === 'session') ||
      !/(?:PreparedQuery|SelectBase|InsertBase|DeleteBase|UpdateBase|RelationalQuery)$/.test(origin.owner ?? '')
    )
      return;
    if (
      !isSequentialByDesign(call, findRepeatOwner(call, context.checker)) &&
      shouldReportLoopQuery(call, context.checker)
    ) {
      context.report(
        access.name,
        'drizzle-query-in-loop',
        'This Drizzle statement runs once per iteration, adding a round trip per item. Batch independent work with `inArray(column, ids)` or a single `.values(rows)` insert; keep ordering and transaction semantics.',
      );
    }
    return;
  }

  const explicit = isExplicitTerminal(query, method, possibleTerminal);
  if (!isExecutableChain(query, explicit, awaited || asyncReturn)) return;
  const repeated = (!asyncReturn || explicit) && context.isRepeated(call);
  const write = query.root.text === 'update' || query.root.text === 'delete';
  if (!repeated && !write) return;
  if (!isSupportedRoot(query, method, explicit, context.checker)) return;
  if (asyncReturn && !explicit && (!write || !returnsThenableWrite(call, context.checker))) return;

  const insertRows =
    repeated && query.root.text === 'insert'
      ? query.steps.find((step) => step.name === 'values')?.call.arguments[0]
      : undefined;
  if (
    repeated &&
    !isSequentialByDesign(call, findRepeatOwner(call, context.checker)) &&
    shouldReportLoopQuery(call, context.checker, { insertRows })
  ) {
    context.report(
      query.root,
      'drizzle-query-in-loop',
      'This Drizzle query runs once per iteration, adding a round trip per item. Batch independent work with `inArray(column, ids)` or a single `.values(rows)` insert; keep ordering and transaction semantics.',
    );
  }
  if (!write || !query.steps.every((step) => step.name === 'where' || safeWriteSteps.has(step.name))) return;
  // Dynamic Drizzle builders replace an earlier WHERE clause with the last one.
  const where = query.steps.find((step) => step.name === 'where')?.call;
  if (!where?.arguments.length || ineffectivePredicate(where.arguments[0], context.checker)) {
    context.report(query.root, 'drizzle-unfiltered-write', unfilteredWriteMessage(query, context.checker));
  }
}

export { checkDrizzleCall, executedQuery };
