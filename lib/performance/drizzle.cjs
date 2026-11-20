'use strict';

const { syntax: ts } = require('./compiler.cjs');
const { shouldReportLoopQuery } = require('./query-loops.cjs');
const { findRepeatOwner } = require('./repeated.cjs');
const { isSequentialByDesign } = require('./sequential-loops.cjs');
const { awaitedResult, outsideWrappers } = require('./query-results.cjs');

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

function declarationFile(name, checker) {
  const declarations = checker.getSymbolAtLocation(name)?.declarations;
  if (!declarations?.length) return;
  let origin;
  for (const declaration of declarations) {
    const source = declaration.getSourceFile().fileName.replaceAll('\\', '/');
    const match = drizzleFile.exec(source);
    if (!match || (origin && source !== origin.path)) return;
    origin = { path: source, module: match[1], file: match[2], owner: declaration.parent?.name?.text };
  }
  return origin;
}

// With `withSetOperations`, a chain through union/intersect/except is accepted and marked.
function directBuilder(call, withSetOperations) {
  const steps = [];
  let hasSetOperation = false;
  let current = call;
  while (ts.isCallExpression(current) && ts.isPropertyAccessExpression(current.expression)) {
    const name = current.expression.name;
    if (databaseMethods.has(name.text) || relationalMethods.has(name.text))
      return { root: name, steps, hasSetOperation };
    if (!builderMethods.has(name.text) && !terminalMethods.has(name.text)) {
      if (!withSetOperations || !setOperations.has(name.text)) return;
      hasSetOperation = true;
    }
    steps.push({ name: name.text, call: current });
    current = ts.skipOuterExpressions(current.expression.expression);
  }
}

function returnedByAsyncFunction(call) {
  const expression = outsideWrappers(call);
  const parent = expression.parent;
  const owner =
    ts.isArrowFunction(parent) && parent.body === expression
      ? parent
      : ts.isReturnStatement(parent) && parent.expression === expression
        ? ts.findAncestor(parent.parent, ts.isFunctionLike)
        : undefined;
  return owner && !owner.asteriskToken && ts.getCombinedModifierFlags(owner) & ts.ModifierFlags.Async;
}

function returnsThenableWrite(call, checker) {
  const declarations = checker.getTypeAtLocation(call).getProperty('then')?.declarations;
  return (
    declarations?.length &&
    declarations.every(
      (declaration) =>
        !declaration.questionToken &&
        (declaration.kind === ts.SyntaxKind.MethodSignature || declaration.kind === ts.SyntaxKind.MethodDeclaration),
    )
  );
}

// Builders chained with these never hold null in a Drizzle column definition.
const notNullBuilders = new Set(['notNull', 'primaryKey']);

// `pgTable('name', { … })` or `pgTable('name', (t) => ({ … }))`: the object literal of column definitions.
function columnDefinitions(tableCall) {
  for (const argument of tableCall.arguments) {
    const body = ts.isArrowFunction(argument) ? argument.body : argument;
    const columns = ts.skipOuterExpressions(body);
    if (ts.isObjectLiteralExpression(columns)) return columns;
  }
}

// Reads the table's schema declaration from source (the native checker cannot read a symbol's type), so a column
// is NOT NULL only when its definition visibly chains `.notNull()` or `.primaryKey()`.
function isNotNullColumn(table, fieldName, checker) {
  const name = ts.isPropertyAccessExpression(table) ? table.name : table;
  if (!ts.isIdentifier(name)) return false;
  const symbol = checker.getSymbolAtLocation(name);
  const declaration = (symbol?.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol)
    ?.valueDeclaration;
  if (!declaration || !ts.isVariableDeclaration(declaration) || !declaration.initializer) return false;
  const tableCall = ts.skipOuterExpressions(declaration.initializer);
  const columns = ts.isCallExpression(tableCall) && columnDefinitions(tableCall);
  const column = columns?.properties.find(
    (property) =>
      ts.isPropertyAssignment(property) && ts.isIdentifier(property.name) && property.name.text === fieldName,
  );
  for (let builder = column?.initializer; builder && ts.isCallExpression(builder);) {
    if (!ts.isPropertyAccessExpression(builder.expression)) return false;
    if (notNullBuilders.has(builder.expression.name.text)) return true;
    builder = builder.expression.expression;
  }
  return false;
}

