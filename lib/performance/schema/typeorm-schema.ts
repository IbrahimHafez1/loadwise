import { ts } from '../compiler.js';
import { allDefined, createTable, createColumn, createIndex, mergePrimaryKeys } from './model.js';
import {
  declaredInPackage,
  resolvedSymbol,
  stringValue,
  objectProperty,
  decoratorsOf,
  decoratorCall,
  location,
} from './ts-helpers.js';
import type {
  ClassDeclaration,
  ClassElement,
  Expression,
  Node,
  ObjectLiteralExpression,
  PropertyDeclaration,
} from 'typescript';
import type { CheckerAdapter } from '../../shared/types.js';
import type { DecoratorCall } from '../types/decorator-call.js';
import type { FileLocation } from '../types/source-position.js';
import type { SchemaIndex, SchemaTable } from '../types/schema-model.js';

interface JoinColumnInput {
  name: string;
  where: FileLocation;
  relation: DecoratorCall;
  joinColumn: DecoratorCall;
}

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
// Each step up the class hierarchy is one declaration lookup; real entity bases are one or two
// levels deep.
const maxInheritanceDepth = 5;
const tables = new WeakMap<ClassDeclaration, SchemaTable | undefined>();

function typeormDecorators(node: Node, checker: CheckerAdapter): DecoratorCall[] {
  return decoratorsOf(node)
    .map(decoratorCall)
    .filter(
      (decorator): decorator is DecoratorCall =>
        decorator !== undefined && declaredInPackage(decorator.callee, checker, typeormPackages),
    );
}

