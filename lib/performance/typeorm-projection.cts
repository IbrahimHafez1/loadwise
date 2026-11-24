import { loadSyntax } from './compiler.cjs';
import { isStandardArrayCall } from './repeated.cjs';
import type { CallExpression, ClassDeclaration, Expression, Node } from 'typescript';
import type { CheckerAdapter, PerformanceRuleContext } from '../shared/types.cjs';
const ts = loadSyntax();

/**
 * Whether a `@Column` is loaded by default, and whether its type is a wide one (text, json, blob).
 */
interface ColumnInfo {
  selected: boolean;
  wide: boolean;
}

/** The selected, wide and primary column names of an entity and the entities it extends. */
interface EntityColumns {
  columns: Set<string>;
  wide: Set<string>;
  primary: Set<string>;
}

/** The columns collected so far plus every property name already seen across the class chain. */
interface ColumnCollection extends EntityColumns {
  properties: Set<string>;
}

/** The entity a row mapper reads and the column names it keeps. */
interface MappedColumns {
  entity: Node;
  names: Set<string>;
}

const wideTypes = new Set([
  'text',
  'mediumtext',
  'longtext',
  'json',
  'jsonb',
  'simple-json',
  'blob',
  'mediumblob',
  'longblob',
  'bytea',
  'clob',
  'nclob',
]);
const columnKinds = new Set([
  'Column',
  'PrimaryColumn',
  'PrimaryGeneratedColumn',
  'CreateDateColumn',
  'UpdateDateColumn',
  'DeleteDateColumn',
  'VersionColumn',
]);
const schemaMetadata = new Set(['Entity', 'Index', 'Check', 'Unique']);
const scalarFlags =
  ts.TypeFlags.StringLike |
  ts.TypeFlags.NumberLike |
  ts.TypeFlags.BooleanLike |
  ts.TypeFlags.BigIntLike |
  ts.TypeFlags.Null |
  ts.TypeFlags.Undefined;

function decoratorName(call: CallExpression, checker: CheckerAdapter): string | undefined {
  const expression = call.expression;
  const name = ts.isPropertyAccessExpression(expression) ? expression.name : expression;
  if (!ts.isIdentifier(name)) return;
  let symbol = checker.getSymbolAtLocation(name);
  if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
  const declarations = symbol?.declarations;
  if (
    symbol &&
    declarations?.length &&
    declarations.every((node: Node) => {
      const file = node.getSourceFile();
      return (
        file.isDeclarationFile &&
        file.fileName.replaceAll('\\', '/').split('/node_modules/').at(-1)?.startsWith('typeorm/')
      );
    })
  )
    return symbol.name;
}

function columnInfo(call: CallExpression): ColumnInfo | undefined {
  let type: string | undefined;
  let selected = true;
  for (const argument of call.arguments) {
    if (ts.isStringLiteralLike(argument)) {
      type = argument.text;
      continue;
    }
    if (!ts.isObjectLiteralExpression(argument)) return;
    for (const property of argument.properties) {
      if (!ts.isPropertyAssignment(property) || !(ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)))
        return;
      const key = property.name.text;
      if (key === 'transformer' || key === 'asExpression' || key === 'primary') return;
      if (key === 'type' && ts.isStringLiteralLike(property.initializer)) type = property.initializer.text;
      if (key === 'select') selected = property.initializer.kind === ts.SyntaxKind.TrueKeyword;
    }
  }
  return { selected, wide: type !== undefined && wideTypes.has(type) };
}

/**
 * Reads the class decorators; `undefined` when one is not schema metadata, else whether `@Entity`
 * is present.
 */
function hasEntityDecorator(entity: ClassDeclaration, checker: CheckerAdapter): boolean | undefined {
  let found = false;
  for (const modifier of entity.modifiers ?? []) {
    if (!ts.isDecorator(modifier)) continue;
    const name = ts.isCallExpression(modifier.expression) ? decoratorName(modifier.expression, checker) : undefined;
    if (name === undefined || !schemaMetadata.has(name)) return;
    if (name === 'Entity') found = true;
  }
  return found;
}

/**
 * Collects the column decorators of one class; `false` when a member is not a plain column
 * property.
 */
function collectMemberColumns(
  entity: ClassDeclaration,
  checker: CheckerAdapter,
  collection: ColumnCollection,
): boolean {
  const { columns, wide, primary, properties } = collection;
  for (const member of entity.members) {
    if (!ts.isPropertyDeclaration(member) || !ts.isIdentifier(member.name) || properties.has(member.name.text))
      return false;
    properties.add(member.name.text);
    for (const modifier of member.modifiers ?? []) {
      if (!ts.isDecorator(modifier)) continue;
      if (!ts.isCallExpression(modifier.expression)) return false;
      const name = decoratorName(modifier.expression, checker);
      if (name === 'Index') continue;
      if (name === undefined || !columnKinds.has(name) || columns.has(member.name.text)) return false;
      const info = columnInfo(modifier.expression);
      if (!info) return false;
      collectSelectedColumn(info, columns, member.name.text, wide);
      if (name === 'PrimaryColumn' || name === 'PrimaryGeneratedColumn') primary.add(member.name.text);
    }
  }
  return true;
}

