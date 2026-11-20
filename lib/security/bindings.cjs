'use strict';

// Recognises which library a call goes to. The import tier reads only project-local syntax (import and require
// bindings, type annotations), so it works when node_modules is missing; the type tier needs installed packages.
// The import tier is tried first: with types installed a call is recognised whenever it is without them, so a rule
// never reports more findings with fewer types.
const { syntax: ts, isDefaultLibrary } = require('../performance/compiler.cjs');

// Method names that belong to one library in practice, so the bare name identifies it. Never add generic names
// such as query, get, raw, exec, find, save, sign or verify.
const uniqueMethodNames = new Set([
  '$queryRawUnsafe',
  '$executeRawUnsafe',
  'whereRaw',
  'havingRaw',
  'orderByRaw',
  'groupByRaw',
  'joinRaw',
  'fromRaw',
  'createQueryBuilder',
  'timingSafeEqual',
]);

// `node:fs` and `fs` are the same module; `@types/express` declares `express`.
function moduleName(specifier) {
  return specifier
    .replace(/^node:/, '')
    .replace(/^@types\/(?:([^_/]+)__)?([^/]+)/, (match, scope, name) => (scope ? `@${scope}/${name}` : name));
}

function stripExpression(node) {
  let current = node;
  while (
    current &&
    (ts.isParenthesizedExpression(current) ||
      ts.isNonNullExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isSatisfiesExpression(current) ||
      ts.isTypeAssertionExpression(current) ||
      ts.isAwaitExpression(current))
  )
    current = current.expression;
  return current;
}

function isRequireCall(node) {
  return (
    node &&
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === 'require' &&
    node.arguments.length === 1 &&
    ts.isStringLiteralLike(node.arguments[0])
  );
}

// The module export an import or require binding stands for: { module, exported }, where exported is a named
// export, 'default', or '*' for a namespace or a whole required module.
function bindingOf(declaration) {
  if (!declaration) return;
  if (ts.isImportSpecifier(declaration) || ts.isImportClause(declaration) || ts.isNamespaceImport(declaration)) {
    const statement = ts.findAncestor(declaration, ts.isImportDeclaration);
    if (!statement || !ts.isStringLiteral(statement.moduleSpecifier)) return;
    const exported = ts.isImportSpecifier(declaration)
      ? (declaration.propertyName ?? declaration.name).text
      : ts.isImportClause(declaration)
        ? 'default'
        : '*';
    return { module: moduleName(statement.moduleSpecifier.text), exported };
  }
  if (ts.isImportEqualsDeclaration(declaration)) {
    const reference = declaration.moduleReference;
    if (!ts.isExternalModuleReference(reference) || !ts.isStringLiteral(reference.expression)) return;
    return { module: moduleName(reference.expression.text), exported: '*' };
  }
  if (ts.isVariableDeclaration(declaration) && isRequireCall(stripExpression(declaration.initializer))) {
    if (!ts.isIdentifier(declaration.name)) return;
    return { module: moduleName(stripExpression(declaration.initializer).arguments[0].text), exported: '*' };
  }
  if (ts.isBindingElement(declaration) && ts.isObjectBindingPattern(declaration.parent)) {
    const variable = declaration.parent.parent;
    if (!ts.isVariableDeclaration(variable) || !isRequireCall(stripExpression(variable.initializer))) return;
    const property = declaration.propertyName ?? declaration.name;
    if (!ts.isIdentifier(property)) return;
    return { module: moduleName(stripExpression(variable.initializer).arguments[0].text), exported: property.text };
  }
}

function declarationOf(identifier, checker) {
  const symbol = ts.isShorthandPropertyAssignment(identifier.parent)
    ? checker.getShorthandAssignmentValueSymbol(identifier.parent)
    : checker.getSymbolAtLocation(identifier);
  return symbol?.declarations?.[0];
}

// `exec` in `import { exec } from 'child_process'` -> { module: 'child_process', exported: 'exec' }.
function importedFrom(identifier, checker) {
  if (!identifier || !ts.isIdentifier(identifier)) return;
  return bindingOf(declarationOf(identifier, checker));
}

function typeNameOf(typeNode) {
  if (!typeNode) return;
  if (ts.isTypeReferenceNode(typeNode)) return typeNode.typeName;
  if (ts.isUnionTypeNode(typeNode)) {
    const named = typeNode.types.filter((member) => ts.isTypeReferenceNode(member));
    return named.length === 1 ? named[0].typeName : undefined;
  }
}