function snakeCase(name: string): string {
  return name
    .replaceAll(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replaceAll(/([A-Z])([A-Z][a-z])/g, '$1_$2')
    .toLowerCase();
}

function stringList(node: Node | undefined): string[] | undefined {
  const value = node && ts.skipOuterExpressions(node);
  if (!value || !ts.isArrayLiteralExpression(value)) return;
  const items = value.elements.map((element) => stringValue(element));
  return allDefined(items) ? items : undefined;
}

// `(entity) => [entity.a, entity.b]` names the same properties as `['a', 'b']`.
function propertyList(node: Node | undefined): string[] | undefined {
  const value = node && ts.skipOuterExpressions(node);
  if (!value || !ts.isArrowFunction(value)) return stringList(value);
  const body = ts.skipOuterExpressions(value.body);
  if (!ts.isArrayLiteralExpression(body)) return;
  const names = body.elements.map((element) => {
    const item = ts.skipOuterExpressions(element);
    return ts.isPropertyAccessExpression(item) ? item.name.text : undefined;
  });
  return allDefined(names) ? names : undefined;
}

function optionsArgument(args: readonly Expression[]): ObjectLiteralExpression | undefined {
  return args.map((argument) => ts.skipOuterExpressions(argument)).find(ts.isObjectLiteralExpression);
}

function booleanOption(options: ObjectLiteralExpression | undefined, name: string): boolean {
  return objectProperty(options, name)?.kind === ts.SyntaxKind.TrueKeyword;
}

// Any `where` makes the index partial. A template with substitutions has no static text, so its
// source stands in.
function wherePredicate(options: ObjectLiteralExpression | undefined): string | undefined {
  const where = objectProperty(options, 'where');
  return where && (stringValue(where) ?? where.getText());
}

// `source` names the decorator or option that declares the index, since one column can carry
// several.
function withSource(index: SchemaIndex, source: string, constraint?: boolean): SchemaIndex {
  index.source = source;
  if (constraint) index.constraint = true;
  return index;
}

// `@Index(['a', 'b'], { unique, where })`, `@Index('name', ['a'])` or `@Unique('name', ['a'])`.
function classIndex(decorator: DecoratorCall, line: number): SchemaIndex | undefined {
  const [first, second] = decorator.args;
  const name = stringValue(first);
  const columns = propertyList(name === undefined ? first : second);
  if (!columns?.length) return;
  const options = optionsArgument(decorator.args);
  const isUnique = decorator.name === 'Unique' || booleanOption(options, 'unique');
  const index = createIndex({
    name,
    keys: columns.map((column) => ({ column })),
    unique: isUnique,
    predicate: decorator.name === 'Index' ? wherePredicate(options) : undefined,
    line,
  });
  return withSource(index, `@${decorator.name}`, decorator.name === 'Unique');
}

function columnOptions(decorator: DecoratorCall): {
  options: ObjectLiteralExpression | undefined;
  typeName: string | undefined;
} {
  const options = optionsArgument(decorator.args);
  const typeName = stringValue(decorator.args[0]) ?? stringValue(objectProperty(options, 'type'));
  return { options, typeName };
}

function columnType(
  typeName: string | undefined,
  options: ObjectLiteralExpression | undefined,
  property: PropertyDeclaration,
): string {
  if (typeName === 'boolean' || typeName === 'bool' || objectProperty(options, 'enum')) {
    return typeName === 'boolean' || typeName === 'bool' ? 'boolean' : 'enum';
  }
  if (typeName) return typeName;
  return property.type?.kind === ts.SyntaxKind.BooleanKeyword ? 'boolean' : 'unknown';
}

function readProperty(table: SchemaTable, property: ClassElement, checker: CheckerAdapter): void {
  if (!ts.isPropertyDeclaration(property) || !property.name || !ts.isIdentifier(property.name)) return;
  const decorators = typeormDecorators(property, checker);
  const name = property.name.text;
  const where = location(property.name);
  const columnDecorator = decorators.find((decorator) => columnDecorators.has(decorator.name));
  const relation = decorators.find((decorator) => relationDecorators.has(decorator.name));
  const joinColumn = decorators.find((decorator) => decorator.name === 'JoinColumn');
  if (columnDecorator) {
    const { options, typeName } = columnOptions(columnDecorator);
    const column = createColumn({
      name,
      dbName: stringValue(objectProperty(options, 'name')) ?? name,
      type: columnType(typeName, options, property),
      file: where.file,
      line: where.line,
      column: where.column,
    });
    // The type of an array column names its element, so `text` with `array: true` is a list of
    // short strings.
    if (booleanOption(options, 'array')) column.array = true;
    table.columns.set(name, column);
    const primary = primaryDecorators.has(columnDecorator.name) || booleanOption(options, 'primary');
    if (primary) table.indexes.push(createIndex({ keys: [{ column: name }], unique: true, primary, line: where.line }));
    else if (booleanOption(options, 'unique')) {
      const index = createIndex({ keys: [{ column: name }], unique: true, line: where.line });
      table.indexes.push(withSource(index, 'unique: true', true));
    }
  } else if (relation && joinColumn) {
    readJoinColumn(table, { name, where, relation, joinColumn });
  }
  for (const decorator of decorators.filter((candidate) => candidate.name === 'Index')) {
    const options = optionsArgument(decorator.args);
    const index = createIndex({
      name: stringValue(decorator.args[0]),
      keys: [{ column: name }],
      unique: booleanOption(options, 'unique'),
      predicate: wherePredicate(options),
      line: where.line,
    });
    table.indexes.push(withSource(index, '@Index'));
  }
}

// The owning side of a relation: its database column is the explicit @JoinColumn name.
function readJoinColumn(table: SchemaTable, { name, where, relation, joinColumn }: JoinColumnInput): void {
  const options = optionsArgument(joinColumn.args);
  const dbName = stringValue(objectProperty(options, 'name'));
  const target = relation.args[0] && ts.skipOuterExpressions(relation.args[0]);
  const targetBody = target && ts.isArrowFunction(target) ? ts.skipOuterExpressions(target.body) : undefined;
  const targetName = targetBody && ts.isIdentifier(targetBody) ? targetBody.text : '';
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

function baseClass(declaration: ClassDeclaration, checker: CheckerAdapter): ClassDeclaration | undefined {
  const clause = declaration.heritageClauses?.find((heritage) => heritage.token === ts.SyntaxKind.ExtendsKeyword);
  const expression = clause?.types[0]?.expression;
  if (!expression) return;
  const base = resolvedSymbol(expression, checker)?.declarations?.find(ts.isClassDeclaration);
  return base && !declaredInPackage(expression, checker, typeormPackages) ? base : undefined;
}

// Parents first, so the entity's own declarations replace inherited ones of the same name.
function classChain(declaration: ClassDeclaration, checker: CheckerAdapter): ClassDeclaration[] {
  const chain = [declaration];
  for (let depth = 0; depth < maxInheritanceDepth; depth++) {
    const base = baseClass(chain[0], checker);
    if (!base) break;
    chain.unshift(base);
  }
  return chain;
}

function entityDecorator(declaration: ClassDeclaration, checker: CheckerAdapter): DecoratorCall | undefined {
  return typeormDecorators(declaration, checker).find((decorator) =>
    ['Entity', 'ViewEntity', 'ChildEntity'].includes(decorator.name),
  );
}

function buildTable(declaration: ClassDeclaration, checker: CheckerAdapter): SchemaTable | undefined {
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
    const ownerLocation = location(owner.name ?? owner);
    const firstOwnIndex = table.indexes.length;
    for (const member of owner.members) readProperty(table, member, checker);
    for (const decorator of typeormDecorators(owner, checker)) {
      if (decorator.name !== 'Index' && decorator.name !== 'Unique') continue;
      const index = classIndex(decorator, ownerLocation.line);
      if (index) table.indexes.push(index);
      else table.complete = false;
    }
    // An inherited index keeps the base class's file, so its line is read in the file that declares
    // it.
    for (const index of table.indexes.slice(firstOwnIndex)) index.file = ownerLocation.file;
  }
  mergePrimaryKeys(table);
  for (const index of table.indexes) index.file ??= where.file;
  return table;
}

// The table an `@Entity()` class declares; undefined for any other class, views included.
function typeormTable(declaration: Node | undefined, checker: CheckerAdapter): SchemaTable | undefined {
  if (!declaration || !ts.isClassDeclaration(declaration)) return;
  if (!tables.has(declaration)) tables.set(declaration, buildTable(declaration, checker));
  return tables.get(declaration);
}

// `User` (an identifier naming an entity class) -> its table.
function typeormTableOf(expression: Node | undefined, checker: CheckerAdapter): SchemaTable | undefined {
  const value = expression && ts.skipOuterExpressions(expression);
  if (!value || (!ts.isIdentifier(value) && !ts.isPropertyAccessExpression(value))) return;
  const declaration = resolvedSymbol(value, checker)?.declarations?.find(ts.isClassDeclaration);
  return typeormTable(declaration, checker);
}

export { typeormTable, typeormTableOf };
