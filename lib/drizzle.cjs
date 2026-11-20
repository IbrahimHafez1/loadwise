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

function directBuilder(call, scopes) {
  const steps = [];
  let hasSetOperation = false;
  let current = call;
  while (ts.isCallExpression(current) && ts.isPropertyAccessExpression(current.expression)) {
    const name = current.expression.name;
    if (databaseMethods.has(name.text) || relationalMethods.has(name.text))
      return { root: name, steps, hasSetOperation };
    if (!builderMethods.has(name.text) && !terminalMethods.has(name.text)) {
      if (!scopes || !setOperations.has(name.text)) return;
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

function unfilteredWriteMessage(query) {
  if (query.root.text === 'update') {
    const assignments = query.steps.find((step) => step.name === 'set')?.call.arguments[0];
    const fields = assignments && ts.skipOuterExpressions(assignments);
    const field =
      fields && ts.isObjectLiteralExpression(fields) && fields.properties.length === 1 && fields.properties[0];
    if (field && ts.isPropertyAssignment(field)) {
      const value = ts.skipOuterExpressions(field.initializer);
      if (value.kind === ts.SyntaxKind.TrueKeyword || value.kind === ts.SyntaxKind.FalseKeyword) {
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

function checkDrizzleCall(call, context, scopes) {
  const access = call.expression;
  if (!ts.isPropertyAccessExpression(access)) return;
  const method = access.name.text;
  const possibleTerminal = terminalMethods.has(method);
  if (
    !possibleTerminal &&
    !builderMethods.has(method) &&
    !databaseMethods.has(method) &&
    !relationalMethods.has(method) &&
    !(scopes && setOperations.has(method))
  )
    return;
  const awaited = Boolean(awaitedResult(call));
  const asyncReturn = !awaited && returnedByAsyncFunction(call);
  if (!awaited && !asyncReturn && !possibleTerminal) return;
  const query = directBuilder(call, scopes);

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

  // On Drizzle insert builders, values(rows) constructs the query.
  const isInsertValues = query.root.text === 'insert' && method === 'values' && query.steps.length === 1;
  const explicit = possibleTerminal && !isInsertValues;
  if (!isExecutableChain(query, explicit, awaited || asyncReturn)) return;
  const repeated = (!asyncReturn || explicit) && context.isRepeated(call);
  const write = query.root.text === 'update' || query.root.text === 'delete';
  if (!repeated && !write && !scopes) return;
  const origin = declarationFile(query.root, context.checker);
  if (!origin || !dialects.has(origin.module)) return;
  if (origin.file !== (relationalMethods.has(query.root.text) ? 'query-builders/query' : 'db')) return;
  if (explicit && method !== 'execute' && origin.module !== 'sqlite-core') return;
  if (scopes) require('./drizzle-policy.cjs').checkDrizzlePolicy(query, context, scopes);
  if (query.hasSetOperation || (asyncReturn && !explicit && (!write || !returnsThenableWrite(call, context.checker))))
    return;

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
    context.report(query.root, 'drizzle-unfiltered-write', unfilteredWriteMessage(query));
  }
}

module.exports = { checkDrizzleCall };