function entityColumns(entity: Node | undefined, checker: CheckerAdapter): EntityColumns | undefined {
  const columns = new Set<string>();
  const wide = new Set<string>();
  const primary = new Set<string>();
  const visited = new Set<Node>();
  const properties = new Set<string>();
  let isEntity = false;
  while (entity && !visited.has(entity)) {
    if (!ts.isClassDeclaration(entity) || entity.getSourceFile().isDeclarationFile) return;
    visited.add(entity);
    const declaresEntity = hasEntityDecorator(entity, checker);
    if (declaresEntity === undefined) return;
    if (declaresEntity && visited.size === 1) isEntity = true;
    if (!collectMemberColumns(entity, checker, { columns, wide, primary, properties })) return;
    const inherited = entity.heritageClauses?.find((clause) => clause.token === ts.SyntaxKind.ExtendsKeyword);
    if (!inherited) return isEntity ? { columns, wide, primary } : undefined;
    const base = inherited.types[0];
    if (!base || !ts.isIdentifier(base.expression)) return;
    entity = checker.getTypeAtLocation(base).getSymbol()?.valueDeclaration;
  }
}

function collectSelectedColumn(info: ColumnInfo, columns: Set<string>, memberName: string, wide: Set<string>): void {
  if (info.selected) {
    columns.add(memberName);
    if (info.wide) wide.add(memberName);
  }
}

function mappedColumns(callback: Expression, checker: CheckerAdapter): MappedColumns | undefined {
  if (!ts.isArrowFunction(callback) || callback.parameters.length !== 1 || callback.modifiers?.length) return;
  const parameter = callback.parameters[0];
  if (!ts.isIdentifier(parameter.name) || parameter.type || parameter.initializer) return;
  let body = callback.body;
  while (ts.isParenthesizedExpression(body)) body = body.expression;
  if (!ts.isObjectLiteralExpression(body) || !body.properties.length) return;
  const names = new Set<string>();
  for (const property of body.properties) {
    if (!ts.isPropertyAssignment(property) || !(ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)))
      return;
    const read = property.initializer;
    if (
      !ts.isPropertyAccessExpression(read) ||
      !ts.isIdentifier(read.expression) ||
      read.expression.text !== parameter.name.text ||
      read.questionDotToken ||
      !ts.isIdentifier(read.name)
    )
      return;
    const type = checker.getTypeAtLocation(read);
    const variants = type.isUnion() && type.types ? type.types : [type];
    if (variants.some((variant) => !(variant.flags & scalarFlags))) return;
    names.add(read.name.text);
  }
  const entity = checker.getTypeAtLocation(parameter.name).getSymbol()?.valueDeclaration;
  if (entity) return { entity, names };
}

function returnedRowMap(awaited: Node): CallExpression | undefined {
  let receiver = awaited;
  while (ts.isParenthesizedExpression(receiver.parent)) receiver = receiver.parent;
  if (ts.isVariableDeclaration(receiver.parent)) {
    const declaration = receiver.parent;
    const list = declaration.parent;
    const statement = list.parent;
    if (
      declaration.initializer !== receiver ||
      !ts.isIdentifier(declaration.name) ||
      declaration.type ||
      !ts.isVariableDeclarationList(list) ||
      !(list.flags & ts.NodeFlags.Const) ||
      list.declarations.length !== 1 ||
      !ts.isVariableStatement(statement) ||
      !ts.isBlock(statement.parent)
    )
      return;
    const statements = statement.parent.statements;
    // The local cannot escape if declaration and mapping return are the only statements in a
    // function body.
    if (statements.length !== 2 || statements[0] !== statement || !ts.isFunctionLike(statement.parent.parent)) return;
    const returned = statements[1];
    if (!ts.isReturnStatement(returned) || !returned.expression || !ts.isCallExpression(returned.expression)) return;
    const method = returned.expression.expression;
    if (
      !ts.isPropertyAccessExpression(method) ||
      !ts.isIdentifier(method.expression) ||
      method.expression.text !== declaration.name.text
    )
      return;
    receiver = method.expression;
  }
  const method = receiver.parent;
  if (!ts.isPropertyAccessExpression(method) || method.expression !== receiver || method.name.text !== 'map') return;
  const call = method.parent;
  if (
    ts.isCallExpression(call) &&
    call.expression === method &&
    call.arguments.length === 1 &&
    ts.isReturnStatement(call.parent)
  )
    return call;
}

function checkTypeormProjection(call: CallExpression, rowMap: CallExpression, context: PerformanceRuleContext): void {
  if (!isStandardArrayCall(rowMap, context.checker)) return;
  const projection = mappedColumns(rowMap.arguments[0], context.checker);
  if (!projection) return;
  const metadata = entityColumns(projection.entity, context.checker);
  if (
    !metadata ||
    !metadata.primary.size ||
    [...metadata.primary].some((name) => !projection.names.has(name)) ||
    [...projection.names].some((name) => !metadata.columns.has(name))
  )
    return;
  const unused = [...metadata.wide].filter((name) => !projection.names.has(name));
  if (!unused.length) return;
  const selection = [...projection.names].map((name) => name + ': true').join(', ');
  const callee = call.expression;
  if (!ts.isPropertyAccessExpression(callee)) return;
  context.report(
    callee.name,
    'typeorm-wide-projection',
    `Consider select: { ${selection} } to avoid loading unused wide columns (${unused.join(', ')}). Confirm that subscribers and loaders do not need the full entity.`,
  );
}

function isWhereOnlyOptions(call: CallExpression): boolean {
  if (!call.arguments.length) return true;
  const [options] = call.arguments;
  return (
    call.arguments.length === 1 &&
    ts.isObjectLiteralExpression(options) &&
    options.properties.every(
      (property) =>
        (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) &&
        !ts.isComputedPropertyName(property.name) &&
        property.name.text === 'where',
    )
  );
}

export { isWhereOnlyOptions, returnedRowMap, checkTypeormProjection, wideTypes };