// The receiver's declaration carries a type imported from a module: `private readonly dataSource: DataSource`
// or `model: Model<User>`. This is how NestJS-injected instances are recognised without installed packages.
function declaredTypeImport(expression, checker) {
  const node = stripExpression(expression);
  let name;
  if (ts.isIdentifier(node)) name = node;
  else if (ts.isPropertyAccessExpression(node) && node.expression.kind === ts.SyntaxKind.ThisKeyword) name = node.name;
  if (!name) return;
  const declaration = ts.isIdentifier(node)
    ? declarationOf(node, checker)
    : checker.getSymbolAtLocation(name)?.declarations?.[0];
  if (
    !declaration ||
    !(
      ts.isParameter(declaration) ||
      ts.isPropertyDeclaration(declaration) ||
      ts.isVariableDeclaration(declaration) ||
      ts.isPropertySignature(declaration)
    )
  )
    return;
  let typeName = typeNameOf(declaration.type);
  if (typeName && ts.isQualifiedName(typeName)) {
    const namespace = importedFrom(typeName.left, checker);
    return namespace?.exported === '*' ? { module: namespace.module, exported: typeName.right.text } : undefined;
  }
  return typeName && ts.isIdentifier(typeName) ? importedFrom(typeName, checker) : undefined;
}

// The module a declaration file belongs to: the `declare module 'x'` around it, or its package under node_modules.
function declaringModule(declaration, checker) {
  if (isDefaultLibrary(checker, declaration.getSourceFile())) return;
  const ambient = ts.findAncestor(declaration, (node) => ts.isModuleDeclaration(node) && ts.isStringLiteral(node.name));
  if (ambient) return moduleName(ambient.name.text);
  const filename = declaration.getSourceFile().fileName.replaceAll('\\', '/');
  const marker = '/node_modules/';
  const start = filename.lastIndexOf(marker);
  if (start < 0) return;
  const parts = filename.slice(start + marker.length).split('/');
  return moduleName(parts[0].startsWith('@') ? parts[0] + '/' + parts[1] : parts[0]);
}

function typeTier(call, receiver, method, checker) {
  if (receiver) {
    const type = checker.getTypeAtLocation(receiver);
    const symbol = type.getSymbol() ?? type.aliasSymbol;
    const declaration = symbol?.declarations?.[0];
    const module = declaration && declaringModule(declaration, checker);
    if (module) return { module, exported: symbol.name, method, tier: 'type' };
  }
  const declaration = checker.getResolvedSignature(call)?.declaration;
  const module = declaration && declaringModule(declaration, checker);
  if (!module) return;
  const exported = receiver ? declaration.parent?.name?.text : declaration.name?.text;
  return { module, exported, method, tier: 'type' };
}

// The identifier a call chain starts from: `knex` in `knex('users').whereRaw(...)`.
function chainRoot(expression) {
  let node = stripExpression(expression);
  while (
    node &&
    (ts.isPropertyAccessExpression(node) || ts.isCallExpression(node) || ts.isElementAccessExpression(node))
  ) {
    if (ts.isPropertyAccessExpression(node) && node.expression.kind === ts.SyntaxKind.ThisKeyword) return node;
    node = stripExpression(node.expression);
  }
  return node;
}

// { module, exported, method, tier } for a call, or undefined. `method` is the called property name, undefined when
// the export itself is called; for a namespace or whole-module binding, `fs.readFile()` gives exported 'readFile'.
function libraryCall(call, context) {
  const checker = context.checker;
  const callee = stripExpression(call.expression);
  const access = ts.isPropertyAccessExpression(callee) ? callee : undefined;
  const method = access?.name.text;
  if (!access && ts.isIdentifier(callee)) {
    const binding = importedFrom(callee, checker);
    if (binding) return { ...binding, method: undefined, tier: 'import' };
  }
  if (access) {
    const receiver = stripExpression(access.expression);
    const direct = ts.isIdentifier(receiver) && importedFrom(receiver, checker);
    if (direct?.exported === '*') return { module: direct.module, exported: method, method: undefined, tier: 'import' };
    if (direct) return { ...direct, method, tier: 'import' };
    if (isRequireCall(receiver))
      return { module: moduleName(receiver.arguments[0].text), exported: method, method: undefined, tier: 'import' };
    const annotated = declaredTypeImport(receiver, checker);
    if (annotated) return { ...annotated, method, tier: 'import' };
    const root = chainRoot(receiver);
    const rootBinding =
      root &&
      root !== receiver &&
      (ts.isIdentifier(root) ? importedFrom(root, checker) : declaredTypeImport(root, checker));
    if (rootBinding) return { ...rootBinding, method, tier: 'import' };
  }
  const typed = typeTier(call, access && stripExpression(access.expression), method, checker);
  if (typed) return typed;
  if (method && uniqueMethodNames.has(method)) return { module: undefined, exported: undefined, method, tier: 'name' };
}

module.exports = { libraryCall, importedFrom, declaredTypeImport, uniqueMethodNames, moduleName };
