import { loadSyntax } from '../compiler.cjs';
import { prismaModelName, childDirectories } from '../prisma.cjs';
import { loadPrismaSchema } from './prisma-schema.cjs';
import fs from 'node:fs';
import path from 'node:path';
import { projectRootOf } from './project-indexes.cjs';
import { stringValue, propertyName } from './ts-helpers.cjs';
import type { CallExpression, Expression, PropertyAccessExpression } from 'typescript';
import type { CheckerAdapter } from '../../shared/types.cjs';
import type { PrismaSchema } from '../types/prisma-schema.cjs';
import type { QueryOrderEntry, QuerySite } from '../types/query-site.cjs';
import type { SchemaTable } from '../types/schema-model.cjs';
import { addCondition, isNullLiteral, isScalarValue, newSite, unwrap } from './query-site-support.cjs';
import type { ConditionProperty, FieldTarget } from './query-site-support.cjs';

const ts = loadSyntax();

const prismaReads = new Set([
  'findMany',
  'findFirst',
  'findFirstOrThrow',
  'count',
  'aggregate',
  'updateMany',
  'deleteMany',
]);
const prismaLimited = new Set(['findFirst', 'findFirstOrThrow']);
const prismaRange = new Set(['gt', 'gte', 'lt', 'lte']);
const prismaOther = new Set(['not', 'notIn', 'has', 'hasSome', 'hasEvery', 'isEmpty', 'isSet']);

function isRepositoryRoot(directory: string): boolean {
  return fs.existsSync(path.join(directory, '.git')) || fs.existsSync(path.join(directory, 'pnpm-workspace.yaml'));
}

// The packages that may own the schema behind a client wrapper: the file's own package and its
// ancestors, and in a repository every package up to two levels down (`packages/prisma`,
// `apps/api`).
function schemaOwnerRoots(fileName: string): Set<string> {
  const owners = new Set<string>();
  let repositoryRoot: string | undefined;
  for (let current = path.dirname(fileName); ; current = path.dirname(current)) {
    if (fs.existsSync(path.join(current, 'package.json'))) owners.add(current);
    if (isRepositoryRoot(current)) {
      repositoryRoot = current;
      break;
    }
    if (path.dirname(current) === current) break;
  }
  if (!repositoryRoot) return owners;
  const topLevel = childDirectories(repositoryRoot);
  for (const candidate of [...topLevel, ...topLevel.flatMap(childDirectories)]) {
    if (fs.existsSync(path.join(candidate, 'package.json'))) owners.add(candidate);
  }
  return owners;
}

// Without a generated client the declaration is unknown, so the model is looked up in the schemas
// of the packages around the file. A model name that two schemas define differently could belong to
// either, so it stays unresolved.
function schemaDefiningModel(fileName: string, model: string): PrismaSchema | undefined {
  const declaring = new Map<string, PrismaSchema>();
  for (const root of schemaOwnerRoots(fileName)) {
    const schema = loadPrismaSchema(root);
    const table = schema?.models.get(model);
    if (schema && table) declaring.set(`${table.file}:${table.line}`, schema);
  }
  return declaring.size === 1 ? [...declaring.values()][0] : undefined;
}

function prismaTableFor(access: PropertyAccessExpression, checker: CheckerAdapter): SchemaTable | undefined {
  const model = prismaModelName(access.name, checker);
  if (!model) return;
  const declaration = checker.getSymbolAtLocation(access.name)?.declarations?.[0];
  const schema = declaration
    ? loadPrismaSchema(projectRootOf(declaration.getSourceFile().fileName))
    : schemaDefiningModel(access.getSourceFile().fileName, model);
  const table = schema?.models.get(model);
  if (!schema || !table || !schema.dialect) return;
  table.orm = 'prisma';
  return table;
}

function addPrismaOperator(
  { site, table, column, node }: FieldTarget,
  operator: string,
  operand: Expression,
  insensitive: boolean,
): void {
  if (operator === 'equals' || operator === 'in') {
    if (insensitive) addCondition({ site, table, column, kind: 'expression', node }, { operator: 'insensitive' });
    else if (operator === 'in') addCondition({ site, table, column, kind: 'in', node });
    else addCondition({ site, table, column, kind: isNullLiteral(operand) ? 'null' : 'eq', node });
  } else if (prismaRange.has(operator)) addCondition({ site, table, column, kind: 'range', node });
  else if (operator === 'contains' || operator === 'endsWith') {
    addCondition({ site, table, column, kind: 'pattern', node }, { operator, insensitive });
  } else if (operator === 'startsWith') {
    const kind = insensitive ? 'pattern' : 'other';
    addCondition({ site, table, column, kind, node }, { operator, insensitive });
  } else if (prismaOther.has(operator)) addCondition({ site, table, column, kind: 'other', node });
  else site.uncertain = true;
}

