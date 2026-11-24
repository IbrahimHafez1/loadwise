import { loadSyntax } from '../compiler.cjs';
import { drizzleTable, drizzleColumn } from './drizzle-schema.cjs';
import { declaredInPackage, resolvedSymbol, calleeName } from './ts-helpers.cjs';
import type { CallExpression, ConditionalExpression, Expression, Node } from 'typescript';
import type { CheckerAdapter } from '../../shared/types.cjs';
import type { ColumnReference, ConditionKind, QueryOrderEntry, QuerySite } from '../types/query-site.cjs';
import { addCondition, leadingWildcard, newSite, unwrap } from './query-site-support.cjs';

const ts = loadSyntax();

interface DrizzleOperand extends ColumnReference {
  expression?: string;
}

interface DrizzleStep {
  name: string;
  call: CallExpression;
}

const drizzleComparisons: Record<string, ConditionKind> = {
  eq: 'eq',
  inArray: 'in',
  gt: 'range',
  gte: 'range',
  lt: 'range',
  lte: 'range',
  between: 'range',
  isNull: 'null',
  ne: 'other',
  notInArray: 'other',
  isNotNull: 'other',
  notLike: 'other',
  notIlike: 'other',
  arrayContains: 'other',
  arrayContained: 'other',
  arrayOverlaps: 'other',
};
const drizzleSteps = new Set([
  'from',
  'where',
  'orderBy',
  'limit',
  'offset',
  'innerJoin',
  'leftJoin',
  'rightJoin',
  'fullJoin',
  'set',
  'returning',
  'execute',
  'then',
  'groupBy',
  'having',
  'for',
  '$dynamic',
  'prepare',
]);
const drizzleJoins = new Set(['innerJoin', 'leftJoin', 'rightJoin', 'fullJoin']);
const expressionFunctions = new Set(['lower', 'upper', 'date', 'coalesce', 'trim']);

function drizzleOperand(node: Expression, checker: CheckerAdapter): DrizzleOperand | undefined {
  const value = unwrap(node);
  const reference = drizzleColumn(value, checker);
  if (reference) return { ...reference };
  if (!ts.isTaggedTemplateExpression(value) || !ts.isIdentifier(value.tag) || value.tag.text !== 'sql') return;
  if (!declaredInPackage(value.tag, checker, ['drizzle-orm'])) return;
  // sql`lower(${users.email})` or sql`${orders.createdAt}::date`.
  const template = value.template;
  if (!ts.isTemplateExpression(template) || template.templateSpans.length !== 1) return;
  const [span] = template.templateSpans;
  const inner = drizzleColumn(span.expression, checker);
  if (!inner) return;
  const columnName = inner.table.columns.get(inner.column)?.dbName ?? inner.column;
  const head = template.head.text.trim();
  const tail = span.literal.text.trim();
  const call = /^(\w+)\($/.exec(head);
  if (call && expressionFunctions.has(call[1].toLowerCase()) && /^(?:,[^()]*)?\)$/.test(tail)) {
    return { ...inner, expression: `${call[1].toLowerCase()}(${columnName}${tail.slice(0, -1)})` };
  }
  if (!head && /^::\w+$/.test(tail)) return { ...inner, expression: `${columnName}${tail}` };
}

function drizzleConditional(site: QuerySite, value: ConditionalExpression, checker: CheckerAdapter): void {
  // `filter ? eq(...) : undefined` adds the conjunct only sometimes; treat it as present.
  const branches = [value.whenTrue, value.whenFalse].filter((branch) => {
    const inner = unwrap(branch);
    return inner.kind !== ts.SyntaxKind.UndefinedKeyword && !(ts.isIdentifier(inner) && inner.text === 'undefined');
  });
  if (branches.length !== 1) site.uncertain = true;
  else drizzleCondition(site, branches[0], checker);
}

