import ts from 'typescript';
import { walkNodes } from './walk.js';
import { hasModifier } from './modifiers.js';
import { generatedSource } from './duplicates.js';
import { isVendoredMinified } from '../shared/execution-context.js';
import { NO_UNUSED_RULES, eslintDisabledLines, isBundledLibrary, isVendoredOrSamplePath } from './source-exclusions.js';
import type { CompilerOptions, Identifier, Node, SourceFile, VariableDeclaration } from 'typescript';
import type { Finding } from '../shared/types.js';

// One name an import declaration brings into the file; `anchor` is the node a fix removes.
interface ImportBinding {
  name: string;
  anchor: Node;
  declaration: ts.ImportDeclaration;
}

// What one pass over the tree learns. Counting every identifier of a name, whatever it refers to,
// can only over-count uses, so a name seen once is certainly unused and shadowing needs no scope
// analysis.
interface FileFacts {
  identifierCounts: Map<string, number>;
  variableDeclarations: VariableDeclaration[];
  hasJsx: boolean;
  hasDynamicScope: boolean;
  // Every `/** */` block joined, so a name is searched for in one string instead of per binding.
  jsDocText: string;
}

const automaticJsxRuntimes: readonly (ts.JsxEmit | undefined)[] = [ts.JsxEmit.ReactJSX, ts.JsxEmit.ReactJSXDev];

function jsDocBlocksOf(text: string): string {
  if (!text.includes('/**')) return '';
  return Array.from(text.matchAll(/\/\*\*[\s\S]*?\*\//g), (block) => block[0]).join('\n');
}

function gatherFacts(sourceFile: SourceFile): FileFacts {
  const facts: FileFacts = {
    identifierCounts: new Map(),
    variableDeclarations: [],
    hasJsx: false,
    hasDynamicScope: false,
    jsDocText: jsDocBlocksOf(sourceFile.text),
  };
  walkNodes(sourceFile, (node: Node) => {
    if (ts.isIdentifier(node)) {
      facts.identifierCounts.set(node.text, (facts.identifierCounts.get(node.text) ?? 0) + 1);
      // Direct eval and `with` can read any local by name.
      if (node.text === 'eval') facts.hasDynamicScope = true;
    } else if (ts.isVariableDeclaration(node)) facts.variableDeclarations.push(node);
    else if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node)) facts.hasJsx = true;
    else if (ts.isWithStatement(node)) facts.hasDynamicScope = true;
  });
  return facts;
}

// Every finding of a file asks for the same facts, so one pass serves them all.
const factsBySourceFile = new WeakMap<SourceFile, FileFacts>();

function factsOf(sourceFile: SourceFile): FileFacts {
  const cached = factsBySourceFile.get(sourceFile);
  if (cached) return cached;
  const facts = gatherFacts(sourceFile);
  factsBySourceFile.set(sourceFile, facts);
  return facts;
}

function escapeForPattern(name: string): string {
  return name.replaceAll(/[$\\^.*+?()[\]{}|]/g, String.raw`\$&`);
}

// A JavaScript file can use a name from a JSDoc type, `{@link}` or `@see`, which no identifier shows.
function mentionedInJsDoc(facts: FileFacts, name: string): boolean {
  if (!facts.jsDocText) return false;
  return new RegExp('(?<![\\w$])' + escapeForPattern(name) + '(?![\\w$])').test(facts.jsDocText);
}

// With the classic JSX transform the compiler emits calls to the factory, so its import is read
// even though no identifier names it. Anything but a known automatic runtime is treated that way.
function jsxFactoryNames(sourceFile: SourceFile, options: CompilerOptions): Set<string> {
  const names = new Set(['React']);
  for (const factory of [options.jsxFactory, options.jsxFragmentFactory]) {
    const root = factory?.split('.')[0];
    if (root) names.add(root);
  }
  for (const pragma of sourceFile.text.matchAll(/@jsx(?:Frag)?\s+([\w$]+)/g)) names.add(pragma[1]);
  return names;
}

function usesClassicJsx(sourceFile: SourceFile, options: CompilerOptions, facts: FileFacts): boolean {
  if (!facts.hasJsx) return false;
  return !automaticJsxRuntimes.includes(options.jsx) || /@jsxRuntime\s+classic/.test(sourceFile.text);
}

