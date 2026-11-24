import { loadSyntax } from '../compiler.cjs';
import { allDefined, createTable, createColumn, createIndex, mergePrimaryKeys } from './model.cjs';
import {
  declaredInPackage,
  resolvedSymbol,
  calleeName,
  initializerOf,
  stringValue,
  propertyName,
  objectProperty,
  decoratorsOf,
  decoratorCall,
  location,
} from './ts-helpers.cjs';
import type {
  CallExpression,
  ClassDeclaration,
  ClassElement,
  Expression,
  Identifier,
  Node,
  ObjectLiteralExpression,
} from 'typescript';
import type { CheckerAdapter } from '../../shared/types.cjs';
import type { DecoratorCall } from '../types/decorator-call.cjs';
import type { SchemaColumn, SchemaIndex, SchemaIndexKey, SchemaTable } from '../types/schema-model.cjs';

interface ColumnSource {
  name: string;
  dbName: string | undefined;
  type: string;
  node: Node;
}
const ts = loadSyntax();

const sequelizePackages = ['sequelize', 'sequelize-typescript', '@sequelize/core'];
const tables = new WeakMap<Node, SchemaTable | undefined>();

function snakeCase(name: string): string {
  return name.replaceAll(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

// Sequelize's default table name is the pluralized model name.
function pluralize(name: string): string {
  if (/[^aeiou]y$/i.test(name)) return name.slice(0, -1) + 'ies';
  if (/(?:s|x|z|ch|sh)$/i.test(name)) return name + 'es';
  return name + 's';
}

function isTrue(node: Node | undefined): boolean {
  return node?.kind === ts.SyntaxKind.TrueKeyword;
}

// `DataType.BOOLEAN`, `DataTypes.ENUM('a')` or `{ type: DataType.BOOLEAN }`.
function dataTypeName(node: Node | undefined): string | undefined {
  let value: Node | undefined = node && ts.skipOuterExpressions(node);
  if (value && ts.isObjectLiteralExpression(value)) value = objectProperty(value, 'type');
  if (value && ts.isCallExpression(value)) value = ts.skipOuterExpressions(value.expression);
  if (value && ts.isPropertyAccessExpression(value)) return value.name.text.toLowerCase();
}

function columnKind(typeName: string | undefined): string {
  if (typeName === 'boolean') return 'boolean';
  if (typeName === 'enum') return 'enum';
  return typeName ?? 'unknown';
}

// `['a', { name: 'b', order: 'DESC' }, { attribute: 'c' }]` -> index keys; undefined when any is
// unreadable.
function indexKeys(fields: Node | undefined, operator: string | undefined): SchemaIndexKey[] | undefined {
  const value = fields && ts.skipOuterExpressions(fields);
  if (!value || !ts.isArrayLiteralExpression(value) || !value.elements.length) return;
  const keys = value.elements.map((element) => {
    const item = ts.skipOuterExpressions(element);
    const column = stringValue(item) ?? stringValue(objectProperty(item, 'name') ?? objectProperty(item, 'attribute'));
    if (column === undefined) return;
    const key: SchemaIndexKey = { column };
    const order = stringValue(objectProperty(item, 'order'));
    if (order) key.direction = order.toLowerCase();
    const opclass = stringValue(objectProperty(item, 'operator')) ?? operator;
    if (opclass) key.opclass = opclass;
    return key;
  });
  return allDefined(keys) ? keys : undefined;
}

function optionIndex(entry: Expression, line: number): SchemaIndex | undefined {
  const value = ts.skipOuterExpressions(entry);
  if (!ts.isObjectLiteralExpression(value)) return;
  const keys = indexKeys(objectProperty(value, 'fields'), stringValue(objectProperty(value, 'operator')));
  const type = stringValue(objectProperty(value, 'type'))?.toLowerCase();
  if (!keys || (type && type !== 'unique')) return;
  const using = stringValue(objectProperty(value, 'using') ?? objectProperty(value, 'method'));
  const where = objectProperty(value, 'where');
  const index = createIndex({
    name: stringValue(objectProperty(value, 'name')),
    keys,
    unique: isTrue(objectProperty(value, 'unique')) || type === 'unique',
    method: (using ?? 'btree').toLowerCase(),
    predicate: where ? where.getText() : undefined,
    line,
  });
  index.source = 'indexes';
  return index;
}

// A column's own `unique: true`, which Sequelize creates as a unique constraint.
function uniqueColumnIndex(column: string, line: number | undefined): SchemaIndex {
  const index = createIndex({ keys: [{ column }], unique: true, line });
  index.source = 'unique: true';
  index.constraint = true;
  return index;
}

// Model options shared by @Table({...}), Model.init(attrs, {...}) and sequelize.define(name, attrs,
// {...}).
function applyOptions(table: SchemaTable, options: ObjectLiteralExpression | undefined, modelName: string): void {
  const explicit = stringValue(objectProperty(options, 'tableName'));
  const frozen = isTrue(objectProperty(options, 'freezeTableName'));
  table.dbName = explicit ?? (frozen ? modelName : pluralize(modelName));
  table.underscored = isTrue(objectProperty(options, 'underscored'));
  const timestamps = objectProperty(options, 'timestamps');
  const extraColumns: string[] = timestamps?.kind === ts.SyntaxKind.FalseKeyword ? [] : ['createdAt', 'updatedAt'];
  if (isTrue(objectProperty(options, 'paranoid'))) extraColumns.push('deletedAt');
  table.implicitColumns = extraColumns;
  const indexes = objectProperty(options, 'indexes');
  if (!indexes) return;
  if (!ts.isArrayLiteralExpression(indexes)) {
    table.complete = false;
    return;
  }
  for (const entry of indexes.elements) {
    const index = optionIndex(entry, location(entry).line);
    if (index) table.indexes.push(index);
    else table.complete = false;
  }
}

function addColumn(table: SchemaTable, { name, dbName, type, node }: ColumnSource): SchemaColumn {
  const where = location(node);
  const column = createColumn({
    name,
    dbName: dbName ?? name,
    type,
    file: where.file,
    line: where.line,
    column: where.column,
  });
  table.columns.set(name, column);
  return column;
}

function finishTable(table: SchemaTable): SchemaTable {
  mergePrimaryKeys(table);
  for (const name of table.implicitColumns ?? []) {
    if (!table.columns.has(name)) table.columns.set(name, createColumn({ name, dbName: name, type: 'date' }));
  }
  delete table.implicitColumns;
  if (!table.indexes.some((index) => index.primary)) {
    if (!table.columns.has('id')) table.columns.set('id', createColumn({ name: 'id', dbName: 'id', type: 'integer' }));
    table.indexes.push(createIndex({ keys: [{ column: 'id' }], unique: true, primary: true }));
  }
  if (table.underscored) {
    for (const column of table.columns.values()) {
      if (column.dbName === column.name) column.dbName = snakeCase(column.name);
    }
  }
  delete table.underscored;
  for (const index of table.indexes) index.file ??= table.file;
  return table;
}

function newTable(nameNode: Node, modelName: string): SchemaTable {
  const where = location(nameNode);
  const table = createTable({ name: modelName, file: where.file, line: where.line, column: where.column });
  table.orm = 'sequelize';
  table.complete = true;
  return table;
}

// sequelize-typescript: `@Index`, `@Index('name')` or `@Index({ name, unique })`; one name across
// properties is one index.
function decoratorIndex(
  groups: Map<string | symbol, SchemaIndex>,
  decorator: DecoratorCall,
  column: string,
  unique: boolean,
  line: number | undefined,
): void {
  const [argument] = decorator.args;
  const options = argument && ts.skipOuterExpressions(argument);
  const name = stringValue(options) ?? stringValue(objectProperty(options, 'name'));
  const key = name ?? Symbol(column);
  let index = groups.get(key);
  if (!index) {
    const isUnique = unique || isTrue(objectProperty(options, 'unique'));
    index = createIndex({ name, keys: [], unique: isUnique, line });
    // The source tells apart an `@Index` and a `@Unique` on one column, which report on the same
    // line.
    index.source = `@${decorator.name}`;
    if (unique) index.constraint = true;
    groups.set(key, index);
  }
  index.keys.push({ column });
}

function readDecoratedProperty(
  table: SchemaTable,
  member: ClassElement,
  groups: Map<string | symbol, SchemaIndex>,
  checker: CheckerAdapter,
): void {
  if (!ts.isPropertyDeclaration(member) || !member.name || !ts.isIdentifier(member.name)) return;
  const decorators = decoratorsOf(member)
    .map(decoratorCall)
    .filter(
      (decorator): decorator is DecoratorCall =>
        decorator !== undefined && declaredInPackage(decorator.callee, checker, sequelizePackages),
    );
  const columnDecorator = decorators.find((decorator) => decorator.name === 'Column');
  if (!columnDecorator) return;
  const name = member.name.text;
  const options = columnDecorator.args[0] && ts.skipOuterExpressions(columnDecorator.args[0]);
  const typeName =
    dataTypeName(options) ?? (member.type?.kind === ts.SyntaxKind.BooleanKeyword ? 'boolean' : undefined);
  const column = addColumn(table, {
    name,
    dbName: stringValue(objectProperty(options, 'field')),
    type: columnKind(typeName),
    node: member.name,
  });
  const line = column.line;
  const names = new Set(decorators.map((decorator) => decorator.name));
  if (names.has('PrimaryKey') || isTrue(objectProperty(options, 'primaryKey'))) {
    table.indexes.push(createIndex({ keys: [{ column: name }], unique: true, primary: true, line }));
  } else if (isTrue(objectProperty(options, 'unique'))) {
    table.indexes.push(uniqueColumnIndex(name, line));
  }
  for (const decorator of decorators) {
    if (decorator.name === 'Index' || decorator.name === 'Unique') {
      decoratorIndex(groups, decorator, name, decorator.name === 'Unique', line);
    } else if (decorator.name === 'ForeignKey') {
      const target = decorator.args[0] && ts.skipOuterExpressions(decorator.args[0]);
      const body = target && ts.isArrowFunction(target) ? ts.skipOuterExpressions(target.body) : undefined;
      column.foreignKey = { table: body && ts.isIdentifier(body) ? body.text : '', column: 'id' };
    }
  }
}

function tableDecorator(declaration: ClassDeclaration, checker: CheckerAdapter): DecoratorCall | undefined {
  return decoratorsOf(declaration)
    .map(decoratorCall)
    .find(
      (decorator) =>
        decorator?.name === 'Table' && declaredInPackage(decorator.callee, checker, ['sequelize-typescript']),
    );
}

function decoratedTable(
  declaration: ClassDeclaration,
  className: Identifier,
  decorator: DecoratorCall,
  checker: CheckerAdapter,
): SchemaTable {
  const table = newTable(className, className.text);
  const options = decorator.args[0] && ts.skipOuterExpressions(decorator.args[0]);
  applyOptions(table, options && ts.isObjectLiteralExpression(options) ? options : undefined, className.text);
  const groups = new Map<string | symbol, SchemaIndex>();
  for (const member of declaration.members) readDecoratedProperty(table, member, groups, checker);
  table.indexes.push(...groups.values());
  return finishTable(table);
}

// Attribute objects of Model.init and sequelize.define: `{ email: { type, unique: true, field: 'e'
// } }`.
function readAttributes(table: SchemaTable, attributes: ObjectLiteralExpression | undefined): void {
  if (!attributes || !ts.isObjectLiteralExpression(attributes)) {
    table.complete = false;
    return;
  }
  for (const property of attributes.properties) {
    const name = propertyName(property);
    if (!name || !ts.isPropertyAssignment(property)) {
      table.complete = false;
      continue;
    }
    const value = ts.skipOuterExpressions(property.initializer);
    const options = ts.isObjectLiteralExpression(value) ? value : undefined;
    const column = addColumn(table, {
      name,
      dbName: stringValue(objectProperty(options, 'field')),
      type: columnKind(dataTypeName(value)),
      node: property.name,
    });
    if (isTrue(objectProperty(options, 'primaryKey'))) {
      table.indexes.push(createIndex({ keys: [{ column: name }], unique: true, primary: true, line: column.line }));
    } else if (isTrue(objectProperty(options, 'unique'))) {
      table.indexes.push(uniqueColumnIndex(name, column.line));
    }
    const references = objectProperty(options, 'references');
    if (references) {
      const model = objectProperty(references, 'model');
      const target = stringValue(model) ?? (model && ts.isIdentifier(model) ? model.text : '');
      column.foreignKey = { table: target, column: stringValue(objectProperty(references, 'key')) ?? 'id' };
    }
  }
}

function argumentObject(node: Node | undefined): ObjectLiteralExpression | undefined {
  const value = node && ts.skipOuterExpressions(node);
  return value && ts.isObjectLiteralExpression(value) ? value : undefined;
}

// `class User extends Model {}` plus a top-level `User.init(attributes, options)` in the same file.
function initializedTable(declaration: ClassDeclaration, className: Identifier): SchemaTable | undefined {
  const name = className.text;
  const init = declaration
    .getSourceFile()
    .statements.filter(ts.isExpressionStatement)
    .map((statement) => ts.skipOuterExpressions(statement.expression))
    .find(
      (expression): expression is CallExpression =>
        ts.isCallExpression(expression) &&
        ts.isPropertyAccessExpression(expression.expression) &&
        expression.expression.name.text === 'init' &&
        ts.isIdentifier(expression.expression.expression) &&
        expression.expression.expression.text === name,
    );
  if (!init) return;
  const options = argumentObject(init.arguments[1]);
  const table = newTable(className, stringValue(objectProperty(options, 'modelName')) ?? name);
  readAttributes(table, argumentObject(init.arguments[0]));
  applyOptions(table, options, table.name);
  return finishTable(table);
}

function definedTable(call: CallExpression): SchemaTable | undefined {
  const modelName = stringValue(call.arguments[0]);
  if (!modelName) return;
  const table = newTable(call, modelName);
  readAttributes(table, argumentObject(call.arguments[1]));
  applyOptions(table, argumentObject(call.arguments[2]), modelName);
  return finishTable(table);
}

function buildTable(declaration: Node, checker: CheckerAdapter): SchemaTable | undefined {
  if (ts.isClassDeclaration(declaration) && declaration.name) {
    const decorator = tableDecorator(declaration, checker);
    return decorator
      ? decoratedTable(declaration, declaration.name, decorator, checker)
      : initializedTable(declaration, declaration.name);
  }
  if (
    ts.isCallExpression(declaration) &&
    calleeName(declaration) === 'define' &&
    declaredInPackage(declaration.expression, checker, sequelizePackages)
  ) {
    return definedTable(declaration);
  }
}

// `User` in `User.findAll(...)` -> the table its class or `sequelize.define(...)` declares.
function sequelizeTableOf(expression: Expression | undefined, checker: CheckerAdapter): SchemaTable | undefined {
  const value = expression && ts.skipOuterExpressions(expression);
  if (!value || (!ts.isIdentifier(value) && !ts.isPropertyAccessExpression(value))) return;
  const declaration =
    resolvedSymbol(value, checker)?.declarations?.find(ts.isClassDeclaration) ?? initializerOf(value, checker);
  if (!declaration) return;
  if (!tables.has(declaration)) tables.set(declaration, buildTable(declaration, checker));
  return tables.get(declaration);
}

export { sequelizeTableOf };
