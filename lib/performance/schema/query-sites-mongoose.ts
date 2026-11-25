import { ts } from '../compiler.js';
import { mongooseTableOf } from './mongoose-schema.js';
import { declaredInPackage, stringValue, propertyName } from './ts-helpers.js';
import type { CallExpression, Expression, Node } from 'typescript';
import type { CheckerAdapter } from '../../shared/types.js';
import type { ConditionKind, QueryOrderEntry, QuerySite } from '../types/query-site.js';
import type { SchemaTable } from '../types/schema-model.js';
import { addCondition, isNullLiteral, isScalarValue, literalText, newSite, unwrap } from './query-site-support.js';
import type { ConditionProperty, FieldTarget } from './query-site-support.js';

const mongooseReads = new Set(['find', 'findOne', 'countDocuments', 'exists', 'updateMany', 'deleteMany']);
const mongooseChain = new Set(['sort', 'limit', 'skip', 'lean', 'select', 'populate', 'session', 'exec']);
const mongoOperators: Record<string, ConditionKind> = {
  $eq: 'eq',
  $in: 'in',
  $gt: 'range',
  $gte: 'range',
  $lt: 'range',
  $lte: 'range',
  $ne: 'other',
  $nin: 'other',
  $exists: 'other',
  $not: 'other',
};

function regexIsUnanchored(node: Expression | undefined): boolean | undefined {
  const value = unwrap(node);
  if (value && ts.isRegularExpressionLiteral(value)) {
    const text = value.text;
    const flags = text.slice(text.lastIndexOf('/') + 1);
    return !text.startsWith('/^') || flags.includes('i');
  }
  if (value && ts.isNewExpression(value) && ts.isIdentifier(value.expression) && value.expression.text === 'RegExp') {
    const flags = stringValue(value.arguments?.[1]);
    if (flags?.includes('i')) return true;
    const source = literalText(value.arguments?.[0]);
    return source === undefined ? undefined : !source.startsWith('^');
  }
}

function addMongoRegex({ site, table, column, node }: FieldTarget, operators: Map<string, Expression>): void {
  const options = stringValue(operators.get('$options'));
  const regexText = literalText(operators.get('$regex'));
  const source =
    regexIsUnanchored(operators.get('$regex')) ?? (regexText === undefined ? undefined : !regexText.startsWith('^'));
  const unanchored = options?.includes('i') || source;
  if (unanchored === undefined) site.uncertain = true;
  else addCondition({ site, table, column, kind: unanchored ? 'pattern' : 'other', node }, { operator: 'regex' });
  operators.delete('$regex');
  operators.delete('$options');
}

function mongoValue(
  site: QuerySite,
  table: SchemaTable,
  column: string,
  property: ConditionProperty,
  checker: CheckerAdapter,
): void {
  const node = ts.isShorthandPropertyAssignment(property) ? property.name : property.initializer;
  const value = unwrap(node);
  const regex = regexIsUnanchored(value);
  if (regex !== undefined || value.kind === ts.SyntaxKind.RegularExpressionLiteral) {
    addCondition(
      { site, table, column, kind: regex ? 'pattern' : 'other', node: property.name },
      { operator: 'regex' },
    );
    return;
  }
  if (isNullLiteral(value)) return addCondition({ site, table, column, kind: 'null', node: property.name });
  if (!ts.isObjectLiteralExpression(value)) {
    if (isScalarValue(value, checker)) addCondition({ site, table, column, kind: 'eq', node: property.name });
    else site.uncertain = true;
    return;
  }
  const operators = new Map<string, Expression>();
  for (const operator of value.properties) {
    const name = ts.isPropertyAssignment(operator) ? propertyName(operator) : undefined;
    if (!name || !ts.isPropertyAssignment(operator)) {
      site.uncertain = true;
      return;
    }
    operators.set(name, operator.initializer);
  }
  if (operators.has('$regex')) addMongoRegex({ site, table, column, node: property.name }, operators);
  for (const [name] of operators) {
    if (mongoOperators[name]) addCondition({ site, table, column, kind: mongoOperators[name], node: property.name });
    else site.uncertain = true;
  }
}

function mongoFilter(
  site: QuerySite,
  table: SchemaTable,
  filter: Expression | undefined,
  checker: CheckerAdapter,
): void {
  const object = unwrap(filter);
  if (!object || !ts.isObjectLiteralExpression(object)) {
    site.uncertain = true;
    return;
  }
  for (const property of object.properties) {
    const column = propertyName(property);
    if (!column || (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property))) {
      site.uncertain = true;
    } else if (!table.columns.has(column)) site.uncertain = true;
    else mongoValue(site, table, column, property, checker);
  }
}

function mongoSort(table: SchemaTable, spec: Expression | undefined): QueryOrderEntry[] | null {
  const object = unwrap(spec);
  if (!object || !ts.isObjectLiteralExpression(object)) return null;
  const columns: QueryOrderEntry[] = [];
  for (const property of object.properties) {
    const column = propertyName(property);
    if (!ts.isPropertyAssignment(property) || column === undefined || !table.columns.has(column)) return null;
    columns.push({ table, column, node: property.name });
  }
  return columns;
}

function mongooseSite(call: CallExpression, checker: CheckerAdapter): QuerySite | undefined {
  const access = call.expression;
  if (!ts.isPropertyAccessExpression(access) || !mongooseReads.has(access.name.text)) return;
  if (!declaredInPackage(access, checker, ['mongoose'])) return;
  const table = mongooseTableOf(access.expression, checker);
  if (!table) return;
  const site = newSite('mongoose', access.name);
  site.limited = access.name.text === 'findOne' || access.name.text === 'exists';
  if (call.arguments.length) mongoFilter(site, table, call.arguments[0], checker);
  let current: Node = call;
  while (ts.isPropertyAccessExpression(current.parent) && ts.isCallExpression(current.parent.parent)) {
    const name = current.parent.name.text;
    if (!mongooseChain.has(name)) break;
    const step = current.parent.parent;
    if (name === 'sort') site.order = mongoSort(table, step.arguments[0]);
    else if (name === 'limit') site.limited = true;
    else if (name === 'populate') site.joins = 1;
    current = step;
  }
  return site;
}

export { mongooseSite };
