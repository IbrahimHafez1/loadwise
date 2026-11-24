import path from 'node:path';
import { loadSyntax } from '../compiler.cjs';
import type {
  CallExpression,
  ClassDeclaration,
  Decorator,
  Expression,
  NamedDeclaration,
  Node,
  PropertyAssignment,
  TypeNode,
} from 'typescript';
import type { CheckerAdapter, SymbolAdapter } from '../../shared/types.cjs';
import type * as PackageTypes from '../package-types.cjs';
import type { DecoratorCall } from '../types/decorator-call.cjs';
import type { FileLocation } from '../types/source-position.cjs';
const ts = loadSyntax();

// Following `const a = b` chains further than this means the value is not a plain declaration.
const maxAliasHops = 4;

function normalizedFileName(node: Node): string {
  return node.getSourceFile().fileName.replaceAll('\\', '/');
}

function packageOf(declaration: Node): string | undefined {
  const filename = normalizedFileName(declaration);
  const marker = '/node_modules/';
  const start = filename.lastIndexOf(marker);
  if (start < 0) return;
  const [scope, name] = filename.slice(start + marker.length).split('/');
  return scope.startsWith('@') ? scope + '/' + name : scope;
}

function resolvedSymbol(node: Node, checker: CheckerAdapter): SymbolAdapter | undefined {
  const target = ts.isPropertyAccessExpression(node) ? node.name : node;
  let symbol = checker.getSymbolAtLocation(target);
  if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
  return symbol;
}

function symbolDeclarations(node: Node, checker: CheckerAdapter): readonly Node[] {
  return resolvedSymbol(node, checker)?.declarations ?? [];
}

// True when every declaration of the called name comes from one of the packages.
function declaredInPackage(node: Node, checker: CheckerAdapter, packages: readonly string[]): boolean {
  const declarations = symbolDeclarations(node, checker);
  if (declarations.length === 0) {
    // Required lazily: the model readers load this module. Without installed types a call on a
    // project model of the package's ORM still counts, at reduced precision.
    if (!ts.isPropertyAccessExpression(node)) return false;
    const { receiverFromModel }: typeof PackageTypes = require('../package-types.cjs');
    return receiverFromModel(node, checker, packages);
  }
  return declarations.every((declaration: Node) => {
    const packageName = packageOf(declaration);
    return packageName !== undefined && packages.includes(packageName);
  });
}

function calleeName(call: CallExpression): string | undefined {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
}

// The expression a name was initialized with, through `const alias = other` chains.
function initializerOf(node: Node, checker: CheckerAdapter): ClassDeclaration | Expression | undefined {
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

function isNode(value: unknown): value is Node {
  return typeof value === 'object' && value !== null && 'kind' in value;
}

// The type annotation of a declaration that has one (variable, parameter, property, ...).
function declaredTypeOf(declaration: Node): TypeNode | undefined {
  if (!('type' in declaration) || !isNode(declaration.type)) return undefined;
  return ts.isTypeNode(declaration.type) ? declaration.type : undefined;
}

// The `= value` of a declaration that has one (variable, parameter, property, ...).
function declarationInitializer(declaration: Node): Expression | undefined {
  if (!('initializer' in declaration) || !isNode(declaration.initializer)) return undefined;
  return ts.isExpression(declaration.initializer) ? declaration.initializer : undefined;
}

function stringValue(node: Node | undefined): string | undefined {
  const value = node && ts.skipOuterExpressions(node);
  if (value && (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value))) return value.text;
}

function propertyName(property: NamedDeclaration): string | undefined {
  const name = property.name;
  if (name && (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name))) return name.text;
}

function objectProperty(object: Node | undefined, name: string): Expression | undefined {
  if (!object || !ts.isObjectLiteralExpression(object)) return;
  const property = object.properties.find(
    (candidate): candidate is PropertyAssignment =>
      ts.isPropertyAssignment(candidate) && propertyName(candidate) === name,
  );
  return property && ts.skipOuterExpressions(property.initializer);
}

function decoratorsOf(node: Node): readonly Decorator[] {
  return ts.canHaveDecorators(node) ? (ts.getDecorators(node) ?? []) : [];
}

// `@Index()` or `@Index` -> { name: 'Index', call, args }.
function decoratorCall(decorator: Decorator): DecoratorCall | undefined {
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

function location(node: Node): FileLocation {
  const file = node.getSourceFile();
  const { line, character } = file.getLineAndCharacterOfPosition(node.getStart(file));
  return { file: file.fileName, line: line + 1, column: character + 1 };
}

// Findings name files relative to the working directory, like the scanned file itself.
function relativeFile(filename: string): string {
  return path.relative(process.cwd(), filename).split(path.sep).join('/');
}

export {
  declaredTypeOf,
  declarationInitializer,
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
