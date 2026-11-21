'use strict';

const { syntax: ts } = require('../compiler.cjs');
const { prismaModelName } = require('../prisma.cjs');
const { loadPrismaSchema } = require('./prisma-schema.cjs');
const { drizzleTable, drizzleColumn } = require('./drizzle-schema.cjs');
const { typeormTableOf } = require('./typeorm-schema.cjs');
const { sequelizeTableOf } = require('./sequelize-schema.cjs');
const { mongooseTableOf } = require('./mongoose-schema.cjs');
const { projectRootOf } = require('./project-indexes.cjs');
const { declaredInPackage, resolvedSymbol, calleeName, stringValue, propertyName } = require('./ts-helpers.cjs');

// A site is { orm, node, table (Prisma and TypeORM), conditions: [{ table, column, kind, node, operator?, expression? }], order, limited,
// uncertain }. Kinds: eq, in, range, null (IS NULL), other (cannot narrow by itself), pattern, expression.
// `uncertain` means a conjunct could not be read, so it might be the covered one: rules stay silent.

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
const typeormOperators = {
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
const sequelizeReads = new Set(['findAll', 'findOne', 'findAndCountAll', 'count']);
const sequelizeOperators = {
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
const mongooseReads = new Set(['find', 'findOne', 'countDocuments', 'exists', 'updateMany', 'deleteMany']);
const mongooseChain = new Set(['sort', 'limit', 'skip', 'lean', 'select', 'populate', 'session', 'exec']);
const mongoOperators = {
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
const drizzleComparisons = {
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
const scalarFlags = ['StringLike', 'NumberLike', 'BooleanLike', 'BigIntLike', 'EnumLike', 'Null', 'Undefined', 'Void'];

function newSite(orm, node) {
  return { orm, node, conditions: [], order: undefined, limited: false, uncertain: false };
}

function unwrap(node) {
  return node && ts.skipOuterExpressions(node);
}

function isScalarType(type) {
  if (type.isUnion()) return type.types.every(isScalarType);
  if (scalarFlags.some((flag) => type.flags & ts.TypeFlags[flag])) return true;
  return type.getSymbol()?.name === 'Date';
}

// A value compared by equality: a literal, or an expression whose type is a primitive or a Date.
function isScalarValue(node, checker) {
  const value = unwrap(node);
  if (ts.isStringLiteralLike(value) || ts.isNumericLiteral(value) || ts.isTemplateExpression(value)) return true;
  if (value.kind === ts.SyntaxKind.TrueKeyword || value.kind === ts.SyntaxKind.FalseKeyword) return true;
  if (ts.isObjectLiteralExpression(value) || ts.isArrayLiteralExpression(value)) return false;
  return isScalarType(checker.getTypeAtLocation(value));
}

function isNullLiteral(node) {
  return unwrap(node)?.kind === ts.SyntaxKind.NullKeyword;
}

function literalText(node) {
  const value = unwrap(node);
  if (!value) return;
  if (ts.isStringLiteralLike(value)) return value.text;
  if (ts.isTemplateExpression(value)) return value.head.text + '…';
}

// `'%term'`, `` `%${term}%` `` -> true; a pattern whose start is unknown -> undefined.
function leadingWildcard(node) {
  const text = literalText(node);
  if (text === undefined) return;
  return text.startsWith('%') || text.startsWith('_');
}

function addCondition({ site, table, column, kind, node }, extra) {
  if (!table.columns.has(column)) {
    site.uncertain = true;
    return;
  }
  site.conditions.push({ table, column, kind, node, ...extra });
}

// ---------------------------------------------------------------- Prisma

function prismaTableFor(access, checker) {
  const model = prismaModelName(access.name, checker);
  if (!model) return;
  const declaration = checker.getSymbolAtLocation(access.name)?.declarations?.[0];
  const schema = declaration && loadPrismaSchema(projectRootOf(declaration.getSourceFile().fileName));
  const table = schema?.models.get(model);
  if (!table || !schema.dialect) return;
  table.orm = 'prisma';
  return table;
}

function prismaFieldFilter(site, table, property, checker) {
  const column = propertyName(property);
  const value = unwrap(ts.isShorthandPropertyAssignment(property) ? property.name : property.initializer);
  if (!ts.isObjectLiteralExpression(value)) {
    if (isNullLiteral(value)) addCondition({ site, table, column, kind: 'null', node: property.name });
    else if (isScalarValue(value, checker)) addCondition({ site, table, column, kind: 'eq', node: property.name });
    else site.uncertain = true;
    return;
  }
  const operators = new Map();
  for (const operator of value.properties) {
    const name =
      ts.isPropertyAssignment(operator) || ts.isShorthandPropertyAssignment(operator)
        ? propertyName(operator)
        : undefined;
    if (!name) {
      site.uncertain = true;
      return;
    }
    operators.set(name, ts.isPropertyAssignment(operator) ? operator.initializer : operator.name);
  }
  const insensitive = stringValue(operators.get('mode')) === 'insensitive';
  operators.delete('mode');
  for (const [operator, operand] of operators) {
    if (operator === 'equals' || operator === 'in') {
      if (insensitive)
        addCondition({ site, table, column, kind: 'expression', node: property.name }, { operator: 'insensitive' });
      else if (operator === 'in') addCondition({ site, table, column, kind: 'in', node: property.name });
      else addCondition({ site, table, column, kind: isNullLiteral(operand) ? 'null' : 'eq', node: property.name });
    } else if (prismaRange.has(operator)) addCondition({ site, table, column, kind: 'range', node: property.name });
    else if (operator === 'contains' || operator === 'endsWith') {
      addCondition({ site, table, column, kind: 'pattern', node: property.name }, { operator, insensitive });
    } else if (operator === 'startsWith') {
      const kind = insensitive ? 'pattern' : 'other';
      addCondition({ site, table, column, kind, node: property.name }, { operator, insensitive });
    } else if (prismaOther.has(operator)) addCondition({ site, table, column, kind: 'other', node: property.name });
    else site.uncertain = true;
  }
}

function prismaWhere(site, table, where, checker) {
  const object = unwrap(where);
  if (!ts.isObjectLiteralExpression(object)) {
    site.uncertain = true;
    return;
  }
  for (const property of object.properties) {
    const name = propertyName(property);
    if (!name || (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property))) {
      site.uncertain = true;
    } else if (name === 'AND') {
      const value = unwrap(property.initializer);
      const parts = value && ts.isArrayLiteralExpression(value) ? value.elements : [value];
      for (const part of parts) prismaWhere(site, table, part, checker);
    } else if (!table.columns.has(name)) {
      // OR, NOT and relation filters can narrow the rows in ways this rule does not model.
      site.uncertain = true;
    } else {
      prismaFieldFilter(site, table, property, checker);
    }
  }
}

function prismaOrder(site, table, orderBy) {
  const value = unwrap(orderBy);
  const entries = ts.isArrayLiteralExpression(value) ? value.elements.map(unwrap) : [value];
  const order = [];
  for (const entry of entries) {
    if (!ts.isObjectLiteralExpression(entry) || entry.properties.length !== 1) return;
    const [property] = entry.properties;
    const column = propertyName(property);
    if (!ts.isPropertyAssignment(property) || !table.columns.has(column)) return;
    const direction = unwrap(property.initializer);
    if (!ts.isStringLiteralLike(direction) && !ts.isObjectLiteralExpression(direction)) return;
    order.push({ table, column, node: property.name });
  }
  return order;
}

function prismaSite(call, checker) {
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
    else if (name === 'orderBy') site.order = prismaOrder(site, table, property.initializer) ?? null;
    else if (name === 'take') site.limited = true;
  }
  return site;
}

// ---------------------------------------------------------------- Drizzle

function drizzleOperand(node, checker) {
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
  const columnName = inner.table.columns.get(inner.column).dbName;
  const head = template.head.text.trim();
  const tail = span.literal.text.trim();
  const call = /^(\w+)\($/.exec(head);
  if (call && expressionFunctions.has(call[1].toLowerCase()) && /^(?:,[^()]*)?\)$/.test(tail)) {
    return { ...inner, expression: `${call[1].toLowerCase()}(${columnName}${tail.slice(0, -1)})` };
  }
  if (!head && /^::\w+$/.test(tail)) return { ...inner, expression: `${columnName}${tail}` };
}

function drizzleCondition(site, node, checker) {
  const value = unwrap(node);
  if (!value || value.kind === ts.SyntaxKind.UndefinedKeyword) return;
  if (ts.isConditionalExpression(value)) {
    // `filter ? eq(...) : undefined` adds the conjunct only sometimes; treat it as present.
    const branches = [value.whenTrue, value.whenFalse].filter(
      (branch) =>
        unwrap(branch).kind !== ts.SyntaxKind.UndefinedKeyword &&
        !(ts.isIdentifier(unwrap(branch)) && unwrap(branch).text === 'undefined'),
    );
    if (branches.length !== 1) site.uncertain = true;
    else drizzleCondition(site, branches[0], checker);
    return;
  }
  if (!ts.isCallExpression(value) || !ts.isIdentifier(value.expression)) {
    site.uncertain = true;
    return;
  }
  if (!declaredInPackage(value.expression, checker, ['drizzle-orm'])) {
    site.uncertain = true;
    return;
  }
  const name = resolvedSymbol(value.expression, checker).name;
  if (name === 'and') {
    if (value.arguments.some((argument) => ts.isSpreadElement(argument))) site.uncertain = true;
    else for (const argument of value.arguments) drizzleCondition(site, argument, checker);
    return;
  }
  const left = drizzleOperand(value.arguments[0], checker);
  if (!left) {
    site.uncertain = true;
    return;
  }
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

function drizzleOrder(site, args, checker) {
  const order = [];
  for (const argument of args) {
    let value = unwrap(argument);
    if (
      ts.isCallExpression(value) &&
      ts.isIdentifier(value.expression) &&
      ['asc', 'desc'].includes(resolvedSymbol(value.expression, checker)?.name) &&
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

// The builder chain above a drizzle root call: `db.select().from(t).where(...).orderBy(...).limit(1)`.
function drizzleChainAbove(root) {
  const steps = [];
  let current = root;
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

function drizzleSite(call, checker) {
  const name = calleeName(call);
  if (name !== 'from' && name !== 'update' && name !== 'delete') return;
  if (!ts.isPropertyAccessExpression(call.expression)) return;
  if (!declaredInPackage(call.expression, checker, ['drizzle-orm'])) return;
  const table = drizzleTable(call.arguments[0], checker);
  if (!table) return;
  const steps = drizzleChainAbove(call);
  if (!steps) return;
  const site = newSite('drizzle', call.expression.name);
  site.tables = [table];
  for (const step of steps) {
    if (step.name === 'where') drizzleCondition(site, step.call.arguments[0], checker);
    else if (step.name === 'orderBy') site.order = drizzleOrder(site, step.call.arguments, checker);
    else if (step.name === 'limit') site.limited = true;
    else if (drizzleJoins.has(step.name)) {
      const joined = drizzleTable(step.call.arguments[0], checker);
      if (!joined) site.uncertain = true;
      else site.tables.push(joined);
      site.joins = (site.joins ?? 0) + 1;
    } else if (step.name === 'groupBy' || step.name === 'having') site.uncertain = true;
  }
  return site;
}

// ---------------------------------------------------------------- TypeORM

// `this.repo` typed `Repository<User>`, a variable from `getRepository(User)`, or `getRepository(User)` itself.
function repositoryEntity(receiver, checker) {
  const value = unwrap(receiver);
  if (ts.isCallExpression(value) && calleeName(value) === 'getRepository') return value.arguments[0];
  const symbol = resolvedSymbol(value, checker);
  const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
  if (!declaration) return;
  const type = declaration.type;
  if (type && ts.isTypeReferenceNode(type) && type.typeArguments?.length === 1) {
    const argument = type.typeArguments[0];
    if (ts.isTypeReferenceNode(argument)) return argument.typeName;
  }
  const initializer = unwrap(declaration.initializer);
  if (initializer && ts.isCallExpression(initializer) && calleeName(initializer) === 'getRepository') {
    return initializer.arguments[0];
  }
}

function typeormValue(site, table, column, property, checker) {
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
    const operator = resolvedSymbol(value.expression, checker).name;
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

function typeormWhere(site, table, where, checker) {
  const object = unwrap(where);
  if (!object || !ts.isObjectLiteralExpression(object)) {
    site.uncertain = true;
    return;
  }
  for (const property of object.properties) {
    const column = propertyName(property);
    if (!column || (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property))) {
      site.uncertain = true;
    } else if (!table.columns.has(column) || table.columns.get(column).type === 'relation') {
      site.uncertain = true;
    } else typeormValue(site, table, column, property, checker);
  }
}

function typeormOrder(table, order) {
  const object = unwrap(order);
  if (!ts.isObjectLiteralExpression(object)) return null;
  const columns = [];
  for (const property of object.properties) {
    const column = propertyName(property);
    if (!ts.isPropertyAssignment(property) || !table.columns.has(column)) return null;
    const direction = unwrap(property.initializer);
    if (!ts.isStringLiteralLike(direction) && !ts.isNumericLiteral(direction)) return null;
    columns.push({ table, column, node: property.name });
  }
  return columns;
}

function typeormSite(call, checker) {
  const access = call.expression;
  if (!ts.isPropertyAccessExpression(access)) return;
  const method = access.name.text;
  if (!typeormOptionReads.has(method) && !typeormWhereReads.has(method)) return;
  if (!declaredInPackage(access, checker, ['typeorm'])) return;
  const owner = resolvedSymbol(access, checker)?.declarations?.[0]?.parent;
  const ownerName = owner && ts.isClassDeclaration(owner) ? owner.name?.text : undefined;
  let args = [...call.arguments];
  let entity;
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

function readTypeormFindOptions(options, site, table, checker) {
  for (const property of options.properties) {
    const name = propertyName(property);
    if (!name || !ts.isPropertyAssignment(property)) site.uncertain = true;
    else if (name === 'where') typeormWhere(site, table, property.initializer, checker);
    else if (name === 'order') site.order = typeormOrder(table, property.initializer);
    else if (name === 'take') site.limited = true;
    else if (name === 'relations' || name === 'join') site.joins = 1;
  }
}

// ---------------------------------------------------------------- Sequelize

// `[Op.gte]` -> 'gte'.
function sequelizeOperator(property, checker) {
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

function sequelizeValue(site, table, column, property, checker) {
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
    if (!name) {
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

function sequelizeWhere(site, table, where, checker) {
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
function sequelizeOrder(table, order) {
  const list = unwrap(order);
  if (!ts.isArrayLiteralExpression(list)) return null;
  const columns = [];
  for (const element of list.elements) {
    const item = unwrap(element);
    const first = ts.isArrayLiteralExpression(item) && item.elements.length <= 2 ? item.elements[0] : item;
    const column = stringValue(first);
    if (!column || !table.columns.has(column)) return null;
    columns.push({ table, column, node: element });
  }
  return columns;
}

function sequelizeSite(call, checker) {
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

// ---------------------------------------------------------------- Mongoose

function regexIsUnanchored(node) {
  const value = unwrap(node);
  if (value && value.kind === ts.SyntaxKind.RegularExpressionLiteral) {
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

function mongoValue(site, table, column, property, checker) {
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
  const operators = new Map();
  for (const operator of value.properties) {
    const name = ts.isPropertyAssignment(operator) ? propertyName(operator) : undefined;
    if (!name) {
      site.uncertain = true;
      return;
    }
    operators.set(name, operator.initializer);
  }
  if (operators.has('$regex')) {
    const options = stringValue(operators.get('$options'));
    const source =
      regexIsUnanchored(operators.get('$regex')) ??
      (literalText(operators.get('$regex')) === undefined
        ? undefined
        : !literalText(operators.get('$regex')).startsWith('^'));
    const unanchored = options?.includes('i') || source;
    if (unanchored === undefined) site.uncertain = true;
    else
      addCondition(
        { site, table, column, kind: unanchored ? 'pattern' : 'other', node: property.name },
        { operator: 'regex' },
      );
    operators.delete('$regex');
    operators.delete('$options');
  }
  for (const [name] of operators) {
    if (mongoOperators[name]) addCondition({ site, table, column, kind: mongoOperators[name], node: property.name });
    else site.uncertain = true;
  }
}

function mongoFilter(site, table, filter, checker) {
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

function mongoSort(table, spec) {
  const object = unwrap(spec);
  if (!ts.isObjectLiteralExpression(object)) return null;
  const columns = [];
  for (const property of object.properties) {
    const column = propertyName(property);
    if (!ts.isPropertyAssignment(property) || !table.columns.has(column)) return null;
    columns.push({ table, column, node: property.name });
  }
  return columns;
}

function mongooseSite(call, checker) {
  const access = call.expression;
  if (!ts.isPropertyAccessExpression(access) || !mongooseReads.has(access.name.text)) return;
  if (!declaredInPackage(access, checker, ['mongoose'])) return;
  const table = mongooseTableOf(access.expression, checker);
  if (!table) return;
  const site = newSite('mongoose', access.name);
  site.limited = access.name.text === 'findOne' || access.name.text === 'exists';
  if (call.arguments.length) mongoFilter(site, table, call.arguments[0], checker);
  let current = call;
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

// The query this call starts, or undefined when it is not a recognized ORM read.
function querySite(call, checker) {
  return (
    prismaSite(call, checker) ??
    drizzleSite(call, checker) ??
    typeormSite(call, checker) ??
    sequelizeSite(call, checker) ??
    mongooseSite(call, checker)
  );
}

module.exports = { querySite, prismaTableFor, repositoryEntity };
