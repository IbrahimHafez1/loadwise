import { loadSyntax } from './compiler.cjs';
import { shouldReportLoopQuery } from './query-loops.cjs';
import { findRepeatOwner } from './repeated.cjs';
import { isSequentialByDesign } from './sequential-loops.cjs';
import {
  awaitedResult,
  clientSideQuery,
  firstElementRead,
  isDiscardedValue,
  outsideWrappers,
} from './query-results.cjs';
import type { CallExpression, Expression, Node, PropertyAccessExpression } from 'typescript';
import type { CheckerAdapter, PerformanceRuleContext } from '../shared/types.cjs';
import type { RepeatOwner } from './types/repeat-owner.cjs';
const ts = loadSyntax();

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

function literalQueryText(argument: Expression) {
  if (ts.isStringLiteralLike(argument)) return argument.text;
  if (!ts.isObjectLiteralExpression(argument)) return undefined;

  let queryText: string | undefined;
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

// Session, transaction and schema commands carry no per-item data, so there is nothing to fold into
// one query.
function leadingQueryText(argument: Expression) {
  let leading = ts.skipOuterExpressions(argument);
  while (ts.isBinaryExpression(leading) && leading.operatorToken.kind === ts.SyntaxKind.PlusToken)
    leading = ts.skipOuterExpressions(leading.left);
  if (ts.isTemplateExpression(leading)) return leading.head.text;
  return ts.isStringLiteralLike(leading) ? leading.text : literalQueryText(argument);
}

function runsNonBatchableCommand(argument: Expression) {
  const text = leadingQueryText(argument);
  return text !== undefined && nonBatchableCommand.test(text);
}

// `for (const statement of statements) client.query(statement)`: the SQL text is the item itself,
// so there is no per-item value to fold into a parameter array.
function runsLoopItemAsSql(call: CallExpression, checker: CheckerAdapter) {
  const argument = ts.skipOuterExpressions(call.arguments[0]);
  if (!ts.isIdentifier(argument)) return false;
  const declaration = checker.getSymbolAtLocation(argument)?.valueDeclaration;
  return (
    !!declaration &&
    ts.isVariableDeclaration(declaration) &&
    ts.isVariableDeclarationList(declaration.parent) &&
    ts.isForOfStatement(declaration.parent.parent) &&
    declaration.parent.parent.statement.pos <= call.pos &&
    call.end <= declaration.parent.parent.statement.end
  );
}

// A loop that applies raw SQL items in order (a migration runner) also writes its ledger row in
// that order. Memoized per loop so many queries in one loop body do not each rescan it.
const orderedStatementOwners = new WeakMap<RepeatOwner, boolean>();

function appliesOrderedStatements(owner: RepeatOwner, checker: CheckerAdapter) {
  let result = orderedStatementOwners.get(owner);
  if (result === undefined) {
    result = scansOrderedStatements(owner, checker);
    orderedStatementOwners.set(owner, result);
  }
  return result;
}

function scansOrderedStatements(owner: RepeatOwner, checker: CheckerAdapter) {
  const scope = ts.isFunctionLike(owner) ? owner.body : owner.statement;
  if (!scope) return false;
  return !!(function visit(node: Node): boolean | undefined {
    if (ts.isFunctionLike(node)) return false;
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'query' &&
      node.arguments.length &&
      runsLoopItemAsSql(node, checker)
    )
      return true;
    return ts.forEachChild(node, visit);
  })(scope);
}

function accessedProperty(receiver: Expression, name: string): PropertyAccessExpression | undefined {
  const expression = outsideWrappers(receiver);
  const access = expression.parent;
  if (ts.isPropertyAccessExpression(access) && access.expression === expression && access.name.text === name)
    return access;
}

function directRowCount(rows: Expression): PropertyAccessExpression | undefined {
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

function readsProjectedField(queryArgument: Expression, projectionText: string, field: string): boolean {
  if (
    ts.isObjectLiteralExpression(queryArgument) &&
    !queryArgument.properties.every(
      (property) =>
        property.name !== undefined &&
        !ts.isComputedPropertyName(property.name) &&
        rowObjectOptions.has(property.name.text),
    )
  )
    return false;
  if (!/^[a-z_][a-z0-9_$]*$/.test(field)) return false;
  return (
    projectionText === '*' ||
    projectionText.split(',').some((column) => column.trim().split('.').at(-1)?.toLowerCase() === field)
  );
}

function checkPostgresCall(call: CallExpression, context: PerformanceRuleContext) {
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

  const owner = repeated ? findRepeatOwner(call, context.checker) : undefined;
  if (
    repeated &&
    !runsNonBatchableCommand(call.arguments[0]) &&
    !runsLoopItemAsSql(call, context.checker) &&
    !(owner && appliesOrderedStatements(owner, context.checker)) &&
    !isSequentialByDesign(call, owner) &&
    shouldReportLoopQuery(call, context.checker)
  ) {
    context.report(
      method.name,
      'pg-query-in-loop',
      'This pg query can run once per iteration, adding a round trip per item. Batch independent reads into one query such as `WHERE id = ANY($1)` and map rows by key; keep scope predicates and the transaction client.',
    );
  }
  if (count || first || clientSide) {
    const queryText = literalQueryText(call.arguments[0]);
    if (!queryText) return;
    if (count && countRead.test(queryText)) {
      context.report(
        count.name,
        'pg-count-materialization',
        'This SELECT transfers every matching row just to count them. Use `SELECT count(*) AS total ...` and convert the bigint string result with `Number()` or `BigInt()`.',
      );
    }
    if (first && firstRead.test(queryText)) {
      context.report(
        first.argumentExpression,
        'pg-first-materialization',
        'This SELECT transfers every matching row but only the first is read. Add `LIMIT 1` to the query and keep a deterministic `ORDER BY` when the chosen row matters.',
      );
    }
    if (clientSide) {
      const query = firstRead.exec(queryText);
      const projectionText = query?.groups?.projection;
      if (projectionText === undefined || !readsProjectedField(call.arguments[0], projectionText, clientSide.field))
        return;
      if (clientSide.method.text === 'filter') {
        context.report(
          clientSide.method,
          'pg-filter-materialization',
          'This SELECT transfers rows that JavaScript then filters by one field. Move the test into SQL with `WHERE field = $1`; check type, NULL and collation semantics match the JavaScript comparison.',
        );
      } else {
        context.report(
          clientSide.method,
          'pg-top-k-materialization',
          'This SELECT transfers all rows that JavaScript then sorts and truncates. Use `ORDER BY column DESC, id ASC LIMIT $1` in SQL; keep numeric conversion, NULL ordering and tie-breaking.',
        );
      }
    }
  }
}

export { checkPostgresCall };