function importBindingsOf(declaration: ts.ImportDeclaration): ImportBinding[] {
  const clause = declaration.importClause;
  if (!clause) return [];
  const bindings: ImportBinding[] = [];
  if (clause.name) bindings.push({ name: clause.name.text, anchor: clause.name, declaration });
  const named = clause.namedBindings;
  if (named && ts.isNamespaceImport(named)) bindings.push({ name: named.name.text, anchor: named, declaration });
  if (named && ts.isNamedImports(named)) {
    for (const element of named.elements) bindings.push({ name: element.name.text, anchor: element, declaration });
  }
  return bindings;
}

function skippedSource(sourceFile: SourceFile, file: string): boolean {
  return (
    Boolean(generatedSource(sourceFile, file)) ||
    isVendoredMinified(file) ||
    isVendoredOrSamplePath(file) ||
    isBundledLibrary(sourceFile)
  );
}

// Imports whose local name is referenced nowhere in the file. Only top-level imports count, so
// `declare module` blocks are left alone. Direct eval and `with` can read an import by name, so a file
// using either reports none.
function unusedImportBindings(sourceFile: SourceFile, options: CompilerOptions): ImportBinding[] {
  const known = factsOf(sourceFile);
  if (known.hasDynamicScope) return [];
  const keptByJsx = usesClassicJsx(sourceFile, options, known)
    ? jsxFactoryNames(sourceFile, options)
    : new Set<string>();
  const unused: ImportBinding[] = [];
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    for (const binding of importBindingsOf(statement)) {
      if (known.identifierCounts.get(binding.name) !== 1 || keptByJsx.has(binding.name)) continue;
      if (mentionedInJsDoc(known, binding.name)) continue;
      unused.push(binding);
    }
  }
  return unused;
}

function isAmbient(statement: Node): boolean {
  return Boolean(ts.findAncestor(statement, (candidate) => hasModifier(candidate, ts.SyntaxKind.DeclareKeyword)));
}

// The declared name when this is a plain local nothing outside the file can read.
function reportableLocalName(declaration: VariableDeclaration, sourceFile: SourceFile): Identifier | undefined {
  const list = declaration.parent;
  const name = declaration.name;
  if (!ts.isIdentifier(name) || name.text.startsWith('_')) return;
  if (!ts.isVariableDeclarationList(list) || list.flags & ts.NodeFlags.Using) return;
  const statement = list.parent;
  if (!ts.isVariableStatement(statement) || isAmbient(statement)) return;
  if (hasModifier(statement, ts.SyntaxKind.ExportKeyword)) return;
  // A script's top-level variables are globals other files may read; a module's are private.
  if (statement.parent === sourceFile && !ts.isExternalModule(sourceFile)) return;
  return name;
}

function locationOf(sourceFile: SourceFile, file: string, node: Node): Pick<Finding, 'file' | 'line' | 'column'> {
  const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return { file, line: position.line + 1, column: position.character + 1 };
}

function unusedLocalFindings(sourceFile: SourceFile, file: string, facts: FileFacts): Finding[] {
  if (facts.hasDynamicScope) return [];
  const findings: Finding[] = [];
  for (const declaration of facts.variableDeclarations) {
    const identifier = reportableLocalName(declaration, sourceFile);
    if (!identifier || facts.identifierCounts.get(identifier.text) !== 1) continue;
    const name = identifier.text;
    if (mentionedInJsDoc(facts, name)) continue;
    findings.push({
      ...locationOf(sourceFile, file, identifier),
      ruleId: 'unused-local-variable',
      message: `'${name}' is declared but never read. Delete it, or prefix it with an underscore if the value is kept on purpose. If the initializer has side effects, keep the expression and drop only the name.`,
    });
  }
  return findings;
}

function unusedImportFindings(sourceFile: SourceFile, file: string, options: CompilerOptions): Finding[] {
  return unusedImportBindings(sourceFile, options).map((binding) => ({
    ...locationOf(sourceFile, file, binding.anchor),
    ruleId: 'unused-import',
    message: `'${binding.name}' is imported but never used. Remove it so readers and bundlers do not have to wonder why it is there.`,
  }));
}

// TypeScript reports both rules itself under `noUnusedLocals`, so reporting them here would
// duplicate its diagnostics.
function checkUnusedBindings(sourceFile: SourceFile, file: string, options: CompilerOptions): Finding[] {
  if (options.noUnusedLocals === true || sourceFile.isDeclarationFile || skippedSource(sourceFile, file)) return [];
  const isDisabled = eslintDisabledLines(sourceFile, NO_UNUSED_RULES);
  return [
    ...unusedImportFindings(sourceFile, file, options),
    ...unusedLocalFindings(sourceFile, file, factsOf(sourceFile)),
  ].filter((finding) => finding.line === undefined || !isDisabled(finding.line));
}

export { checkUnusedBindings, unusedImportBindings };
