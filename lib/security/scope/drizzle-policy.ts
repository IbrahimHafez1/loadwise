// `drizzle-scope-unverified`: an executed Drizzle query over a table that backend-perf.policy.json
// protects must constrain the configured column to the trusted authorization function. Needs
// resolved drizzle-orm types.
import { ts } from '../../performance/compiler.js';
import { executedQuery } from '../../performance/drizzle.js';
import type { CallExpression, Expression, NamedDeclaration, Node } from 'typescript';
import type { DrizzleQuery } from '../../performance/types/drizzle-query.js';
import type { CheckerAdapter, ScopePolicy, SecurityRuleContext } from '../../shared/types.js';
import type { SecurityCheckModule } from '../types/security-check.js';
import { scopeEvidence } from '../../performance/scope-evidence.js';
const { fields, importedMember, plain, scalar, scopedData, scopeFixEvidence, trustedValue } = scopeEvidence();
const conditionDeclaration = /\/node_modules\/drizzle-orm\/sql\/expressions\/conditions\.d\.[cm]?ts$/;
const operators = new Set(['eq', 'ne', 'and', 'or']);
type ScopePolicies = Readonly<Record<string, ScopePolicy>>;

const supportedSteps = new Set([
  'from',
  'set',
  'where',
  'returning',
  '$dynamic',
  'orderBy',
  'limit',
  'offset',
  'execute',
  'run',
  'all',
  'get',
  'values',
]);

// A declaration node that may carry a name, such as `declare function eq` or `declare const eq`.
function isNamedDeclaration(node: Node): node is NamedDeclaration {
  return 'name' in node;
}

function protectedTable(expression: Expression, scopes: ScopePolicies, checker: CheckerAdapter): string | undefined {
  let node: Expression | undefined = plain(expression);
  const visited = new Set<Node>();
  while (node) {
    const binding = importedMember(node, checker);
    if (binding && Object.hasOwn(scopes, binding.exported) && scopes[binding.exported].tableFrom === binding.from) {
      return binding.exported;
    }
    if (!ts.isIdentifier(node)) return;
    const variable: Node | undefined = checker.getSymbolAtLocation(node)?.valueDeclaration;
    if (
      !variable ||
      !ts.isVariableDeclaration(variable) ||
      visited.has(variable) ||
      !(variable.parent.flags & ts.NodeFlags.Const)
    )
      return;
    visited.add(variable);
    node = plain(variable.initializer);
  }
}

function genuineOperator(call: CallExpression, checker: CheckerAdapter): string | undefined {
  const target = plain(call.expression);
  const imported = importedMember(target, checker);
  if (!imported || !/^drizzle-orm(?:\/|$)/.test(imported.from) || !operators.has(imported.exported)) return;
  const name = ts.isPropertyAccessExpression(target) ? target.name : target;
  if (!ts.isIdentifier(name)) return;
  let symbol = checker.getSymbolAtLocation(name);
  if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
  if (!symbol || symbol.name !== imported.exported || !symbol.declarations?.length) return;
  if (
    symbol.declarations.every((declaration) => {
      const name = isNamedDeclaration(declaration) ? declaration.name : undefined;
      return (
        !!name &&
        (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) &&
        name.text === symbol.name &&
        conditionDeclaration.test(declaration.getSourceFile().fileName.replaceAll('\\', '/'))
      );
    })
  )
    return symbol.name;
}

function tableColumn(
  expression: Expression,
  table: string,
  scopes: ScopePolicies,
  checker: CheckerAdapter,
): string | undefined {
  const access = plain(expression);
  if (!access) return;
  const dot = ts.isPropertyAccessExpression(access);
  if (!dot && !ts.isElementAccessExpression(access)) return;
  const name = dot
    ? access.name
    : ts.isStringLiteralLike(access.argumentExpression)
      ? access.argumentExpression
      : undefined;
  if (!name || protectedTable(access.expression, scopes, checker) !== table) return;
  const symbol = checker.getSymbolAtLocation(name);
  const type = checker.getTypeAtLocation(access);
  if (symbol && !(type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Never))) return name.text;
}

function scopedCondition(
  expression: Expression,
  table: string,
  scopes: ScopePolicies,
  checker: CheckerAdapter,
): boolean | undefined {
  const predicate = plain(expression);
  if (!predicate || !ts.isCallExpression(predicate) || ts.isOptionalChain(predicate)) return;
  const operator = genuineOperator(predicate, checker);
  const parts = predicate.arguments;
  if (operator === 'eq' || operator === 'ne') {
    if (parts.length !== 2) return;
    const column = tableColumn(parts[0], table, scopes, checker);
    const value = plain(parts[1]);
    if (
      !column ||
      ts.isAsExpression(value) ||
      value.kind === ts.SyntaxKind.TypeAssertionExpression ||
      !scalar(checker.getTypeAtLocation(value), true)
    )
      return;
    return operator === 'eq' && column === scopes[table].field && trustedValue(value, scopes[table], checker);
  }
  if (!(operator === 'and' || operator === 'or') || !parts.length) return;
  const terms = parts.map((part) => scopedCondition(part, table, scopes, checker));
  // Opaque SQL fragments do not establish the boolean structure of the final SQL.
  if (terms.includes(undefined)) return;
  return operator === 'and' ? terms.some(Boolean) : terms.every(Boolean);
}

