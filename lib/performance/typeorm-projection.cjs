'use strict';

const { syntax: ts } = require('./compiler.cjs');
const { isStandardArrayCall } = require('./repeated.cjs');

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

function decoratorName(call, checker) {
  const expression = call.expression;
  const name = ts.isPropertyAccessExpression(expression) ? expression.name : expression;
  if (!ts.isIdentifier(name)) return;
  let symbol = checker.getSymbolAtLocation(name);
  if (symbol?.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
  const declarations = symbol?.declarations;
  if (
    declarations?.length &&
    declarations.every((node) => {
      const file = node.getSourceFile();
      return (
        file.isDeclarationFile &&
        file.fileName.replaceAll('\\', '/').split('/node_modules/').at(-1).startsWith('typeorm/')
      );
    })
  )
    return symbol.name;
}

function columnInfo(call) {
  let type;
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
  return { selected, wide: wideTypes.has(type) };
}

function entityColumns(entity, checker) {
  const columns = new Set();
  const wide = new Set();
  const primary = new Set();
  const visited = new Set();
  const properties = new Set();
  let isEntity = false;
  while (entity && !visited.has(entity)) {
    if (!ts.isClassDeclaration(entity) || entity.getSourceFile().isDeclarationFile) return;
    visited.add(entity);
    for (const modifier of entity.modifiers ?? []) {
      if (!ts.isDecorator(modifier)) continue;
      const name = ts.isCallExpression(modifier.expression) && decoratorName(modifier.expression, checker);
      if (!schemaMetadata.has(name)) return;
      if (name === 'Entity' && visited.size === 1) isEntity = true;
    }
    for (const member of entity.members) {
      if (!ts.isPropertyDeclaration(member) || !ts.isIdentifier(member.name) || properties.has(member.name.text))
        return;
      properties.add(member.name.text);
      for (const modifier of member.modifiers ?? []) {
        if (!ts.isDecorator(modifier)) continue;
        if (!ts.isCallExpression(modifier.expression)) return;
        const name = decoratorName(modifier.expression, checker);
        if (name === 'Index') continue;
        if (!columnKinds.has(name) || columns.has(member.name.text)) return;
        const info = columnInfo(modifier.expression);
        if (!info) return;
        collectSelectedColumn(info, columns, member, wide);
        if (name === 'PrimaryColumn' || name === 'PrimaryGeneratedColumn') primary.add(member.name.text);
      }
    }
    const inherited = entity.heritageClauses?.find((clause) => clause.token === ts.SyntaxKind.ExtendsKeyword);
    if (!inherited) return isEntity ? { columns, wide, primary } : undefined;
    const base = inherited.types[0];
    if (!base || !ts.isIdentifier(base.expression)) return;
    entity = checker.getTypeAtLocation(base).getSymbol()?.valueDeclaration;
  }
}

function collectSelectedColumn(info, columns, member, wide) {
  if (info.selected) {
    columns.add(member.name.text);
    if (info.wide) wide.add(member.name.text);
  }
}

function mappedColumns(callback, checker) {
  if (!ts.isArrowFunction(callback) || callback.parameters.length !== 1 || callback.modifiers?.length) return;
  const parameter = callback.parameters[0];
  if (!ts.isIdentifier(parameter.name) || parameter.type || parameter.initializer) return;
  let body = callback.body;
  while (ts.isParenthesizedExpression(body)) body = body.expression;
  if (!ts.isObjectLiteralExpression(body) || !body.properties.length) return;
  const names = new Set();
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
    const variants = type.isUnion() ? type.types : [type];
    if (variants.some((variant) => !(variant.flags & scalarFlags))) return;
    names.add(read.name.text);
  }
  const entity = checker.getTypeAtLocation(parameter.name).getSymbol()?.valueDeclaration;
  if (entity) return { entity, names };
}

function returnedRowMap(awaited) {
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
      !(list.flags & ts.NodeFlags.Const) ||
      list.declarations.length !== 1 ||
      !ts.isVariableStatement(statement) ||
      !ts.isBlock(statement.parent)
    )
      return;
    const statements = statement.parent.statements;
    // The local cannot escape if declaration and mapping return are the only statements in a function body.
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

function checkTypeormProjection(call, rowMap, context) {
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
  context.report(
    call.expression.name,
    'typeorm-wide-projection',
    `Consider select: { ${selection} } to avoid loading unused wide columns (${unused.join(', ')}). Confirm that subscribers and loaders do not need the full entity.`,
  );
}

function isWhereOnlyOptions(call) {
  if (!call.arguments.length) return true;
  const [options] = call.arguments;
  return (
    call.arguments.length === 1 &&
    ts.isObjectLiteralExpression(options) &&
    options.properties.every(
      (property) =>
        (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) &&
        property.name.text === 'where',
    )
  );
}

module.exports = { isWhereOnlyOptions, returnedRowMap, checkTypeormProjection, wideTypes };
