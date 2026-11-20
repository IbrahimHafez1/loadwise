'use strict';

const { syntax: ts } = require('../compiler.cjs');
const { createTable, createColumn, createIndex } = require('./model.cjs');
const {
  declaredInPackage,
  resolvedSymbol,
  stringValue,
  objectProperty,
  decoratorsOf,
  decoratorCall,
  location,
} = require('./ts-helpers.cjs');

const typeormPackages = ['typeorm'];
const primaryDecorators = new Set(['PrimaryColumn', 'PrimaryGeneratedColumn', 'ObjectIdColumn']);
const columnDecorators = new Set([
  'Column',
  'CreateDateColumn',
  'UpdateDateColumn',
  'DeleteDateColumn',
  'VersionColumn',
  ...primaryDecorators,
]);
const relationDecorators = new Set(['ManyToOne', 'OneToOne']);
// Each step up the class hierarchy is one declaration lookup; real entity bases are one or two levels deep.
const maxInheritanceDepth = 5;
const tables = new WeakMap();

function typeormDecorators(node, checker) {
  return decoratorsOf(node)
    .map(decoratorCall)
    .filter((decorator) => decorator && declaredInPackage(decorator.callee, checker, typeormPackages));
}

function snakeCase(name) {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1_$2')
    .toLowerCase();
}

function stringList(node) {
  const value = node && ts.skipOuterExpressions(node);
  if (!value || !ts.isArrayLiteralExpression(value)) return;
  const items = value.elements.map(stringValue);
  return items.every((item) => item !== undefined) ? items : undefined;
}

// `(entity) => [entity.a, entity.b]` names the same properties as `['a', 'b']`.
function propertyList(node) {
  const value = node && ts.skipOuterExpressions(node);
  if (!value || !ts.isArrowFunction(value)) return stringList(value);
  const body = ts.skipOuterExpressions(value.body);
  if (!ts.isArrayLiteralExpression(body)) return;
  const names = body.elements.map((element) => {
    const item = ts.skipOuterExpressions(element);
    return ts.isPropertyAccessExpression(item) ? item.name.text : undefined;
  });
  return names.every(Boolean) ? names : undefined;
}

function optionsArgument(args) {
  return args.map((argument) => ts.skipOuterExpressions(argument)).find(ts.isObjectLiteralExpression);
}

function booleanOption(options, name) {
  return objectProperty(options, name)?.kind === ts.SyntaxKind.TrueKeyword;
}

// `@Index(['a', 'b'], { unique, where })`, `@Index('name', ['a'])` or `@Unique('name', ['a'])`.
function classIndex(decorator, line) {
  const [first, second] = decorator.args;
  const name = stringValue(first);
  const columns = propertyList(name === undefined ? first : second);
  if (!columns?.length) return;
  const options = optionsArgument(decorator.args);
  const isUnique = decorator.name === 'Unique' || booleanOption(options, 'unique');
  return createIndex({
    name,
    keys: columns.map((column) => ({ column })),
    unique: isUnique,
    predicate: decorator.name === 'Index' ? stringValue(objectProperty(options, 'where')) : undefined,
    line,
  });
}

function columnOptions(decorator) {
  const options = optionsArgument(decorator.args);
  const typeName = stringValue(decorator.args[0]) ?? stringValue(objectProperty(options, 'type'));
  return { options, typeName };
}

function columnType(typeName, options, property) {
  if (typeName === 'boolean' || typeName === 'bool' || objectProperty(options, 'enum')) {
    return typeName === 'boolean' || typeName === 'bool' ? 'boolean' : 'enum';
  }
  if (typeName) return typeName;
  return property.type?.kind === ts.SyntaxKind.BooleanKeyword ? 'boolean' : 'unknown';
}

function readProperty(table, property, checker) {
  if (!ts.isPropertyDeclaration(property) || !property.name || !ts.isIdentifier(property.name)) return;
  const decorators = typeormDecorators(property, checker);
  const name = property.name.text;
  const where = location(property.name);
  const columnDecorator = decorators.find((decorator) => columnDecorators.has(decorator.name));
  const relation = decorators.find((decorator) => relationDecorators.has(decorator.name));
  const joinColumn = decorators.find((decorator) => decorator.name === 'JoinColumn');
  if (columnDecorator) {
    const { options, typeName } = columnOptions(columnDecorator);
    table.columns.set(
      name,
      createColumn({
        name,
        dbName: stringValue(objectProperty(options, 'name')) ?? name,
        type: columnType(typeName, options, property),
        file: where.file,
        line: where.line,
        column: where.column,
      }),
    );
    const primary = primaryDecorators.has(columnDecorator.name) || booleanOption(options, 'primary');
    if (primary || booleanOption(options, 'unique')) {
      table.indexes.push(createIndex({ keys: [{ column: name }], unique: true, primary, line: where.line }));
    }
  } else if (relation && joinColumn) {
    readJoinColumn(table, { name, where, relation, joinColumn });
  }
  for (const decorator of decorators.filter((candidate) => candidate.name === 'Index')) {
    const options = optionsArgument(decorator.args);
    table.indexes.push(
      createIndex({
        name: stringValue(decorator.args[0]),
        keys: [{ column: name }],
        unique: booleanOption(options, 'unique'),
        predicate: stringValue(objectProperty(options, 'where')),
        line: where.line,
      }),
    );
  }
}