function simpleProjection(
  call: CallExpression,
  table: string,
  scopes: ScopePolicies,
  checker: CheckerAdapter,
): boolean {
  if (call.arguments.length === 0) return true;
  const entries = fields(call.arguments[0]);
  return (
    call.arguments.length === 1 &&
    entries !== undefined &&
    [...entries.values()].every((value) => tableColumn(value, table, scopes, checker))
  );
}

function missingEvidence(
  query: DrizzleQuery,
  context: SecurityRuleContext,
  table: string,
  scopes: ScopePolicies,
): string | undefined {
  const { root, steps } = query;
  const checker = context.checker;
  if (!context.strictNullChecks) return 'Enable strictNullChecks to verify the scope value.';
  if (!['select', 'update', 'delete'].includes(root.text) || steps.some((step) => !supportedSteps.has(step.name))) {
    return 'Review this query shape, including joined tables, projections and statement branches.';
  }
  const from = steps.filter((step) => step.name === 'from');
  if (root.text === 'select' && (from.length !== 1 || !simpleProjection(root.parent.parent, table, scopes, checker))) {
    return 'Only direct projections of this table have a verified scope.';
  }
  if (root.text !== 'select' && from.length) return 'Verify each table involved in this write.';
  for (const step of steps) {
    if (step.name === 'orderBy' && !step.call.arguments.every((value) => tableColumn(value, table, scopes, checker))) {
      return 'Review ordering expressions outside the protected table.';
    }
    if (step.name === 'limit' || step.name === 'offset') {
      const value = plain(step.call.arguments[0]);
      if (
        step.call.arguments.length !== 1 ||
        !value ||
        !(checker.getTypeAtLocation(value).flags & ts.TypeFlags.NumberLike) ||
        ts.isAsExpression(value) ||
        value.kind === ts.SyntaxKind.TypeAssertionExpression
      ) {
        return 'Review pagination expressions that cannot be verified as numeric values.';
      }
    }
  }
  if (steps.some((step) => step.name === 'returning' && !simpleProjection(step.call, table, scopes, checker))) {
    return 'Verify the scope of the returned data.';
  }
  // Drizzle overwrites the WHERE when a dynamic builder receives another where() call.
  const where = steps.find((step) => step.name === 'where')?.call;
  if (where?.arguments.length !== 1 || !scopedCondition(where.arguments[0], table, scopes, checker)) {
    const field = scopes[table].field;
    const column = /^[A-Za-z_][A-Za-z0-9_]*$/.test(field)
      ? table + '.' + field
      : table + '[' + JSON.stringify(field) + ']';
    return 'Constrain the effective WHERE using eq(' + column + ', <authorized scope>).';
  }
  if (root.text === 'update') {
    const assignments = steps.filter((step) => step.name === 'set');
    if (
      assignments.length !== 1 ||
      assignments[0].call.arguments.length !== 1 ||
      !scopedData(assignments[0].call.arguments[0], scopes[table], checker, false, false)
    ) {
      return 'Verify the update preserves the authorized scope using explicit scalar assignments.';
    }
  }
}

function checkDrizzlePolicy(query: DrizzleQuery, context: SecurityRuleContext, scopes: ScopePolicies) {
  const candidates: Expression[] = [];
  if (['update', 'delete', 'insert'].includes(query.root.text)) candidates.push(query.root.parent.parent.arguments[0]);
  for (const step of query.steps) {
    if (step.name === 'from' || step.name.endsWith('Join')) candidates.push(step.call.arguments[0]);
  }
  const tables = new Set(
    candidates.map((node) => protectedTable(node, scopes, context.checker)).filter((table): table is string => !!table),
  );
  for (const table of tables) {
    const reason = missingEvidence(query, context, table, scopes);
    if (reason)
      context.report(
        query.root,
        'drizzle-scope-unverified',
        table + ' scope policy: ' + reason,
        undefined,
        scopeFixEvidence(query.root, scopes[table], context.checker),
      );
  }
}

function checkDrizzleScope(call: CallExpression, context: SecurityRuleContext) {
  const scopes = context.policy?.drizzleScopes;
  if (!scopes) return;
  const query = executedQuery(call, context.checker);
  if (query) checkDrizzlePolicy(query, context, scopes);
}

export const checks: SecurityCheckModule['checks'] = { CallExpression: [checkDrizzleScope] };
