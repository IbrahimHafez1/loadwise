import { ts } from '../compiler.js';
import { sequelizeTableOf } from './sequelize-schema.js';
import { declaredInPackage, stringValue, propertyName } from './ts-helpers.js';
import type { CallExpression, Expression, PropertyAssignment } from 'typescript';
import type { CheckerAdapter } from '../../shared/types.js';
import type { ConditionKind, QueryOrderEntry, QuerySite } from '../types/query-site.js';
import type { SchemaTable } from '../types/schema-model.js';
import { addCondition, isNullLiteral, isScalarValue, leadingWildcard, newSite, unwrap } from './query-site-support.js';
import type { ConditionProperty } from './query-site-support.js';

const sequelizeReads = new Set(['findAll', 'findOne', 'findAndCountAll', 'count']);
const sequelizeOperators: Record<string, ConditionKind> = {
  eq: 'eq',
  is: 'null',
  in: 'in',
  gt: 'range',
  gte: 'range',
  lt: 'range',
  lte: 'range',
  between: 'range',
  ne: 'other',
  not: 'other',
  notIn: 'other',
  contains: 'other',
  overlap: 'other',
};

// `[Op.gte]` -> 'gte'.
function sequelizeOperator(property: PropertyAssignment, checker: CheckerAdapter): string | undefined {
  const name = property.name;
  if (!name || !ts.isComputedPropertyName(name)) return;
  const expression = unwrap(name.expression);
  if (
    !ts.isPropertyAccessExpression(expression) ||
    !declaredInPackage(expression.expression, checker, ['sequelize', '@sequelize/core'])
  )
    return;
  return expression.name.text;
}

function sequelizeValue(
  site: QuerySite,
  table: SchemaTable,
  column: string,
  property: ConditionProperty,
  checker: CheckerAdapter,
): void {
  const node = ts.isShorthandPropertyAssignment(property) ? property.name : property.initializer;
  const value = unwrap(node);
  if (isNullLiteral(value)) return addCondition({ site, table, column, kind: 'null', node: property.name });
  if (ts.isArrayLiteralExpression(value)) return addCondition({ site, table, column, kind: 'in', node: property.name });
  if (!ts.isObjectLiteralExpression(value)) {
    if (isScalarValue(value, checker)) addCondition({ site, table, column, kind: 'eq', node: property.name });
    else site.uncertain = true;
    return;
  }
  for (const operator of value.properties) {
    const name = ts.isPropertyAssignment(operator) ? sequelizeOperator(operator, checker) : undefined;
    if (!name || !ts.isPropertyAssignment(operator)) {
      site.uncertain = true;
    } else if (name === 'like' || name === 'iLike') {
      const wildcard = leadingWildcard(operator.initializer);
      if (wildcard === undefined) site.uncertain = true;
      else if (wildcard)
        addCondition(
          { site, table, column, kind: 'pattern', node: property.name },
          { operator: name, insensitive: name === 'iLike' },
        );
      else addCondition({ site, table, column, kind: 'other', node: property.name });
    } else if (sequelizeOperators[name]) {
      const kind = name === 'eq' && isNullLiteral(operator.initializer) ? 'null' : sequelizeOperators[name];
      addCondition({ site, table, column, kind, node: property.name });
    } else site.uncertain = true;
  }
}

function sequelizeWhere(
  site: QuerySite,
  table: SchemaTable,
  where: Expression | undefined,
  checker: CheckerAdapter,
): void {
  const object = unwrap(where);
  if (!object || !ts.isObjectLiteralExpression(object)) {
    site.uncertain = true;
    return;
  }
  for (const property of object.properties) {
    const column = propertyName(property);
    if (!column || (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property))) {
      // `[Op.or]`, `[Op.and]` and spreads.
      site.uncertain = true;
    } else if (!table.columns.has(column)) site.uncertain = true;
    else sequelizeValue(site, table, column, property, checker);
  }
}

// `[['createdAt', 'DESC']]` or `['createdAt']`.
function sequelizeOrder(table: SchemaTable, order: Expression): QueryOrderEntry[] | null {
  const list = unwrap(order);
  if (!ts.isArrayLiteralExpression(list)) return null;
  const columns: QueryOrderEntry[] = [];
  for (const element of list.elements) {
    const item = unwrap(element);
    const first = ts.isArrayLiteralExpression(item) && item.elements.length <= 2 ? item.elements[0] : item;
    const column = stringValue(first);
    if (!column || !table.columns.has(column)) return null;
    columns.push({ table, column, node: element });
  }
  return columns;
}

function sequelizeSite(call: CallExpression, checker: CheckerAdapter): QuerySite | undefined {
  const access = call.expression;
  if (!ts.isPropertyAccessExpression(access) || !sequelizeReads.has(access.name.text)) return;
  if (!declaredInPackage(access, checker, ['sequelize', 'sequelize-typescript', '@sequelize/core'])) return;
  const table = sequelizeTableOf(access.expression, checker);
  if (!table) return;
  const site = newSite('sequelize', access.name);
  site.limited = access.name.text === 'findOne';
  const options = unwrap(call.arguments[0]);
  if (!options) return site;
  if (!ts.isObjectLiteralExpression(options)) return;
  for (const property of options.properties) {
    const name = propertyName(property);
    if (!name || !ts.isPropertyAssignment(property)) site.uncertain = true;
    else if (name === 'where') sequelizeWhere(site, table, property.initializer, checker);
    else if (name === 'order') site.order = sequelizeOrder(table, property.initializer);
    else if (name === 'limit') site.limited = true;
    else if (name === 'include') site.joins = 1;
  }
  return site;
}

export { sequelizeSite };
