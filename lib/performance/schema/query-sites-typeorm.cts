import { loadSyntax } from '../compiler.cjs';
import { typeormTableOf } from './typeorm-schema.cjs';
import {
  declaredInPackage,
  declaredTypeOf,
  declarationInitializer,
  resolvedSymbol,
  calleeName,
  propertyName,
} from './ts-helpers.cjs';
import type { CallExpression, Expression, Node, ObjectLiteralExpression } from 'typescript';
import type { CheckerAdapter } from '../../shared/types.cjs';
import type { ConditionKind, QueryOrderEntry, QuerySite } from '../types/query-site.cjs';
import type { SchemaTable } from '../types/schema-model.cjs';
import { addCondition, isNullLiteral, isScalarValue, leadingWildcard, newSite, unwrap } from './query-site-support.cjs';
import type { ConditionProperty } from './query-site-support.cjs';

const ts = loadSyntax();

const typeormOptionReads = new Set(['find', 'findOne', 'findOneOrFail', 'findAndCount', 'count', 'exists', 'exist']);
const typeormWhereReads = new Set(['findBy', 'findOneBy', 'findOneByOrFail', 'findAndCountBy', 'countBy', 'existsBy']);
const typeormLimited = new Set([
  'findOne',
  'findOneOrFail',
  'findOneBy',
  'findOneByOrFail',
  'exists',
  'exist',
  'existsBy',
]);
const typeormOperators: Record<string, ConditionKind> = {
  In: 'in',
  MoreThan: 'range',
  MoreThanOrEqual: 'range',
  LessThan: 'range',
  LessThanOrEqual: 'range',
  Between: 'range',
  Equal: 'eq',
  IsNull: 'null',
  Not: 'other',
  ArrayContains: 'other',
  ArrayContainedBy: 'other',
  ArrayOverlap: 'other',
};

// `this.repo` typed `Repository<User>`, a variable from `getRepository(User)`, or
// `getRepository(User)` itself.
function repositoryEntity(receiver: Expression, checker: CheckerAdapter): Node | undefined {
  const value = unwrap(receiver);
  if (ts.isCallExpression(value) && calleeName(value) === 'getRepository') return value.arguments[0];
  const symbol = resolvedSymbol(value, checker);
  const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
  if (!declaration) return;
  const type = declaredTypeOf(declaration);
  if (type && ts.isTypeReferenceNode(type) && type.typeArguments?.length === 1) {
    const argument = type.typeArguments[0];
    if (ts.isTypeReferenceNode(argument)) return argument.typeName;
  }
  const initializer = unwrap(declarationInitializer(declaration));
  if (initializer && ts.isCallExpression(initializer) && calleeName(initializer) === 'getRepository') {
    return initializer.arguments[0];
  }
}

function typeormValue(
  site: QuerySite,
  table: SchemaTable,
  column: string,
  property: ConditionProperty,
  checker: CheckerAdapter,
): void {
  const node = ts.isShorthandPropertyAssignment(property) ? property.name : property.initializer;
  const value = unwrap(node);
  if (isNullLiteral(value)) {
    addCondition({ site, table, column, kind: 'null', node: property.name });
    return;
  }
  if (ts.isCallExpression(value) && ts.isIdentifier(value.expression)) {
    if (!declaredInPackage(value.expression, checker, ['typeorm'])) {
      if (isScalarValue(value, checker)) addCondition({ site, table, column, kind: 'eq', node: property.name });
      else site.uncertain = true;
      return;
    }
    const operator = resolvedSymbol(value.expression, checker)?.name;
    if (operator === undefined) {
      site.uncertain = true;
      return;
    }
    if (operator === 'Like' || operator === 'ILike') {
      const wildcard = leadingWildcard(value.arguments[0]);
      if (wildcard === undefined) site.uncertain = true;
      else if (wildcard)
        addCondition(
          { site, table, column, kind: 'pattern', node: property.name },
          { operator, insensitive: operator === 'ILike' },
        );
      else addCondition({ site, table, column, kind: 'other', node: property.name });
    } else if (typeormOperators[operator])
      addCondition({ site, table, column, kind: typeormOperators[operator], node: property.name });
    else site.uncertain = true;
    return;
  }
  if (isScalarValue(value, checker)) addCondition({ site, table, column, kind: 'eq', node: property.name });
  else site.uncertain = true;
}

function typeormWhere(
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
      site.uncertain = true;
    } else if (!table.columns.has(column) || table.columns.get(column)?.type === 'relation') {
      site.uncertain = true;
    } else typeormValue(site, table, column, property, checker);
  }
}

function typeormOrder(table: SchemaTable, order: Expression): QueryOrderEntry[] | null {
  const object = unwrap(order);
  if (!ts.isObjectLiteralExpression(object)) return null;
  const columns: QueryOrderEntry[] = [];
  for (const property of object.properties) {
    const column = propertyName(property);
    if (!ts.isPropertyAssignment(property) || column === undefined || !table.columns.has(column)) return null;
    const direction = unwrap(property.initializer);
    if (!ts.isStringLiteralLike(direction) && !ts.isNumericLiteral(direction)) return null;
    columns.push({ table, column, node: property.name });
  }
  return columns;
}

function typeormSite(call: CallExpression, checker: CheckerAdapter): QuerySite | undefined {
  const access = call.expression;
  if (!ts.isPropertyAccessExpression(access)) return;
  const method = access.name.text;
  if (!typeormOptionReads.has(method) && !typeormWhereReads.has(method)) return;
  if (!declaredInPackage(access, checker, ['typeorm'])) return;
  const owner = resolvedSymbol(access, checker)?.declarations?.[0]?.parent;
  const ownerName = owner && ts.isClassDeclaration(owner) ? owner.name?.text : undefined;
  const args = [...call.arguments];
  let entity: Node | undefined;
  if (ownerName === 'EntityManager') {
    entity = args.shift();
  } else if (ownerName === 'BaseEntity') {
    entity = access.expression;
  } else {
    entity = repositoryEntity(access.expression, checker);
  }
  const table = entity && typeormTableOf(entity, checker);
  if (!table) return;
  const site = newSite('typeorm', access.name);
  site.table = table;
  site.limited = typeormLimited.has(method);
  if (typeormWhereReads.has(method)) {
    typeormWhere(site, table, args[0], checker);
    return site;
  }
  const options = unwrap(args[0]);
  if (!options) return site;
  if (!ts.isObjectLiteralExpression(options)) return;
  readTypeormFindOptions(options, site, table, checker);
  return site;
}

function readTypeormFindOptions(
  options: ObjectLiteralExpression,
  site: QuerySite,
  table: SchemaTable,
  checker: CheckerAdapter,
): void {
  for (const property of options.properties) {
    const name = propertyName(property);
    if (!name || !ts.isPropertyAssignment(property)) site.uncertain = true;
    else if (name === 'where') typeormWhere(site, table, property.initializer, checker);
    else if (name === 'order') site.order = typeormOrder(table, property.initializer);
    else if (name === 'take') site.limited = true;
    else if (name === 'relations' || name === 'join') site.joins = 1;
  }
}

export { typeormSite, repositoryEntity };