// The owning side of a relation: its database column is the explicit @JoinColumn name.
function readJoinColumn(table, { name, where, relation, joinColumn }) {
  const options = optionsArgument(joinColumn.args);
  const dbName = stringValue(objectProperty(options, 'name'));
  const target = relation.args[0] && ts.skipOuterExpressions(relation.args[0]);
  const targetName =
    target && ts.isArrowFunction(target) && ts.isIdentifier(ts.skipOuterExpressions(target.body))
      ? ts.skipOuterExpressions(target.body).text
      : '';
  const foreignKey = {
    table: targetName,
    column: stringValue(objectProperty(options, 'referencedColumnName')) ?? 'id',
    explicitName: dbName !== undefined,
    property: name,
  };
  const existing = [...table.columns.values()].find((column) => dbName !== undefined && column.dbName === dbName);
  if (existing) existing.foreignKey = foreignKey;
  else {
    const column = createColumn({
      name,
      dbName: dbName ?? name + 'Id',
      type: 'relation',
      file: where.file,
      line: where.line,
      column: where.column,
      foreignKey,
    });
    table.columns.set(name, column);
  }
  // TypeORM backs the owning side of a one-to-one with a unique constraint.
  if (relation.name === 'OneToOne') {
    table.indexes.push(createIndex({ keys: [{ column: dbName ?? name + 'Id' }], unique: true, line: where.line }));
  }
}

function baseClass(declaration, checker) {
  const clause = declaration.heritageClauses?.find((heritage) => heritage.token === ts.SyntaxKind.ExtendsKeyword);
  const expression = clause?.types[0]?.expression;
  if (!expression) return;
  const base = resolvedSymbol(expression, checker)?.declarations?.find((candidate) => ts.isClassDeclaration(candidate));
  return base && !declaredInPackage(expression, checker, typeormPackages) ? base : undefined;
}

// Parents first, so the entity's own declarations replace inherited ones of the same name.
function classChain(declaration, checker) {
  const chain = [declaration];
  for (let depth = 0; depth < maxInheritanceDepth; depth++) {
    const base = baseClass(chain[0], checker);
    if (!base) break;
    chain.unshift(base);
  }
  return chain;
}

function entityDecorator(declaration, checker) {
  return typeormDecorators(declaration, checker).find((decorator) =>
    ['Entity', 'ViewEntity', 'ChildEntity'].includes(decorator.name),
  );
}

function buildTable(declaration, checker) {
  const entity = entityDecorator(declaration, checker);
  if (!entity || entity.name !== 'Entity' || !declaration.name) return;
  const options = optionsArgument(entity.args);
  const tableName = stringValue(entity.args[0]) ?? stringValue(objectProperty(options, 'name'));
  const schemaName = stringValue(objectProperty(options, 'schema'));
  const baseName = tableName ?? snakeCase(declaration.name.text);
  const where = location(declaration.name);
  const table = createTable({
    name: declaration.name.text,
    dbName: schemaName ? schemaName + '.' + baseName : baseName,
    file: where.file,
    line: where.line,
    column: where.column,
  });
  table.orm = 'typeorm';
  table.complete = true;
  for (const owner of classChain(declaration, checker)) {
    for (const member of owner.members) readProperty(table, member, checker);
    for (const decorator of typeormDecorators(owner, checker)) {
      if (decorator.name !== 'Index' && decorator.name !== 'Unique') continue;
      const index = classIndex(decorator, location(owner.name ?? owner).line);
      if (index) table.indexes.push(index);
      else table.complete = false;
    }
  }
  for (const index of table.indexes) index.file = where.file;
  return table;
}

// The table an `@Entity()` class declares; undefined for any other class, views included.
function typeormTable(declaration, checker) {
  if (!declaration || !ts.isClassDeclaration(declaration)) return;
  if (!tables.has(declaration)) tables.set(declaration, buildTable(declaration, checker));
  return tables.get(declaration);
}

// `User` (an identifier naming an entity class) -> its table.
function typeormTableOf(expression, checker) {
  const value = expression && ts.skipOuterExpressions(expression);
  if (!value || (!ts.isIdentifier(value) && !ts.isPropertyAccessExpression(value))) return;
  const declaration = resolvedSymbol(value, checker)?.declarations?.find((candidate) =>
    ts.isClassDeclaration(candidate),
  );
  return typeormTable(declaration, checker);
}

module.exports = { typeormTable, typeormTableOf, typeormDecorators };