function unfilteredWriteMessage(query, checker) {
  if (query.root.text === 'update') {
    const assignments = query.steps.find((step) => step.name === 'set')?.call.arguments[0];
    const fields = assignments && ts.skipOuterExpressions(assignments);
    const field =
      fields && ts.isObjectLiteralExpression(fields) && fields.properties.length === 1 && fields.properties[0];
    if (field && ts.isPropertyAssignment(field)) {
      const value = ts.skipOuterExpressions(field.initializer);
      if (value.kind === ts.SyntaxKind.TrueKeyword || value.kind === ts.SyntaxKind.FalseKeyword) {
        const table = query.root.parent.parent.arguments[0];
        if (table && ts.isIdentifier(field.name) && isNotNullColumn(table, field.name.text, checker)) {
          return 'This unfiltered UPDATE rewrites every row with the same boolean, including rows already holding it. The column is declared NOT NULL, so add `.where(ne(column, value))` unless unchanged rows need locks, triggers or returned values.';
        }
        return 'This unfiltered UPDATE rewrites every row with the same boolean, including rows already holding it. Add a null-safe filter such as `.where(sql`${column} is distinct from ${value}`)` unless unchanged rows need locks, triggers or returned values.';
      }
    }
  }
  return 'This Drizzle mutation has no effective WHERE condition, so it changes or deletes every row. Add `.where(and(scope, eq(table.id, id)))` unless a whole-table change is intended.';
}

function isExecutableChain(query, explicit, awaited) {
  const operation = query.root.text;
  const names = query.steps.map((step) => step.name);
  if (operation.startsWith('select') && !names.includes('from')) return false;
  if (operation === 'update' && !names.includes('set')) return false;
  if (operation === 'insert' && !names.includes('values')) return false;
  // prepare() builds a reusable statement; it runs only on a subsequent execution call.
  if (names[0] === 'prepare') return false;
  return explicit || awaited;
}

function ineffectivePredicate(expression, checker) {
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
      declaration?.name?.text === 'sql' &&
      /\/node_modules\/drizzle-orm\/sql\/sql\.d\.[cm]?ts$/.test(
        declaration.getSourceFile().fileName.replaceAll('\\', '/'),
      )
    );
  }
  if (!ts.isCallExpression(argument)) return false;
  const declaration = checker.getResolvedSignature(argument)?.declaration;
  if (
    !['and', 'or'].includes(declaration?.name?.text) ||
    !/\/node_modules\/drizzle-orm\/sql\/expressions\/conditions\.d\.[cm]?ts$/.test(
      declaration.getSourceFile().fileName.replaceAll('\\', '/'),
    )
  )
    return false;
  // Drizzle discards undefined arguments in and()/or(), then returns undefined for an empty group.
  // A SQL tautology still has a value, so it cannot be treated as an absent argument to OR/AND.
  return argument.arguments.every(
    (condition) =>
      !ts.isTaggedTemplateExpression(ts.skipOuterExpressions(condition)) && ineffectivePredicate(condition, checker),
  );
}

// A Drizzle call whose result is awaited, returned or executed, with the builder chain it ends, if any.
function chainCall(call, withSetOperations) {
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
function isExplicitTerminal({ query, method, possibleTerminal }) {
  const isInsertValues = query.root.text === 'insert' && method === 'values' && query.steps.length === 1;
  return possibleTerminal && !isInsertValues;
}

// The chain's root resolves to a supported Drizzle dialect's database or relational query API.
function isDrizzleRoot(query, method, explicit, checker) {
  const origin = declarationFile(query.root, checker);
  if (!origin || !dialects.has(origin.module)) return false;
  if (origin.file !== (relationalMethods.has(query.root.text) ? 'query-builders/query' : 'db')) return false;
  return !explicit || method === 'execute' || origin.module === 'sqlite-core';
}

// The executed Drizzle chain at `call`, including set operations, for checks that inspect the tables it reads.
function executedQuery(call, checker) {
  const chain = chainCall(call, true);
  if (!chain?.query) return;
  const explicit = isExplicitTerminal(chain);
  if (!isExecutableChain(chain.query, explicit, chain.awaited || chain.asyncReturn)) return;
  return isDrizzleRoot(chain.query, chain.method, explicit, checker) ? chain.query : undefined;
}

function checkDrizzleCall(call, context) {
  const chain = chainCall(call, false);
  if (!chain) return;
  const { access, method, possibleTerminal, awaited, asyncReturn, query } = chain;

  if (!query) {
    // An alias or prepared statement can still prove execution. Its earlier WHERE clauses are unknown.
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

  const explicit = isExplicitTerminal(chain);
  if (!isExecutableChain(query, explicit, awaited || asyncReturn)) return;
  const repeated = (!asyncReturn || explicit) && context.isRepeated(call);
  const write = query.root.text === 'update' || query.root.text === 'delete';
  if (!repeated && !write) return;
  if (!isDrizzleRoot(query, method, explicit, context.checker)) return;
  if (asyncReturn && !explicit && (!write || !returnsThenableWrite(call, context.checker))) return;

  const insertRows =
    repeated && query.root.text === 'insert' && query.steps.find((step) => step.name === 'values')?.call.arguments[0];
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

module.exports = { checkDrizzleCall, executedQuery };