function prismaFieldFilter(
  site: QuerySite,
  table: SchemaTable,
  column: string,
  property: ConditionProperty,
  checker: CheckerAdapter,
): void {
  const value = unwrap(ts.isShorthandPropertyAssignment(property) ? property.name : property.initializer);
  if (!ts.isObjectLiteralExpression(value)) {
    if (isNullLiteral(value)) addCondition({ site, table, column, kind: 'null', node: property.name });
    else if (isScalarValue(value, checker)) addCondition({ site, table, column, kind: 'eq', node: property.name });
    else site.uncertain = true;
    return;
  }
  const operators = new Map<string, Expression>();
  for (const operator of value.properties) {
    const name =
      ts.isPropertyAssignment(operator) || ts.isShorthandPropertyAssignment(operator)
        ? propertyName(operator)
        : undefined;
    if (!name || !(ts.isPropertyAssignment(operator) || ts.isShorthandPropertyAssignment(operator))) {
      site.uncertain = true;
      return;
    }
    operators.set(name, ts.isPropertyAssignment(operator) ? operator.initializer : operator.name);
  }
  const insensitive = stringValue(operators.get('mode')) === 'insensitive';
  operators.delete('mode');
  for (const [operator, operand] of operators) {
    addPrismaOperator({ site, table, column, node: property.name }, operator, operand, insensitive);
  }
}

function prismaWhere(
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
    const name = propertyName(property);
    if (!name || (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property))) {
      site.uncertain = true;
    } else if (name === 'AND') {
      const value = ts.isPropertyAssignment(property) ? unwrap(property.initializer) : undefined;
      const parts = value && ts.isArrayLiteralExpression(value) ? value.elements : [value];
      for (const part of parts) prismaWhere(site, table, part, checker);
    } else if (!table.columns.has(name)) {
      // OR, NOT and relation filters can narrow the rows in ways this rule does not model.
      site.uncertain = true;
    } else {
      prismaFieldFilter(site, table, name, property, checker);
    }
  }
}

function prismaOrder(table: SchemaTable, orderBy: Expression): QueryOrderEntry[] | undefined {
  const value = unwrap(orderBy);
  const entries = ts.isArrayLiteralExpression(value) ? value.elements.map((element) => unwrap(element)) : [value];
  const order: QueryOrderEntry[] = [];
  for (const entry of entries) {
    if (!ts.isObjectLiteralExpression(entry) || entry.properties.length !== 1) return;
    const [property] = entry.properties;
    const column = propertyName(property);
    if (!ts.isPropertyAssignment(property) || column === undefined || !table.columns.has(column)) return;
    const direction = unwrap(property.initializer);
    if (!ts.isStringLiteralLike(direction) && !ts.isObjectLiteralExpression(direction)) return;
    order.push({ table, column, node: property.name });
  }
  return order;
}

function prismaSite(call: CallExpression, checker: CheckerAdapter): QuerySite | undefined {
  const access = call.expression;
  if (!ts.isPropertyAccessExpression(access) || !prismaReads.has(access.name.text)) return;
  const table = prismaTableFor(access, checker);
  if (!table) return;
  const site = newSite('prisma', access.name);
  site.table = table;
  site.limited = prismaLimited.has(access.name.text);
  const options = unwrap(call.arguments[0]);
  if (!options) return site;
  if (!ts.isObjectLiteralExpression(options)) return;
  for (const property of options.properties) {
    const name = propertyName(property);
    if (!name || !ts.isPropertyAssignment(property)) {
      site.uncertain = true;
      continue;
    }
    if (name === 'where') prismaWhere(site, table, property.initializer, checker);
    else if (name === 'orderBy') site.order = prismaOrder(table, property.initializer) ?? null;
    else if (name === 'take') site.limited = true;
  }
  return site;
}

export { prismaSite, prismaTableFor };
