'use strict';

const path = require('node:path');
const { syntax: ts } = require('../compiler.cjs');

// Following `const a = b` chains further than this means the value is not a plain declaration.
const maxAliasHops = 4;

function normalizedFileName(node) {
  return node.getSourceFile().fileName.replaceAll('\\', '/');
}

function packageOf(declaration) {
  const filename = normalizedFileName(declaration);
  const marker = '/node_modules/';
  const start = filename.lastIndexOf(marker);
  if (start < 0) return;
  const [scope, name] = filename.slice(start + marker.length).split('/');
  return scope.startsWith('@') ? scope + '/' + name : scope;
}

function resolvedSymbol(node, checker) {
  const target = ts.isPropertyAccessExpression(node) ? node.name : node;
  let symbol = checker.getSymbolAtLocation(target);
  if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
  return symbol;
}

function symbolDeclarations(node, checker) {
  return resolvedSymbol(node, checker)?.declarations ?? [];
}

// True when every declaration of the called name comes from one of the packages.
function declaredInPackage(node, checker, packages) {
  const declarations = symbolDeclarations(node, checker);
  return declarations.length > 0 && declarations.every((declaration) => packages.includes(packageOf(declaration)));
}

function calleeName(call) {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
}

// The expression a name was initialized with, through `const alias = other` chains.
function initializerOf(node, checker) {
  let current = node;
  for (let hop = 0; hop < maxAliasHops; hop++) {
    const symbol = resolvedSymbol(current, checker);
    const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
    if (!declaration) return;
    if (ts.isClassDeclaration(declaration)) return declaration;
    if (!ts.isVariableDeclaration(declaration) || !declaration.initializer) return;
    if (!(declaration.parent.flags & ts.NodeFlags.Const)) return;
    const value = ts.skipOuterExpressions(declaration.initializer);
    if (!ts.isIdentifier(value) && !ts.isPropertyAccessExpression(value)) return value;
    current = value;
  }
}

function stringValue(node) {
  const value = node && ts.skipOuterExpressions(node);
  if (value && (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value))) return value.text;
}

function propertyName(property) {
  const name = property.name;
  if (name && (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name))) return name.text;
}

function objectProperty(object, name) {
  if (!object || !ts.isObjectLiteralExpression(object)) return;
  const property = object.properties.find(
    (candidate) => ts.isPropertyAssignment(candidate) && propertyName(candidate) === name,
  );
  return property && ts.skipOuterExpressions(property.initializer);
}

function decoratorsOf(node) {
  return (node.modifiers ?? []).filter((modifier) => ts.isDecorator(modifier));
}

// `@Index()` or `@Index` -> { name: 'Index', call, args }.
function decoratorCall(decorator) {
  const expression = decorator.expression;
  if (ts.isCallExpression(expression) && ts.isIdentifier(expression.expression)) {
    return {
      name: expression.expression.text,
      callee: expression.expression,
      call: expression,
      args: expression.arguments,
    };
  }
  if (ts.isIdentifier(expression)) return { name: expression.text, callee: expression, args: [] };
}

function location(node) {
  const file = node.getSourceFile();
  const { line, character } = file.getLineAndCharacterOfPosition(node.getStart(file));
  return { file: file.fileName, line: line + 1, column: character + 1 };
}

// Findings name files relative to the working directory, like the scanned file itself.
function relativeFile(filename) {
  return path.relative(process.cwd(), filename).split(path.sep).join('/');
}

module.exports = {
  packageOf,
  resolvedSymbol,
  symbolDeclarations,
  declaredInPackage,
  calleeName,
  initializerOf,
  stringValue,
  propertyName,
  objectProperty,
  decoratorsOf,
  decoratorCall,
  location,
  relativeFile,
};