function drizzleOperatorCondition(
  site: QuerySite,
  value: CallExpression,
  name: string,
  left: DrizzleOperand,
  checker: CheckerAdapter,
): void {
  // Unary operators such as isNull() have no right-hand side.
  const rightColumn = value.arguments.length > 1 && drizzleColumn(value.arguments[1], checker);
  if (rightColumn) {
    // A column compared with another column is a join predicate; it does not narrow on its own.
    addCondition({ site, table: left.table, column: left.column, kind: 'other', node: value });
    return;
  }
  if (left.expression) {
    if (name === 'eq' || name === 'inArray' || drizzleComparisons[name] === 'range') {
      addCondition(
        { site, table: left.table, column: left.column, kind: 'expression', node: value },
        { expression: left.expression },
      );
    } else site.uncertain = true;
    return;
  }
  if (name === 'like' || name === 'ilike') {
    const wildcard = leadingWildcard(value.arguments[1]);
    if (wildcard === undefined) site.uncertain = true;
    else if (wildcard)
      addCondition(
        { site, table: left.table, column: left.column, kind: 'pattern', node: value },
        { operator: name, insensitive: name === 'ilike' },
      );
    else addCondition({ site, table: left.table, column: left.column, kind: 'other', node: value });
    return;
  }
  const kind = drizzleComparisons[name];
  if (kind) addCondition({ site, table: left.table, column: left.column, kind, node: value });
  else site.uncertain = true;
}

function drizzleCondition(site: QuerySite, node: Expression | undefined, checker: CheckerAdapter): void {
  const value = unwrap(node);
  if (!value || value.kind === ts.SyntaxKind.UndefinedKeyword) return;
  if (ts.isConditionalExpression(value)) return drizzleConditional(site, value, checker);
  if (!ts.isCallExpression(value) || !ts.isIdentifier(value.expression)) {
    site.uncertain = true;
    return;
  }
  if (!declaredInPackage(value.expression, checker, ['drizzle-orm'])) {
    site.uncertain = true;
    return;
  }
  const name = resolvedSymbol(value.expression, checker)?.name;
  if (name === undefined) {
    site.uncertain = true;
    return;
  }
  if (name === 'and') {
    if (value.arguments.some((argument: Expression) => ts.isSpreadElement(argument))) site.uncertain = true;
    else for (const argument of value.arguments) drizzleCondition(site, argument, checker);
    return;
  }
  const left = drizzleOperand(value.arguments[0], checker);
  if (!left) {
    site.uncertain = true;
    return;
  }
  drizzleOperatorCondition(site, value, name, left, checker);
}

function drizzleOrder(args: readonly Expression[], checker: CheckerAdapter): QueryOrderEntry[] | null {
  const order: QueryOrderEntry[] = [];
  for (const argument of args) {
    let value: Expression = unwrap(argument);
    if (
      ts.isCallExpression(value) &&
      ts.isIdentifier(value.expression) &&
      ['asc', 'desc'].includes(resolvedSymbol(value.expression, checker)?.name ?? '') &&
      declaredInPackage(value.expression, checker, ['drizzle-orm'])
    ) {
      value = unwrap(value.arguments[0]);
    }
    const reference = drizzleColumn(value, checker);
    if (!reference) return null;
    order.push({ ...reference, node: argument });
  }
  return order;
}

// The builder chain above a drizzle root call:
// `db.select().from(t).where(...).orderBy(...).limit(1)`.
function drizzleChainAbove(root: CallExpression): DrizzleStep[] | undefined {
  const steps: DrizzleStep[] = [];
  let current: Node = root;
  while (ts.isPropertyAccessExpression(current.parent) && current.parent.expression === current) {
    const call = current.parent.parent;
    if (!ts.isCallExpression(call) || call.expression !== current.parent) break;
    const name = current.parent.name.text;
    if (!drizzleSteps.has(name)) return;
    steps.push({ name, call });
    current = call;
  }
  return steps;
}

function drizzleSite(call: CallExpression, checker: CheckerAdapter): QuerySite | undefined {
  const name = calleeName(call);
  if (name !== 'from' && name !== 'update' && name !== 'delete') return;
  if (!ts.isPropertyAccessExpression(call.expression)) return;
  if (!declaredInPackage(call.expression, checker, ['drizzle-orm'])) return;
  const table = drizzleTable(call.arguments[0], checker);
  if (!table) return;
  const steps = drizzleChainAbove(call);
  if (!steps) return;
  const site = newSite('drizzle', call.expression.name);
  const tables = [table];
  site.tables = tables;
  for (const step of steps) {
    if (step.name === 'where') drizzleCondition(site, step.call.arguments[0], checker);
    else if (step.name === 'orderBy') site.order = drizzleOrder(step.call.arguments, checker);
    else if (step.name === 'limit') site.limited = true;
    else if (drizzleJoins.has(step.name)) {
      const joined = drizzleTable(step.call.arguments[0], checker);
      if (!joined) site.uncertain = true;
      else tables.push(joined);
      site.joins = (site.joins ?? 0) + 1;
    } else if (step.name === 'groupBy' || step.name === 'having') site.uncertain = true;
  }
  return site;
}

export { drizzleSite };
