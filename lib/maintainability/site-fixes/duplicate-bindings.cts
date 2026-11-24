import path from 'node:path';
import { ts, nameUsed } from './helpers.cjs';
import type {
  CompilerHost,
  CompilerOptions,
  ImportClause,
  Identifier,
  Node,
  SourceFile,
  TypeChecker,
} from 'typescript';
import type { DuplicateSite, NamedFunctionSite } from '../types/duplicate-sites.cjs';
import type { FunctionWithBody } from '../types/site-fix-nodes.cjs';

const sourceExtension = /\.[cm]?[jt]sx?$/i;
const permittedHelperGlobals = new Set(['Array', 'JSON', 'undefined']);

function isValueReference(identifier: Identifier): boolean {
  const parent = identifier.parent;
  if (ts.isPropertyAccessExpression(parent) && parent.name === identifier) return false;
  if (ts.isBindingElement(parent) && parent.propertyName === identifier) return false;
  if ((ts.isLabeledStatement(parent) || ts.isBreakOrContinueStatement(parent)) && parent.label === identifier)
    return false;
  if (ts.isJsxAttribute(parent)) return false;
  const keyed =
    ts.isPropertyAssignment(parent) ||
    ts.isMethodDeclaration(parent) ||
    ts.isPropertyDeclaration(parent) ||
    ts.isGetAccessorDeclaration(parent) ||
    ts.isSetAccessorDeclaration(parent);
  return !(keyed && parent.name === identifier);
}

// Identifiers read at run time, in syntax order. Two copies with equal syntax list them in the same
// order.
function runtimeIdentifiers(fn: FunctionWithBody): Identifier[] {
  const identifiers: Identifier[] = [];
  const visit = (node: Node): void => {
    if (ts.isTypeNode(node)) return;
    if (ts.isIdentifier(node) && isValueReference(node)) identifiers.push(node);
    ts.forEachChild(node, visit);
  };
  for (const parameter of fn.parameters) visit(parameter);
  visit(fn.body);
  return identifiers;
}

function stripExtension(file: string): string {
  return file.replace(sourceExtension, '').replace(/[\\/]index$/, '');
}

function moduleKey(fromFile: string, specifier: string): string {
  if (!specifier.startsWith('.')) return specifier;
  return stripExtension(path.resolve(path.dirname(fromFile), specifier));
}

function importedBinding(declaration: Node): string | undefined {
  let name: string;
  let clause: ImportClause;
  if (ts.isImportSpecifier(declaration)) {
    name = (declaration.propertyName ?? declaration.name).text;
    clause = declaration.parent.parent;
  } else if (ts.isImportClause(declaration)) {
    name = 'default';
    clause = declaration;
  } else if (ts.isNamespaceImport(declaration)) {
    name = '*';
    clause = declaration.parent;
  } else return;
  const specifier = clause.parent.moduleSpecifier;
  if (!ts.isStringLiteral(specifier)) return;
  return moduleKey(declaration.getSourceFile().fileName, specifier.text) + '#' + name;
}

// Where each runtime name of `fn` comes from: a global, a local declaration (by position in the
// function), an import (by module and exported name) or a declaration elsewhere in the same file.
function bindings(checker: TypeChecker, fn: FunctionWithBody): (string | undefined)[] {
  const sourceFile = fn.getSourceFile();
  // Numbered from the parameters on: modifiers and names may differ between copies.
  const order = new Map<Node, number>();
  const number = (node: Node): void => {
    order.set(node, order.size);
    ts.forEachChild(node, number);
  };
  for (const parameter of fn.parameters) number(parameter);
  number(fn.body);
  return runtimeIdentifiers(fn).map((identifier) => {
    const parent = identifier.parent;
    const symbol =
      ts.isShorthandPropertyAssignment(parent) && parent.name === identifier
        ? checker.getShorthandAssignmentValueSymbol(parent)
        : checker.getSymbolAtLocation(identifier);
    const declaration = symbol?.declarations?.[0];
    if (!declaration) return 'global:' + identifier.text;
    if (declaration.getSourceFile() !== sourceFile) return;
    if (order.has(declaration)) return 'local:' + order.get(declaration);
    const imported = importedBinding(declaration);
    if (imported) return 'import:' + imported;
    return 'file:' + stripExtension(path.resolve(sourceFile.fileName)) + '#' + identifier.text;
  });
}

function checkerFor(sites: readonly DuplicateSite[]): TypeChecker {
  const files = new Map<string, SourceFile>(
    sites.map((site) => [path.resolve(site.sourceFile.fileName), site.sourceFile]),
  );
  const host: CompilerHost = {
    getSourceFile: (name) => files.get(path.resolve(name)),
    getDefaultLibFileName: () => 'lib.d.ts',
    writeFile() {},
    getCurrentDirectory: () => '',
    getCanonicalFileName: (name) => name,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => '\n',
    fileExists: (name) => files.has(path.resolve(name)),
    readFile: () => undefined,
  };
  const options: CompilerOptions = { noLib: true, noResolve: true, allowJs: true, noEmit: true, types: [] };
  return ts.createProgram({ rootNames: [...files.keys()], options, host }).getTypeChecker();
}

function isolatedHelper({ fn, sourceFile }: NamedFunctionSite, checker: TypeChecker): boolean {
  // Moving a reference to a type or value declared elsewhere can change its meaning in the new
  // module.
  function movable(node: Node): boolean {
    if (ts.isTaggedTemplateExpression(node)) return false;
    if (ts.isIdentifier(node) && isValueReference(node)) {
      if (node.text === fn.name.text && node !== fn.name) return false;
      const symbol = ts.isShorthandPropertyAssignment(node.parent)
        ? checker.getShorthandAssignmentValueSymbol(node.parent)
        : checker.getSymbolAtLocation(node);
      const declaration = symbol?.declarations?.[0];
      if (!declaration) return permittedHelperGlobals.has(node.text);
      if (declaration.getSourceFile() !== sourceFile || declaration.pos < fn.pos || declaration.end > fn.end)
        return false;
    }
    return !ts.forEachChild(node, (child) => !movable(child) || undefined);
  }
  // A shared binding cannot replace individually observable function identities or mutable local
  // bindings.
  function directCallsOnly(node: Node): boolean {
    if (node === fn) return true;
    if (ts.isIdentifier(node) && node.text === fn.name.text)
      return ts.isCallExpression(node.parent) && node.parent.expression === node;
    return !ts.forEachChild(node, (child) => !directCallsOnly(child) || undefined);
  }
  return (
    movable(fn) &&
    directCallsOnly(sourceFile) &&
    !nameUsed(sourceFile, 'eval') &&
    !/\/\/|\/\*/.test(fn.getText(sourceFile))
  );
}

export { stripExtension, moduleKey, importedBinding, bindings, checkerFor, isolatedHelper };
