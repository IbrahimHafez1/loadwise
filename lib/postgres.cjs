'use strict';

const { syntax: ts } = require('./compiler.cjs');
const { shouldReportLoopQuery } = require('./query-loops.cjs');
const { findRepeatOwner } = require('./repeated.cjs');
const { isSequentialByDesign } = require('./sequential-loops.cjs');
const {
  awaitedResult,
  clientSideQuery,
  firstElementRead,
  isDiscardedValue,
  outsideWrappers,
} = require('./query-results.cjs');

const PG_PACKAGES = ['pg', '@types/pg', 'pg-pool', '@types/pg-pool'];
const PG_RECEIVERS = ['Pool', 'Client', 'ClientBase', 'PoolClient'];

// A deliberately small SQL grammar excludes LIMIT, locks, functions and multiple statements.
const identifier = '[a-z_][a-z0-9_$]*';
const qualifiedName = `${identifier}(?:\\.${identifier})?`;
const projection = `(?:\\*|${qualifiedName}(?:\\s*,\\s*${qualifiedName})*)`;
const parameterFilter = `${qualifiedName}\\s*(?:=|<>|!=|<=|>=|<|>)\\s*\\$[1-9]\\d*`;
const selectFrom =
  `^\\s*select\\s+(?<projection>${projection})\\s+from\\s+${qualifiedName}` +
  `(?:\\s+where\\s+${parameterFilter}(?:\\s+and\\s+${parameterFilter})*)?`;
const statementEnd = '\\s*(?:;\\s*)?$';
const sortColumn = `${qualifiedName}(?:\\s+(?:asc|desc))?(?:\\s+nulls\\s+(?:first|last))?`;
const orderBy = `(?:\\s+order\\s+by\\s+${sortColumn}(?:\\s*,\\s*${sortColumn})*)?`;
const countRead = new RegExp(selectFrom + statementEnd, 'i');
const firstRead = new RegExp(selectFrom + orderBy + statementEnd, 'i');
const nonBatchableCommand =
  /^\s*(?:set|reset|begin|start|commit|end|abort|rollback|savepoint|release|create|drop|alter|truncate|explain|listen|unlisten|notify)\b/i;
const rowObjectOptions = new Set(['text', 'values', 'name']);

function literalQueryText(argument) {
  if (ts.isStringLiteralLike(argument)) return argument.text;
  if (!ts.isObjectLiteralExpression(argument)) return undefined;

  let queryText;
  for (const property of argument.properties) {
    if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) return undefined;
    if (ts.isComputedPropertyName(property.name)) return undefined;
    // A custom Query object submits its own work and can return its own result shape.
    if (property.name.text === 'submit' || property.name.text === '__proto__') return undefined;
    if (property.name.text !== 'text') continue;
    if (!ts.isPropertyAssignment(property) || !ts.isStringLiteralLike(property.initializer)) return undefined;
    queryText = property.initializer.text;
  }
  return queryText;
}

// Session, transaction and schema commands carry no per-item data, so there is nothing to fold into one query.
function leadingQueryText(argument) {
  let leading = ts.skipOuterExpressions(argument);
  while (ts.isBinaryExpression(leading) && leading.operatorToken.kind === ts.SyntaxKind.PlusToken)
    leading = ts.skipOuterExpressions(leading.left);
  if (ts.isTemplateExpression(leading)) return leading.head.text;
  return ts.isStringLiteralLike(leading) ? leading.text : literalQueryText(argument);
}

function runsNonBatchableCommand(argument) {
  const text = leadingQueryText(argument);
  return text !== undefined && nonBatchableCommand.test(text);
}

function accessedProperty(receiver, name) {
  const expression = outsideWrappers(receiver);
  const access = expression.parent;
  if (ts.isPropertyAccessExpression(access) && access.expression === expression && access.name.text === name)
    return access;
}

function directRowCount(rows) {
  const length = accessedProperty(rows, 'length');
  if (!length) return undefined;

  const countUsage = outsideWrappers(length);
  if (ts.isAssignmentTarget(countUsage) || isDiscardedValue(countUsage)) return undefined;
  const parent = countUsage.parent;
  if (
    ts.isReturnStatement(parent) ||
    ts.isArrowFunction(parent) ||
    ts.isVariableDeclaration(parent) ||
    ts.isPropertyAssignment(parent) ||
    (ts.isCallExpression(parent) && parent.arguments.includes(countUsage))
  )
    return length;
  if (
    ts.isBinaryExpression(parent) &&
    (parent.right === countUsage || parent.operatorToken.kind !== ts.SyntaxKind.CommaToken)
  )
    return length;
  return undefined;
}

function readsProjectedField(queryArgument, projectionText, field) {
  if (
    ts.isObjectLiteralExpression(queryArgument) &&
    !queryArgument.properties.every((property) => property.name && rowObjectOptions.has(property.name.text))
  )
    return false;
  if (!/^[a-z_][a-z0-9_$]*$/.test(field)) return false;
  return (
    projectionText === '*' ||
    projectionText.split(',').some((column) => column.trim().split('.').at(-1).toLowerCase() === field)
  );
}

function checkPostgresCall(call, context) {
  const method = call.expression;
  if (!ts.isPropertyAccessExpression(method) || method.name.text !== 'query' || !call.arguments.length) return;

  const repeated = context.isRepeated(call);
  const awaited = awaitedResult(call);
  const rows = awaited && accessedProperty(awaited, 'rows');
  const count = rows && directRowCount(rows);
  const first = rows && firstElementRead(rows);
  const clientSide = rows && clientSideQuery(rows);
  if (!repeated && !count && !first && !clientSide) return;
  if (!context.isPackageType(method.expression, PG_PACKAGES, PG_RECEIVERS)) return;

  if (
    repeated &&
    !runsNonBatchableCommand(call.arguments[0]) &&
    !isSequentialByDesign(call, findRepeatOwner(call, context.checker)) &&
    shouldReportLoopQuery(call, context.checker)
  ) {
    context.report(
      method.name,
      'pg-query-in-loop',
      'This pg query can run once per iteration. Consider batching independent operations into one parameterized query.',
    );
  }
  if (count || first || clientSide) {
    const queryText = literalQueryText(call.arguments[0]);
    if (!queryText) return;
    if (count && countRead.test(queryText)) {
      context.report(
        count.name,
        'pg-count-materialization',
        'This SELECT transfers matching rows just to count them. Consider COUNT(*) in SQL and handle its bigint result.',
      );
    }
    if (first && firstRead.test(queryText)) {
      context.report(
        first.argumentExpression,
        'pg-first-materialization',
        'This SELECT transfers matching rows to read only the first. Use LIMIT 1 and preserve a deterministic ORDER BY when the chosen row matters.',
      );
    }
    if (clientSide) {
      const query = firstRead.exec(queryText);
      if (!query || !readsProjectedField(call.arguments[0], query.groups.projection, clientSide.field)) return;
      if (clientSide.method.text === 'filter') {
        context.report(
          clientSide.method,
          'pg-filter-materialization',
          'This SELECT transfers rows before filtering a field against a literal. Consider a parameterized WHERE predicate and preserve type, NULL and collation semantics.',
        );
      } else {
        context.report(
          clientSide.method,
          'pg-top-k-materialization',
          'This SELECT transfers rows before sorting and keeping a prefix. For a numeric column, consider ORDER BY and LIMIT in SQL. Preserve numeric conversion, NULL ordering and tie-breaking.',
        );
      }
    }
  }
}

module.exports = { checkPostgresCall };
