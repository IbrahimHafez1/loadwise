// duplicate-implementation: keeps one top-level function and makes every other copy call it.
// Applied only when each name the copies use resolves to the same binding, so the call runs exactly
// the code the copy ran.
import { innermostNodeAt } from '../../shared/fix-hunks.cjs';
import fs from 'node:fs';
import path from 'node:path';
import {
  ts,
  flaggedFunction,
  hasBlockBody,
  lineStart,
  lineEnd,
  nextLineStart,
  indentationAt,
  newlineOf,
  nameUsed,
  ownsLines,
  hasMultilineLiteral,
  dedentLines,
} from './helpers.cjs';
import { testFile, canonicalKey } from '../duplicates.cjs';

import {
  stripExtension,
  moduleKey,
  importedBinding,
  bindings,
  checkerFor,
  isolatedHelper,
} from './duplicate-bindings.cjs';
import type {
  ArrayLiteralExpression,
  ArrowFunction,
  CompilerHost,
  CompilerOptions,
  ImportClause,
  ImportDeclaration,
  ImportSpecifier,
  MethodDeclaration,
  NamespaceImport,
  Node,
  ParameterDeclaration,
  PropertyAssignment,
  PropertyName,
  ResolvedModuleFull,
  SourceFile,
  Statement,
  TypeChecker,
  TypeNode,
  VariableDeclaration,
  VariableStatement,
  Identifier,
  Block,
} from 'typescript';
import type { FileTarget, Finding, FixResult, TextEdit } from '../../shared/types.cjs';
import type { ProjectLoad, ProjectSiteFixInput } from '../types/site-fix-loader.cjs';
import type { ModuleCreatingFix } from '../types/created-module.cjs';
import type {
  BlockBodiedFunction,
  DuplicateSite,
  FunctionInFile,
  NamedFunctionDeclaration,
  NamedFunctionSite,
  StringLiteralImport,
} from '../types/duplicate-sites.cjs';
import type { FunctionWithBody } from '../types/site-fix-nodes.cjs';

// A copy that is an arrow function, as callbacks and exported arrows are.
interface ArrowSite extends DuplicateSite {
  fn: ArrowFunction & { readonly body: Block };
}

// A copy that is a class method.
interface MethodSite extends DuplicateSite {
  fn: MethodDeclaration & { readonly body: Block };
}

// A name the copy's function declares, with the name's import clause, namespace import or import
// specifier.
type ImportBinding = ImportClause | NamespaceImport | ImportSpecifier;

interface StrandedImport {
  declaration: StringLiteralImport;
  binding: ImportBinding;
  name: string;
}

// What replaces a copy's body with a call: the local name to call and the import edit that provides
// it, if any.
interface ImportEdit {
  local: string;
  edit?: TextEdit;
}

interface ExportedArrow {
  name: string;
  signature: string;
  statement: VariableStatement;
}

type ConfigProperty = PropertyAssignment & { readonly name: Identifier };
type ConfigVariable = VariableDeclaration & { readonly type: TypeNode; readonly name: Identifier };

// `const x: T = { items: [{ prop: (v) => ... }] }` as a callback property sees it.
interface ConfigDeclaration {
  property: ConfigProperty;
  array: ArrayLiteralExpression;
  variable: ConfigVariable;
  statement: Statement;
}

// Where the helper text goes around the declaration.
interface HelperAnchors {
  top: number;
  above: number | undefined;
  aboveUsable: boolean;
  after: number;
}

// A name a method reads: one of its own declarations, a global, or an import.
interface MethodReference {
  key: string;
  name?: string;
  imported?: StringLiteralImport;
  binding?: Node;
}

interface MethodCandidate {
  site: MethodSite;
  shape: string;
  references: MethodReference[];
  referenceKeys: string;
}

interface NewHelperModule {
  file: string;
  text: string;
  sharesNameWith?: string;
}
const forbiddenKinds = new Set([
  ts.SyntaxKind.ThisKeyword,
  ts.SyntaxKind.SuperKeyword,
  ts.SyntaxKind.YieldExpression,
  ts.SyntaxKind.MetaProperty,
]);

function siteAt(load: ProjectLoad, location: Finding): DuplicateSite | undefined {
  if (location.file === undefined || location.line === undefined || location.column === undefined) return;
  const entry = load(location.file);
  if (!entry?.sourceFile || !(location.line >= 1 && location.line <= entry.lineStarts.length)) return;
  const node = innermostNodeAt(ts, entry.sourceFile, entry.lineStarts[location.line - 1] + location.column - 1);
  const fn = node && flaggedFunction(node);
  if (fn && hasBlockBody(fn)) return { file: location.file, entry, sourceFile: entry.sourceFile, fn };
}

function isGenerator(fn: FunctionWithBody): boolean {
  return 'asteriskToken' in fn && fn.asteriskToken !== undefined;
}

function isArrowSite(site: DuplicateSite): site is ArrowSite {
  return ts.isArrowFunction(site.fn);
}

function isMethodSite(site: DuplicateSite): site is MethodSite {
  return ts.isMethodDeclaration(site.fn);
}

function isNamedFunctionDeclaration(node: Node): node is NamedFunctionDeclaration {
  return ts.isFunctionDeclaration(node) && node.name !== undefined && node.body !== undefined;
}

function isStringImport(declaration: ImportDeclaration): declaration is StringLiteralImport {
  return ts.isStringLiteral(declaration.moduleSpecifier);
}

// The text of a parameter's name; destructuring patterns have none.
function parameterName(parameter: ParameterDeclaration): string | undefined {
  return ts.isIdentifier(parameter.name) ? parameter.name.text : undefined;
}

// The text of a method's name, or undefined for a computed one.
function propertyNameText(name: PropertyName): string | undefined {
  return 'text' in name ? name.text : undefined;
}

// Code that depends on how the function is called, so a plain call from elsewhere would behave
// differently.
function callSensitive(fn: FunctionWithBody): boolean {
  let found = false;
  (function visit(node: Node): void {
    if (found) return;
    if (forbiddenKinds.has(node.kind) || (ts.isIdentifier(node) && node.text === 'arguments')) found = true;
    else ts.forEachChild(node, visit);
  })(fn.body);
  return found || isGenerator(fn);
}

function exported(node: Node): boolean {
  const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  return modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false;
}

// A top-level function in a module that is not a test, so importing it runs no test registration.
function canonicalCandidate(site: DuplicateSite): site is NamedFunctionSite {
  const { fn, file, sourceFile } = site;
  return (
    isNamedFunctionDeclaration(fn) &&
    ts.isSourceFile(fn.parent) &&
    !testFile.test(file) &&
    ts.isExternalModule(sourceFile) &&
    !callSensitive(fn)
  );
}

function simpleParameters(fn: FunctionWithBody): boolean {
  return fn.parameters.every(
    (parameter: ParameterDeclaration) =>
      ts.isIdentifier(parameter.name) && !parameter.initializer && parameter.name.text !== 'this',
  );
}

// Local names that an import or a top-level declaration would clash with.
function bindingDeclared(sourceFile: SourceFile, name: string, except: Node | undefined): boolean {
  let declared = false;
  (function visit(node: Node): void {
    if (declared || node === except) return;
    const named =
      ts.isVariableDeclaration(node) ||
      ts.isFunctionDeclaration(node) ||
      ts.isClassDeclaration(node) ||
      ts.isParameter(node) ||
      ts.isImportSpecifier(node) ||
      ts.isImportClause(node) ||
      ts.isNamespaceImport(node) ||
      ts.isEnumDeclaration(node) ||
      ts.isBindingElement(node) ||
      ts.isFunctionExpression(node) ||
      ts.isClassExpression(node);
    if (named && node.name && ts.isIdentifier(node.name) && node.name.text === name) declared = true;
    else ts.forEachChild(node, visit);
  })(sourceFile);
  return declared;
}

function moduleImports(sourceFile: SourceFile): StringLiteralImport[] {
  return sourceFile.statements.filter(
    (statement): statement is StringLiteralImport => ts.isImportDeclaration(statement) && isStringImport(statement),
  );
}

// The import bindings (default clause, namespace or named element) used only inside `removed`.
function strandedImports(sourceFile: SourceFile, removed: Node): StrandedImport[] {
  const imports = moduleImports(sourceFile);
  const importNodes: readonly Node[] = imports;
  const bound: StrandedImport[] = [];
  for (const declaration of imports) {
    const clause = declaration.importClause;
    if (clause?.name) bound.push({ declaration, binding: clause, name: clause.name.text });
    const named = clause?.namedBindings;
    if (named && ts.isNamespaceImport(named)) bound.push({ declaration, binding: named, name: named.name.text });
    if (named && ts.isNamedImports(named))
      for (const element of named.elements) bound.push({ declaration, binding: element, name: element.name.text });
  }
  return bound.filter(({ name }) => {
    if (!nameUsed(removed, name)) return false;
    let usedElsewhere = false;
    (function visit(node: Node): void {
      if (usedElsewhere || node === removed || importNodes.includes(node)) return;
      if (ts.isIdentifier(node) && node.text === name) usedElsewhere = true;
      else ts.forEachChild(node, visit);
    })(sourceFile);
    return !usedElsewhere;
  });
}

// Imports used only inside `removed` would be left unused, which fails builds with noUnusedLocals.
function strandsImports(sourceFile: SourceFile, removed: Node): boolean {
  return strandedImports(sourceFile, removed).length > 0;
}

// Loading a module with no runtime imports and no top-level calls has no side effects and cannot
// close a cycle. Imports of modules the importing file already loads add nothing, so they are
// tolerated.
function inertModule(sourceFile: SourceFile, loadedModules: ReadonlySet<string> = new Set()): boolean {
  return sourceFile.statements.every((statement: Statement) => {
    if (ts.isImportDeclaration(statement))
      return (
        Boolean(statement.importClause?.isTypeOnly) ||
        (ts.isStringLiteral(statement.moduleSpecifier) &&
          loadedModules.has(moduleKey(sourceFile.fileName, statement.moduleSpecifier.text)))
      );
    if (
      ts.isFunctionDeclaration(statement) ||
      ts.isInterfaceDeclaration(statement) ||
      ts.isTypeAliasDeclaration(statement)
    )
      return true;
    if (ts.isExportDeclaration(statement)) return !statement.moduleSpecifier || statement.isTypeOnly;
    if (!ts.isVariableStatement(statement)) return false;
    let effect = false;
    const owner: Node = statement;
    (function visit(node: Node): void {
      if (effect || (ts.isFunctionLike(node) && node !== owner)) return;
      if (
        ts.isCallExpression(node) ||
        ts.isNewExpression(node) ||
        ts.isTaggedTemplateExpression(node) ||
        ts.isAwaitExpression(node)
      )
        effect = true;
      else ts.forEachChild(node, visit);
    })(statement);
    return !effect;
  });
}

function relativeSpecifier(fromFile: string, toFile: string, sourceFile: SourceFile): string {
  let specifier = path.relative(path.dirname(fromFile), toFile).replaceAll('\\', '/');
  const explicitExtensions = moduleImports(sourceFile).some((declaration) =>
    /^\.{1,2}\/.*\.[cm]?js$/.test(declaration.moduleSpecifier.text),
  );
  specifier = explicitExtensions ? specifier.replace(/\.([cm]?)tsx?$/, '.$1js') : stripExtension(specifier);
  return specifier.startsWith('.') ? specifier : './' + specifier;
}

function quoteOf(sourceFile: SourceFile): string {
  const first = moduleImports(sourceFile)[0];
  return first && first.moduleSpecifier.getText(sourceFile).startsWith('"') ? '"' : "'";
}

// The edit that makes `localName` refer to the canonical function in the copy's file, or { local }
// when it is already imported. Undefined when the import cannot be added without changing load
// order.
function importEdit(
  copy: DuplicateSite,
  canonical: FunctionInFile,
  removedDeclaration: Node | undefined,
): ImportEdit | undefined {
  const { sourceFile } = copy;
  const text = sourceFile.text;
  const targetKey = stripExtension(path.resolve(canonical.sourceFile.fileName));
  const name = canonical.fn.name.text;
  const existing = moduleImports(sourceFile).find(
    (declaration) =>
      !declaration.importClause?.isTypeOnly &&
      moduleKey(sourceFile.fileName, declaration.moduleSpecifier.text) === targetKey,
  );
  const named = existing?.importClause?.namedBindings;
  const already =
    named && ts.isNamedImports(named)
      ? named.elements.find((element) => !element.isTypeOnly && (element.propertyName ?? element.name).text === name)
      : undefined;
  if (already) return { local: already.name.text };
  const loadedModules = new Set(
    moduleImports(sourceFile)
      .filter((declaration) => !declaration.importClause?.isTypeOnly)
      .map((declaration) => moduleKey(sourceFile.fileName, declaration.moduleSpecifier.text)),
  );
  if (!existing && !inertModule(canonical.sourceFile, loadedModules)) return;
  let local = name;
  if (bindingDeclared(sourceFile, name, removedDeclaration)) {
    local = 'shared' + name[0].toUpperCase() + name.slice(1);
    if (nameUsed(sourceFile, local)) return;
  }
  const specifier = local === name ? name : `${name} as ${local}`;
  const last = named && ts.isNamedImports(named) ? named.elements.at(-1) : undefined;
  if (named && ts.isNamedImports(named) && last) {
    const multiline = text.slice(named.getStart(sourceFile), named.end).includes('\n');
    const trailingComma = named.elements.hasTrailingComma;
    if (multiline) {
      const indentation = indentationAt(text, last.getStart(sourceFile));
      const anchor = trailingComma ? text.indexOf(',', last.end) + 1 : last.end;
      return {
        local,
        edit: {
          start: anchor,
          end: anchor,
          text: (trailingComma ? '' : ',') + newlineOf(text) + indentation + specifier + (trailingComma ? ',' : ''),
        },
      };
    }
    return { local, edit: { start: last.end, end: last.end, text: ', ' + specifier } };
  }
  const imports = moduleImports(sourceFile);
  const quote = quoteOf(sourceFile);
  const line = `import { ${specifier} } from ${quote}${relativeSpecifier(sourceFile.fileName, canonical.sourceFile.fileName, sourceFile)}${quote};`;
  const lastImport = imports.at(-1);
  if (!lastImport) return { local, edit: { start: 0, end: 0, text: line + newlineOf(text) } };
  const at = lineEnd(text, lastImport.end);
  return { local, edit: { start: at, end: at, text: newlineOf(text) + line } };
}

// Deletes whole lines from `start`, a line start, through the line holding `last`. A line-based fix
// cannot replace lines with nothing, since an empty replacement leaves one blank line, so the edit
// also spans a neighbouring line and keeps its text.
function lineDeletion(text: string, start: number, last: number): TextEdit {
  const end = lineEnd(text, last);
  if (start > 0) return { start: start - (text[start - 2] === '\r' ? 2 : 1), end, text: '' };
  const next = nextLineStart(text, end);
  if (next >= text.length) return { start: 0, end: text.length, text: '' };
  return { start: 0, end: lineEnd(text, next), text: text.slice(next, lineEnd(text, next)) };
}

// Removes a whole top-level function with its leading comments and one surrounding blank line.
function removal(fn: Node, sourceFile: SourceFile): TextEdit {
  const text = sourceFile.text;
  const comments = ts.getLeadingCommentRanges(text, fn.pos) ?? [];
  let start = lineStart(text, comments.length ? comments[0].pos : fn.getStart(sourceFile));
  const before = text.slice(lineStart(text, Math.max(0, start - 1)), start);
  if (start > 0 && !before.trim()) start = lineStart(text, start - 1);
  return lineDeletion(text, start, fn.end);
}

// Two edits at one offset apply in no defined order, so an insertion joins the edit that starts
// where it does.
function withInsertion(edits: TextEdit[], insertion: TextEdit): TextEdit[] | undefined {
  if (edits.some((edit: TextEdit) => edit.start < insertion.start && insertion.start < edit.end)) return;
  const joined = edits.find((edit: TextEdit) => edit.start === insertion.start);
  if (!joined) return [...edits, insertion];
  return edits.map((edit: TextEdit) => (edit === joined ? { ...edit, text: insertion.text + edit.text } : edit));
}

// Replaces the copy's body with a call to the shared function. An async copy returns the shared
// promise itself.
function delegation(copy: DuplicateSite, local: string): TextEdit[] | undefined {
  const { fn, sourceFile } = copy;
  const text = sourceFile.text;
  const newline = newlineOf(text);
  const indentation = indentationAt(text, fn.getStart(sourceFile));
  const firstStatement = fn.body.statements[0];
  const inner = indentationAt(text, firstStatement.getStart(sourceFile));
  if (!inner.startsWith(indentation) || inner === indentation) return;
  const argumentsText = fn.parameters
    .map((parameter: ParameterDeclaration) => (parameter.dotDotDotToken ? '...' : '') + parameterName(parameter))
    .join(', ');
  const edits: TextEdit[] = [
    {
      start: fn.body.getStart(sourceFile),
      end: fn.body.end,
      text: `{${newline}${inner}return ${local}(${argumentsText});${newline}${indentation}}`,
    },
  ];
  const asyncModifier = fn.modifiers?.find((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword);
  if (asyncModifier) {
    const start = asyncModifier.getStart(sourceFile);
    edits.push({ start, end: start + (/^async\s+/.exec(text.slice(start))?.[0].length ?? 0), text: '' });
  }
  return edits;
}

// Every comment inside a function body, found through the trivia around each token.
function bodyComments(fn: BlockBodiedFunction, sourceFile: SourceFile): string[] {
  const text = sourceFile.text;
  const comments = new Map<number, string>();
  // Comments before the opening brace or after the closing one stay outside the replaced range.
  const start = fn.body.getStart(sourceFile);
  const visit = (node: Node): void => {
    const ranges = [
      ...(ts.getLeadingCommentRanges(text, node.pos) ?? []),
      ...(ts.getTrailingCommentRanges(text, node.end) ?? []),
    ];
    for (const range of ranges)
      if (range.pos > start && range.end < fn.body.end)
        comments.set(range.pos, text.slice(range.pos, range.end).trim());
    for (const child of node.getChildren(sourceFile)) visit(child);
  };
  for (const child of fn.body.getChildren(sourceFile)) visit(child);
  return [...comments.values()];
}

// Replacing the copy's body would delete any comment the kept implementation does not repeat.
function losesComments(copy: DuplicateSite, canonical: DuplicateSite): boolean {
  const kept = new Set(bodyComments(canonical.fn, canonical.sourceFile));
  return bodyComments(copy.fn, copy.sourceFile).some((comment) => !kept.has(comment));
}

function rewriteCopy(copy: DuplicateSite, canonical: NamedFunctionSite): TextEdit[] | undefined {
  const { fn, sourceFile } = copy;
  if (isGenerator(fn) || ts.isAccessor(fn) || ts.isConstructorDeclaration(fn) || !simpleParameters(fn)) return;
  if (losesComments(copy, canonical)) return;
  const name = canonical.fn.name.text;
  const sameFile = copy.file === canonical.file;
  const removable =
    !sameFile && ts.isFunctionDeclaration(fn) && ts.isSourceFile(fn.parent) && !exported(fn) && fn.name?.text === name;
  if (strandsImports(sourceFile, removable ? fn : fn.body)) return;
  if (sameFile) {
    if (fn.parameters.some((parameter: ParameterDeclaration) => parameterName(parameter) === name)) return;
    return delegation(copy, name);
  }
  if (!ts.isExternalModule(sourceFile)) return;
  const imported = importEdit(copy, canonical, removable ? fn : undefined);
  if (!imported) return;
  if (fn.parameters.some((parameter: ParameterDeclaration) => parameterName(parameter) === imported.local)) return;
  const edits = removable ? [removal(fn, sourceFile)] : delegation(copy, imported.local);
  return edits && (imported.edit ? withInsertion(edits, imported.edit) : edits);
}

// Keep both exported arrows in place: in CommonJS a consumer can replace either export
// independently.
function exportedArrow(site: ArrowSite): ExportedArrow | undefined {
  const { fn, sourceFile } = site;
  const variable = fn.parent;
  if (!ts.isArrowFunction(fn) || !ts.isVariableDeclaration(variable) || !ts.isIdentifier(variable.name)) return;
  const list = variable.parent;
  if (!ts.isVariableDeclarationList(list) || !(list.flags & ts.NodeFlags.Const) || list.declarations.length !== 1)
    return;
  const statement = list.parent;
  if (!ts.isVariableStatement(statement) || statement.parent !== sourceFile || !exported(statement) || variable.type)
    return;
  if (
    fn.modifiers?.length ||
    fn.typeParameters ||
    !fn.type ||
    ts.isTypePredicateNode(fn.type) ||
    !simpleParameters(fn) ||
    callSensitive(fn)
  )
    return;
  if (fn.parameters.some((parameter) => !parameter.type || parameter.dotDotDotToken || parameter.questionToken)) return;
  const signature = sourceFile.text
    .slice(fn.getStart(sourceFile), fn.equalsGreaterThanToken.getStart(sourceFile))
    .trimEnd();
  if (!signature.startsWith('(') || /[\r\n]/.test(signature)) return;
  if (sourceFile.text.slice(fn.equalsGreaterThanToken.end, fn.body.getStart(sourceFile)).trim()) return;
  const suffix = sourceFile.text.slice(fn.body.end, statement.end);
  if (suffix !== ';' && suffix !== '') return;
  return { name: variable.name.text, signature, statement };
}

// The camelCase words that every name starts and ends with, joined as one lower camelCase name; ''
// when none.
function commonWords(names: readonly string[]): string {
  const split = names.map((name) => name.split(/(?=[A-Z])/));
  const shortest = Math.min(...split.map((words) => words.length));
  const sameAt = (pick: (words: string[]) => number): boolean =>
    split.every((words) => words[pick(words)] === split[0][pick(split[0])]);
  let leading = 0;
  while (leading < shortest && sameAt(() => leading)) leading++;
  let trailing = 0;
  while (leading + trailing < shortest && sameAt((words) => words.length - 1 - trailing)) trailing++;
  const words = [...split[0].slice(0, leading), ...split[0].slice(split[0].length - trailing)];
  const joined = words.join('');
  return /^[A-Za-z][A-Za-z0-9]*$/.test(joined) ? joined[0].toLowerCase() + joined.slice(1) : '';
}

function shareExportedArrows(sites: readonly ArrowSite[]): FixResult | undefined {
  if (sites.length !== 2 || sites[0].file !== sites[1].file || testFile.test(sites[0].file)) return;
  const [first, second] = sites;
  const original = exportedArrow(first);
  const copy = exportedArrow(second);
  if (
    !original ||
    !copy ||
    original.signature !== copy.signature ||
    first.fn.body.getText() !== second.fn.body.getText()
  )
    return;
  const checker = checkerFor(sites);
  const resolved = sites.map((site) => bindings(checker, site.fn));
  if (
    resolved[0].length !== resolved[1].length ||
    resolved[0].some((binding, index: number) => !binding || binding !== resolved[1][index])
  )
    return;
  // Named for what both exports share, such as getTokenOptions for getAccessTokenOptions and
  // getRefreshTokenOptions.
  const sharedName = commonWords([original.name, copy.name]);
  const helper =
    sharedName && sharedName.split(/(?=[A-Z])/).length > 1 && !nameUsed(first.sourceFile, sharedName)
      ? sharedName
      : original.name + 'Implementation';
  if (
    nameUsed(first.sourceFile, helper) ||
    nameUsed(first.sourceFile, 'eval') ||
    [original.name, copy.name, 'caller', 'callee', 'stack', 'captureStackTrace'].some((name) =>
      nameUsed(first.fn.body, name),
    )
  )
    return;
  const args = first.fn.parameters.map((parameter: ParameterDeclaration) => parameterName(parameter)).join(', ');
  const call = `${helper}(${args})`;
  const newline = newlineOf(first.sourceFile.text);
  const edits: TextEdit[] = [
    {
      start: first.fn.equalsGreaterThanToken.end,
      end: first.fn.body.getStart(first.sourceFile),
      text: ` ${call};${newline}${newline}function ${helper}${original.signature} `,
    },
    { start: second.fn.body.getStart(second.sourceFile), end: second.fn.body.end, text: call },
  ];
  if (original.statement.end !== first.fn.body.end)
    edits.push({ start: first.fn.body.end, end: original.statement.end, text: '' });
  return {
    edits,
    requiresReview: true,
    note: 'Both exported functions keep their signatures and call a private implementation. Confirm that they should evolve together.',
  };
}

// Resolve one direct, relative type import to distinguish an unknown callback input from an
// unresolved any.
const configCheckers = new WeakMap<Node, TypeChecker>();
function configChecker(first: DuplicateSite, variable: ConfigVariable, load: ProjectLoad): TypeChecker {
  const cached = configCheckers.get(variable);
  if (cached) return cached;
  const source = first.sourceFile;
  const files = new Map<string, SourceFile>([[path.resolve(source.fileName), source]]);
  const imports = new Map<string, ResolvedModuleFull>();
  for (const statement of moduleImports(source)) {
    const bindings = statement.importClause?.namedBindings;
    if (
      !bindings ||
      !ts.isNamedImports(bindings) ||
      !bindings.elements.some((binding) => nameUsed(variable.type, binding.name.text))
    )
      continue;
    const specifier = statement.moduleSpecifier.text;
    if (!specifier.startsWith('.')) continue;
    const target = path.posix.join(path.posix.dirname(first.file), specifier.replace(/\.js$/, ''));
    if (target.startsWith('../')) continue;
    const imported = load(target + '.ts')?.sourceFile;
    if (imported) {
      files.set(path.resolve(imported.fileName), imported);
      imports.set(specifier, { resolvedFileName: imported.fileName, extension: ts.Extension.Ts });
    }
  }
  const compilerOptions: CompilerOptions = { strict: true, lib: ['lib.es5.d.ts'], types: [] };
  const native = ts.createCompilerHost(compilerOptions);
  const host: CompilerHost = {
    ...native,
    getSourceFile: (name, ...options) =>
      files.get(path.resolve(name)) ??
      (/^lib\.[\w.]+\.d\.ts$/.test(path.basename(name)) ? native.getSourceFile(name, ...options) : undefined),
    resolveModuleNames: (names: readonly string[], from: string) =>
      names.map((name) => (path.resolve(from) === path.resolve(source.fileName) ? imports.get(name) : undefined)),
  };
  const checker = ts.createProgram([...files.keys()], compilerOptions, host).getTypeChecker();
  configCheckers.set(variable, checker);
  return checker;
}

// The declaration around a callback property: `const x: T = { items: [{ prop: (v) => ... }] }` at
// the top level, or undefined when the callback sits in any other shape.
function isConfigProperty(node: Node): node is ConfigProperty {
  return ts.isPropertyAssignment(node) && ts.isIdentifier(node.name);
}

function isConfigVariable(node: Node): node is ConfigVariable {
  return ts.isVariableDeclaration(node) && node.type !== undefined && ts.isIdentifier(node.name);
}

function configDeclarationOf(fn: Node, sourceFile: SourceFile): ConfigDeclaration | undefined {
  const property = fn.parent;
  if (!isConfigProperty(property)) return;
  const array = property.parent.parent;
  if (!ts.isArrayLiteralExpression(array) || !ts.isPropertyAssignment(array.parent)) return;
  const variable = array.parent.parent.parent;
  if (!isConfigVariable(variable)) return;
  const statement = variable.parent.parent;
  if (!isLoneTopLevelConfig(variable, array, statement, sourceFile)) return;
  return { property, array, variable, statement };
}

function isLoneTopLevelConfig(
  variable: ConfigVariable,
  array: ArrayLiteralExpression,
  statement: Node,
  sourceFile: SourceFile,
): boolean {
  return (
    ts.isVariableStatement(statement) &&
    statement.parent === sourceFile &&
    ts.isVariableDeclarationList(variable.parent) &&
    (variable.parent.flags & ts.NodeFlags.Const) !== 0 &&
    variable.parent.declarations.length === 1 &&
    variable.initializer !== undefined &&
    ts.isObjectLiteralExpression(variable.initializer) &&
    variable.initializer === array.parent.parent
  );
}

function sitesAreCopies(
  sites: readonly ArrowSite[],
  fn: ArrowFunction,
  property: ConfigProperty,
  array: ArrayLiteralExpression,
): boolean {
  return sites.every(
    ({ fn: copy }) =>
      ts.isArrowFunction(copy) &&
      ts.isPropertyAssignment(copy.parent) &&
      copy.parent.name.getText() === property.name.text &&
      copy.parent.parent.parent === array &&
      copy.getText() === fn.getText(),
  );
}

function isBareIdentifierParameter(
  parameter: ParameterDeclaration,
): parameter is ParameterDeclaration & { readonly name: Identifier } {
  return (
    ts.isIdentifier(parameter.name) &&
    !parameter.type &&
    !parameter.initializer &&
    !parameter.questionToken &&
    !parameter.dotDotDotToken
  );
}

// The callback's single plain parameter, or undefined when the callback has any other signature or
// reads the call stack.
function plainParameterOf(fn: ArrowFunction): (ParameterDeclaration & { readonly name: Identifier }) | undefined {
  if (fn.modifiers?.length || fn.parameters.length !== 1 || fn.typeParameters || fn.type || callSensitive(fn)) return;
  const parameter = fn.parameters[0];
  if (!isBareIdentifierParameter(parameter)) return;
  if (['eval', 'stack', 'caller', 'callee', 'captureStackTrace'].some((word) => nameUsed(fn.body, word))) return;
  return parameter;
}

function callbacksTakeAndReturnUnknown(sites: readonly ArrowSite[], checker: TypeChecker): boolean {
  return sites.every(({ fn: copy }) => {
    const contextual = checker.getContextualType(copy);
    const signatures = contextual && checker.getNonNullableType(contextual).getCallSignatures();
    return (
      checker.getTypeAtLocation(copy.parameters[0]).flags === ts.TypeFlags.Unknown &&
      signatures?.length === 1 &&
      signatures[0].getReturnType().flags === ts.TypeFlags.Unknown
    );
  });
}

// Each duplicated property gets its own anchor line, so adjacent duplicated properties can be
// applied together. Undefined when this property is not among the first two or shares a key prefix
// with another duplicated one.
function helperSlotOf(
  array: ArrayLiteralExpression,
  property: ConfigProperty,
  sourceFile: SourceFile,
): number | undefined {
  const groups = new Map<string, number>();
  countConfigCallbackOccurrences(array, sourceFile, groups);
  const keys = [...groups].filter(([, count]) => count > 1).map(([key]) => key);
  const slot = keys.indexOf(property.getText(sourceFile));
  const crowded =
    slot < 0 ||
    slot > 1 ||
    keys.some((key) => key !== property.getText(sourceFile) && key.startsWith(property.name.text + ':'));
  return crowded ? undefined : slot;
}

// The line above the blank line that precedes `top`, if there is one.
function lineAboveBlankLine(text: string, top: number): number | undefined {
  const blankRow = top > 0 ? lineStart(text, top - 1) : 0;
  if (blankRow <= 0 || text.slice(blankRow, top).trim()) return;
  return blankRow - (text[blankRow - 2] === '\r' ? 2 : 1);
}

// Where the helper text goes around the declaration; undefined when the declaration is not alone on
// its lines.
function helperAnchorsOf(
  text: string,
  statement: Statement,
  slot: number,
  sourceFile: SourceFile,
): HelperAnchors | undefined {
  const firstComment = ts.getLeadingCommentRanges(text, statement.pos)?.[0];
  const declarationStart = firstComment?.pos ?? statement.getStart(sourceFile);
  const top = lineStart(text, declarationStart);
  if (text.slice(top, declarationStart).trim()) return;
  // Both helpers sit together above the declaration: the first after the line above the blank line
  // that precedes it, the second just before it. Without such a blank line the second helper
  // follows the declaration instead.
  const above = lineAboveBlankLine(text, top);
  const aboveUsable = above !== undefined && Boolean(text.slice(lineStart(text, above), above).trim());
  const after = nextLineStart(text, statement.end);
  if (!aboveUsable && slot && text.slice(statement.end, after).trim()) return;
  return { top, above, aboveUsable, after };
}

function helperInsertion(
  { top, above, aboveUsable, after }: HelperAnchors,
  slot: number,
  helperText: string,
  newline: string,
): TextEdit {
  if (aboveUsable && above !== undefined)
    return slot
      ? { start: top, end: top, text: helperText + newline + newline }
      : { start: above, end: above, text: newline + newline + helperText };
  return slot
    ? { start: after, end: after, text: newline + helperText + newline }
    : { start: top, end: top, text: helperText + newline + newline };
}

function shareConfigCallbacks(sites: readonly ArrowSite[], load: ProjectLoad): FixResult | undefined {
  const first = sites[0];
  const { fn, sourceFile } = first;
  if (sites.length < 2 || sites.some((site) => site.file !== first.file) || !ts.isExternalModule(sourceFile)) return;
  const declaration = configDeclarationOf(fn, sourceFile);
  if (!declaration) return;
  const { property, array, variable, statement } = declaration;
  if (!sitesAreCopies(sites, fn, property, array)) return;
  const parameter = plainParameterOf(fn);
  if (!parameter) return;

  // A small offline checker needs only the two interface declarations, not the application's
  // dependency graph.
  const checker = configChecker(first, variable, load);
  if (!callbacksTakeAndReturnUnknown(sites, checker)) return;
  const helper = configCallbackName(sites, property, variable, sourceFile);
  if (!helper) return;
  const slot = helperSlotOf(array, property, sourceFile);
  if (slot === undefined) return;
  const text = sourceFile.text;
  const anchors = helperAnchorsOf(text, statement, slot, sourceFile);
  if (!anchors) return;
  const original = fn.body.getText(sourceFile);
  // Reindent only simple single-line strings; whitespace inside a template literal can be
  // observable.
  if (original.includes('`') || /\[\r\n]/.test(original)) return;
  const newline = newlineOf(text);
  const indentation = indentationAt(text, property.getStart(sourceFile));
  const body = original
    .split(/\r?\n/)
    .map((line, index) => (index && line.startsWith(indentation) ? line.slice(indentation.length) : line))
    .join(newline);
  const helperText = 'function ' + helper + '(' + parameter.name.text + ': unknown) ' + body;
  // The helper takes the callback's one parameter and reads no `this` or `arguments`, so the field
  // can hold it.
  const edits: TextEdit[] = sites.map(({ fn: copy }) => ({
    start: copy.getStart(sourceFile),
    end: copy.end,
    text: helper,
  }));
  edits.push(helperInsertion(anchors, slot, helperText, newline));
  return {
    edits,
    requiresReview: true,
    note: 'Moves the matching callback bodies into a named helper that each field uses. Check that these fields should evolve together.',
  };
}

// Named after the property and what the fields' keys share, such as transformDiscountDate for
// discountStartDate and discountEndDate; otherwise after the configuration variable and the
// property.
function configCallbackName(
  sites: readonly ArrowSite[],
  property: ConfigProperty,
  variable: ConfigVariable,
  sourceFile: SourceFile,
): string | undefined {
  const keyOf = ({ fn: copy }: ArrowSite): string | undefined => {
    const assignment = copy.parent;
    if (!ts.isPropertyAssignment(assignment) || !ts.isObjectLiteralExpression(assignment.parent)) return undefined;
    const field = assignment.parent.properties.find(
      (member): member is PropertyAssignment =>
        ts.isPropertyAssignment(member) && member.name.getText(sourceFile) === 'key',
    );
    return field && ts.isStringLiteral(field.initializer) ? field.initializer.text : undefined;
  };
  const keys = sites.map(keyOf);
  const shared = keys.every((key): key is string => Boolean(key)) ? commonWords(keys) : '';
  const capitalized = (word: string): string => word[0].toUpperCase() + word.slice(1);
  const described = shared && property.name.text + capitalized(shared);
  if (described && !nameUsed(sourceFile, described)) return described;
  const fallback = variable.name.text + capitalized(property.name.text);
  if (!nameUsed(sourceFile, fallback)) return fallback;
}

function countConfigCallbackOccurrences(
  array: ArrayLiteralExpression,
  sourceFile: SourceFile,
  groups: Map<string, number>,
): void {
  for (const element of array.elements) {
    if (!ts.isObjectLiteralExpression(element)) continue;
    for (const member of element.properties) {
      if (!ts.isPropertyAssignment(member) || !ts.isArrowFunction(member.initializer)) continue;
      const key = member.getText(sourceFile);
      groups.set(key, (groups.get(key) ?? 0) + 1);
    }
  }
}

function buildDuplicate({ finding, load }: ProjectSiteFixInput): FixResult | undefined {
  const related: readonly Finding[] = Array.isArray(finding.related) ? finding.related : [];
  const sites: DuplicateSite[] = [];
  for (const location of [finding, ...related]) {
    const site = siteAt(load, location);
    if (!site) return;
    sites.push(site);
  }
  if (sites.every(isArrowSite)) return shareExportedArrows(sites) ?? shareConfigCallbacks(sites, load);
  if (sites.every(isMethodSite)) return shareClassMethods(sites, checkerFor(sites), load.createdModules);
  const candidates = sites.filter(canonicalCandidate);
  const canonical = candidates.find((site) => exported(site.fn)) ?? candidates[0];
  if (!canonical) return;
  const checker = checkerFor(sites);
  const resolved = sites.map((site) => bindings(checker, site.fn));
  const canonicalBindings = resolved[sites.indexOf(canonical)];
  const ownFileKey = 'file:' + stripExtension(path.resolve(canonical.sourceFile.fileName)) + '#';
  const editsByFile = new Map<string, TextEdit[]>();
  const addEdits = (file: string, edits: TextEdit[]): void => {
    editsByFile.set(file, [...(editsByFile.get(file) ?? []), ...edits]);
  };
  if (!exported(canonical.fn))
    addEdits(canonical.file, [
      {
        start: canonical.fn.getStart(canonical.sourceFile),
        end: canonical.fn.getStart(canonical.sourceFile),
        text: 'export ',
      },
    ]);
  for (const [index, copy] of sites.entries()) {
    if (copy === canonical) continue;
    const sameNames = canonicalBindings.every((binding, position) => {
      const other = resolved[index][position];
      if (!binding || !other) return false;
      if (binding === other) return copy.file === canonical.file || !binding.startsWith('file:');
      // A copy elsewhere may import the canonical file's own top-level name.
      return binding.startsWith(ownFileKey) && other === 'import:' + binding.slice('file:'.length);
    });
    if (!sameNames || resolved[index].length !== canonicalBindings.length) return;
    const edits = rewriteCopy(copy, canonical);
    if (!edits) return shareSiblingHelper(sites, checker);
    addEdits(copy.file, edits);
  }
  const location = `${canonical.file}:${canonical.fn.getSourceFile().getLineAndCharacterOfPosition(canonical.fn.name.getStart(canonical.sourceFile)).line + 1}`;
  return {
    targets: [...editsByFile].map(([file, edits]) => ({ file, edits })),
    note: `Keeps ${location} as the one implementation; the other copies now call it.`,
  };
}

// Importing one decorated class module from the other can introduce a cycle or execute decorators
// earlier. A new, independent module is an alternative for identical private helpers whose only
// consumers call them.
const maximumSharedHelperLines = 30;

function shareSiblingHelper(sites: readonly DuplicateSite[], checker: TypeChecker): ModuleCreatingFix | undefined {
  if (!sites.every(canonicalCandidate)) return;
  const first = sites[0];
  const helper = first.fn.name.text;
  const implementation = first.fn.getText(first.sourceFile);
  const helperDoc = leadingDoc(first);
  if (
    !/^[a-z][A-Za-z0-9]*$/.test(helper) ||
    implementation.split('\n').length > maximumSharedHelperLines ||
    /@|eslint|prettier/.test(helperDoc)
  )
    return;
  const folder = path.dirname(first.file);
  const stem = kebabCase(helper);
  const file = path.posix.join(folder.replaceAll('\\', '/'), stem + '.ts');
  const targets: FileTarget[] = [];
  for (const site of sites) {
    const { fn, sourceFile } = site;
    if (
      path.dirname(site.file) !== folder ||
      !site.file.endsWith('.ts') ||
      fn.modifiers?.length ||
      fn.getText(sourceFile) !== implementation ||
      leadingDoc(site) !== helperDoc ||
      !isolatedHelper(site, checker)
    )
      return;
    if (!ownsLines(fn)) return;
    const relativeImports = moduleImports(sourceFile).filter((statement) =>
      statement.moduleSpecifier.text.startsWith('.'),
    );
    const lastRelative = relativeImports.at(-1);
    if (!lastRelative || relativeImports.some((statement) => /\.[cm]?tsx?$/.test(statement.moduleSpecifier.text)))
      return;
    const specifier = relativeSpecifier(site.file, file, sourceFile);
    const quote = quoteOf(sourceFile);
    // The new import joins the file's own relative imports, after the last of them.
    const importAt = lineEnd(sourceFile.text, lastRelative.end);
    const importText = newlineOf(sourceFile.text) + `import { ${helper} } from ${quote}${specifier}${quote};`;
    const edits = withInsertion([removal(fn, sourceFile)], { start: importAt, end: importAt, text: importText });
    if (!edits) return;
    targets.push({ file: site.file, edits });
  }
  // Refuse shadowing by other extensions or a directory of the same name, including on
  // case-insensitive systems.
  const neighbors = fs.readdirSync(path.dirname(first.sourceFile.fileName));
  if (neighbors.some((name) => name.toLowerCase() === stem || name.toLowerCase().startsWith(stem + '.'))) return;
  return {
    targets,
    createdModule: { file, text: helperDoc + 'export ' + implementation + newlineOf(first.sourceFile.text) },
    requiresReview: true,
    note: 'Moves identical module-private helpers into a new sibling module. Verify that this helper should evolve with both consumers and is included by your build.',
  };
}

// The method from its parameters to its closing brace, without the class indentation. Undefined
// when that would change a literal or the lines are not indented under the method.
function methodShape({ fn, sourceFile }: MethodSite): string | undefined {
  if (hasMultilineLiteral(fn) || /\\\r?\n/.test(fn.getText(sourceFile))) return;
  const text = sourceFile.text.slice(fn.name.end, fn.end).replaceAll('\r\n', '\n');
  const [head, ...rest] = text.split('\n');
  const body = dedentLines(rest.join('\n'), indentationAt(sourceFile.text, fn.getStart(sourceFile)));
  return body === undefined ? undefined : head + '\n' + body;
}

function importDeclarationOf(declaration: Node): ImportDeclaration | undefined {
  const owner = ts.isImportSpecifier(declaration)
    ? declaration.parent.parent.parent
    : ts.isImportClause(declaration)
      ? declaration.parent
      : ts.isNamespaceImport(declaration)
        ? declaration.parent.parent
        : undefined;
  return owner && ts.isImportDeclaration(owner) ? owner : undefined;
}

// Each name the method refers to: one of its own declarations, a global, or an import. Undefined
// when it reads a class or module-private name, which a function in another module could not see.
function methodReferences({ fn }: MethodSite, checker: TypeChecker): MethodReference[] | undefined {
  const references: MethodReference[] = [];
  let movable = true;
  (function visit(node: Node): void {
    if (!movable) return;
    const parent = node.parent;
    const skipped =
      node === fn.name ||
      (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
      (ts.isQualifiedName(parent) && parent.right === node);
    if (ts.isIdentifier(node) && !skipped) {
      const symbol =
        ts.isShorthandPropertyAssignment(parent) && parent.name === node
          ? checker.getShorthandAssignmentValueSymbol(parent)
          : checker.getSymbolAtLocation(node);
      const declaration = symbol?.declarations?.[0];
      const imported = declaration && importDeclarationOf(declaration);
      if (!declaration) references.push({ key: 'global:' + node.text, name: node.text });
      else if (declaration.pos >= fn.pos && declaration.end <= fn.end) references.push({ key: 'local' });
      else if (imported && isStringImport(imported)) {
        const source = moduleKey(fn.getSourceFile().fileName, imported.moduleSpecifier.text);
        references.push({ key: `import:${source}#${node.text}`, name: node.text, imported, binding: declaration });
      } else movable = false;
    }
    ts.forEachChild(node, visit);
  })(fn);
  return movable ? references : undefined;
}

// The helper module's copy of each import the method uses, written relative to the new module's
// folder.
function helperImports(site: DuplicateSite, references: readonly MethodReference[], folder: string): string[] {
  const used = new Map<StringLiteralImport, Set<Node>>();
  for (const { imported, binding } of references) {
    if (!imported || !binding) continue;
    let bindings = used.get(imported);
    if (!bindings) {
      bindings = new Set();
      used.set(imported, bindings);
    }
    bindings.add(binding);
  }
  const quote = quoteOf(site.sourceFile);
  return [...used].flatMap(([declaration, bindings]) => {
    let specifier = declaration.moduleSpecifier.text;
    if (specifier.startsWith('.')) {
      const target = path.posix.join(path.posix.dirname(site.file), specifier);
      specifier = path.posix.relative(folder, target);
      if (!specifier.startsWith('.')) specifier = './' + specifier;
    }
    const clause = declaration.importClause;
    if (!clause) return [];
    const parts: string[] = [];
    if (bindings.has(clause) && clause.name) parts.push(clause.name.text);
    const named = clause.namedBindings;
    if (named && bindings.has(named) && ts.isNamespaceImport(named)) parts.push('* as ' + named.name.text);
    const elements = named && ts.isNamedImports(named) ? named.elements.filter((item) => bindings.has(item)) : [];
    if (elements.length) parts.push(`{ ${elements.map((item) => item.getText(site.sourceFile)).join(', ')} }`);
    return [`import ${clause.isTypeOnly ? 'type ' : ''}${parts.join(', ')} from ${quote}${specifier}${quote};`];
  });
}

// Removes imports that only the replaced method body used. Undefined when one cannot be removed on
// its own lines.
function strandedImportRemovals(sourceFile: SourceFile, body: Node): TextEdit[] | undefined {
  const text = sourceFile.text;
  const byDeclaration = new Map<StringLiteralImport, ImportBinding[]>();
  for (const { declaration, binding } of strandedImports(sourceFile, body)) {
    const declared = byDeclaration.get(declaration) ?? [];
    declared.push(binding);
    byDeclaration.set(declaration, declared);
  }
  const edits: TextEdit[] = [];
  for (const [declaration, bindings] of byDeclaration) {
    const declarationText = declaration.getText(sourceFile);
    if (/\/\/|\/\*/.test(declarationText) || !ownsLines(declaration)) return;
    const clause = declaration.importClause;
    if (!clause) return;
    const named = clause.namedBindings;
    const elements = named && ts.isNamedImports(named) ? named.elements : [];
    const total = (clause.name ? 1 : 0) + (named && ts.isNamespaceImport(named) ? 1 : 0) + elements.length;
    if (bindings.length === total) {
      edits.push(lineDeletion(text, lineStart(text, declaration.getStart(sourceFile)), declaration.end));
      continue;
    }
    if (bindings.some((binding) => !ts.isImportSpecifier(binding))) return;
    const kept = elements.filter((element) => !bindings.includes(element));
    if (!declarationText.includes('\n') && named) {
      const list = `{ ${kept.map((element) => element.getText(sourceFile)).join(', ')} }`;
      edits.push({ start: named.getStart(sourceFile), end: named.end, text: list });
      continue;
    }
    for (const element of bindings) {
      const rest = text.slice(element.end, lineEnd(text, element.end));
      if (!ownsLines(element) && !/^,\s*$/.test(rest)) return;
      edits.push(lineDeletion(text, lineStart(text, element.getStart(sourceFile)), element.end));
    }
  }
  return edits;
}

function commonFolder(files: readonly string[]) {
  const [first, ...others] = files.map((file) => path.posix.dirname(file).split('/'));
  let length = first.length;
  for (const segments of others) {
    let shared = 0;
    while (shared < Math.min(length, segments.length) && segments[shared] === first[shared]) shared++;
    length = shared;
  }
  return first.slice(0, length).join('/');
}

// The method as a candidate to share, or undefined when a function in another module could not
// stand in for it.
function sharedMethodCandidate(site: MethodSite, helper: string, checker: TypeChecker): MethodCandidate | undefined {
  const { fn } = site;
  if (
    !ts.isClassLike(fn.parent) ||
    !site.file.endsWith('.ts') ||
    testFile.test(site.file) ||
    !ts.isExternalModule(site.sourceFile) ||
    fn.questionToken ||
    fn.asteriskToken ||
    !fn.body.statements.length ||
    !simpleParameters(fn) ||
    callSensitive(fn) ||
    fn.parameters.some((parameter: ParameterDeclaration) => parameterName(parameter) === helper)
  )
    return;
  const shape = methodShape(site);
  const references = methodReferences(site, checker);
  if (shape === undefined || !references) return;
  return { site, shape, references, referenceKeys: JSON.stringify(references.map((reference) => reference.key)) };
}

// The largest set of candidates that agree on text and on what every name refers to; the first set
// on a tie.
function largestSharedMethodGroup(
  sites: readonly MethodSite[],
  helper: string,
  checker: TypeChecker,
): MethodCandidate[] | undefined {
  const groups = new Map<string, MethodCandidate[]>();
  for (const site of sites) {
    const candidate = sharedMethodCandidate(site, helper, checker);
    if (!candidate) continue;
    const key = candidate.shape + '\0' + candidate.referenceKeys;
    groups.set(key, [...(groups.get(key) ?? []), candidate]);
  }
  let largest: MethodCandidate[] = [];
  for (const group of groups.values()) if (group.length > largest.length) largest = group;
  return largest.length > 1 ? largest : undefined;
}

const maximumHelperSearchFiles = 400;

// Exported top-level functions in the folders from `folderPath` up to the project root.
function* exportedFunctionsAbove(
  folderPath: string,
  rootPath: string,
  excludedFiles: ReadonlySet<string>,
): Generator<FunctionInFile> {
  let scanned = 0;
  for (let current = folderPath; current.startsWith(rootPath); current = path.dirname(current)) {
    let names: string[] = [];
    try {
      names = fs.readdirSync(current);
    } catch {
      // An unreadable folder offers no candidates.
    }
    for (const name of names) {
      const file = path.join(current, name);
      if (!name.endsWith('.ts') || name.endsWith('.d.ts') || testFile.test(file) || excludedFiles.has(file)) continue;
      if (++scanned > maximumHelperSearchFiles) return;
      const text = fs.readFileSync(file, 'utf8');
      if (!text.includes('export function')) continue;
      const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
      for (const statement of sourceFile.statements)
        if (isNamedFunctionDeclaration(statement) && exported(statement)) yield { fn: statement, sourceFile };
    }
    if (current === rootPath) return;
  }
}

// The import bindings of a module by local name, each as the module and exported name it stands
// for.
function importedNamesOf(sourceFile: SourceFile): Map<string, string | undefined> {
  const importedNames = new Map<string, string | undefined>();
  for (const declaration of moduleImports(sourceFile)) {
    const clause = declaration.importClause;
    const named = clause?.namedBindings;
    const bindingNodes: ImportBinding[] = [];
    if (clause) bindingNodes.push(clause);
    if (named && ts.isNamespaceImport(named)) bindingNodes.push(named);
    if (named && ts.isNamedImports(named)) bindingNodes.push(...named.elements);
    for (const node of bindingNodes) if (node.name) importedNames.set(node.name.text, importedBinding(node));
  }
  return importedNames;
}

// Whether every name the method reads means the same thing inside the existing function's module.
function sameReferences(references: readonly MethodReference[], existing: FunctionInFile): boolean {
  const importedNames = importedNamesOf(existing.sourceFile);
  return references.every((reference) => {
    if (reference.key === 'local' || reference.name === undefined) return true;
    if (reference.imported && reference.binding)
      return importedNames.get(reference.name) === importedBinding(reference.binding);
    return !bindingDeclared(existing.sourceFile, reference.name, existing.fn);
  });
}

// A function the project already exports with the method's implementation, such as one an earlier
// fix created.
function findExistingHelper(group: readonly MethodCandidate[], projectRoot: string): FunctionInFile | undefined {
  const { site, references } = group[0];
  const { fn, sourceFile } = site;
  const methodKey = canonicalKey(fn, sourceFile);
  const methodType = fn.type?.getText(sourceFile);
  const groupFiles = new Set(group.map((member) => path.resolve(member.site.sourceFile.fileName)));
  const folderPath = path.dirname(path.resolve(sourceFile.fileName));
  for (const existing of exportedFunctionsAbove(folderPath, projectRoot, groupFiles)) {
    if (
      existing.fn.type?.getText(existing.sourceFile) === methodType &&
      !existing.fn.asteriskToken &&
      !callSensitive(existing.fn) &&
      canonicalKey(existing.fn, existing.sourceFile) === methodKey &&
      sameReferences(references, existing)
    )
      return existing;
  }
}

// A call belongs to the class that declares the method only when no function between them rebinds
// `this`.
function boundToClass(node: Node, classNode: Node): boolean {
  for (let current: Node | undefined = node.parent; current && current !== classNode; current = current.parent) {
    if (ts.isFunctionDeclaration(current) || ts.isFunctionExpression(current) || ts.isClassLike(current)) return false;
    if (ts.isObjectLiteralExpression(current)) return false;
    if (ts.isClassElement(current) && ts.canHaveModifiers(current) && ts.getModifiers(current)?.some(isStaticModifier))
      return false;
  }
  return true;
}

function isStaticModifier(modifier: Node): boolean {
  return modifier.kind === ts.SyntaxKind.StaticKeyword;
}

// Edits that point every `this.<name>(args)` call at `local`, for a private method that only
// forwards its parameters and that nothing else can reach. Undefined when any use needs the method
// to stay.
function inlineCallEdits({ fn, sourceFile }: MethodSite, local: string): TextEdit[] | undefined {
  const modifiers = fn.modifiers ?? [];
  if (modifiers.length !== 1 || modifiers[0].kind !== ts.SyntaxKind.PrivateKeyword) return;
  if (ts.getLeadingCommentRanges(sourceFile.text, fn.pos)?.length) return;
  const name = propertyNameText(fn.name);
  const edits: TextEdit[] = [];
  let inlinable = true;
  // The method's own body is replaced with it, so only the rest of the file can use the name.
  (function visit(node: Node): void {
    if (!inlinable || node === fn) return;
    if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression))
      inlinable = node.argumentExpression.text !== name;
    if (ts.isPropertyAccessExpression(node) && node.name.text === name) {
      const call = node.parent;
      inlinable =
        node.expression.kind === ts.SyntaxKind.ThisKeyword &&
        ts.isCallExpression(call) &&
        call.expression === node &&
        !call.questionDotToken &&
        !call.typeArguments &&
        call.arguments.length === fn.parameters.length &&
        !call.arguments.some(ts.isSpreadElement) &&
        boundToClass(call, fn.parent);
      if (inlinable) edits.push({ start: node.getStart(sourceFile), end: node.end, text: local });
    }
    ts.forEachChild(node, visit);
  })(sourceFile);
  return inlinable ? edits : undefined;
}

// Everything one file needs once its method is shared: calls go to `local` directly when possible,
// and the method otherwise stays as a delegating wrapper.
function siteEdits(site: MethodSite, local: string): TextEdit[] | undefined {
  const { fn, sourceFile } = site;
  const calls = inlineCallEdits(site, local);
  const methodEdits = calls ? [removal(fn, sourceFile), ...calls] : delegation(site, local);
  const imports = strandedImportRemovals(sourceFile, calls ? fn : fn.body);
  if (methodEdits && imports) return [...methodEdits, ...imports];
}

// The name the file uses for the shared function; a prefixed one when the file already declares the
// plain name.
function localNameFor(sourceFile: SourceFile, helper: string, fn: Node): string | undefined {
  if (!bindingDeclared(sourceFile, helper, fn)) return helper;
  const local = 'shared' + helper[0].toUpperCase() + helper.slice(1);
  return nameUsed(sourceFile, local) ? undefined : local;
}

function addExistingImport(site: DuplicateSite, existing: FunctionInFile, edits: TextEdit[]): TextEdit[] | undefined {
  const imported = importEdit(site, existing, site.fn);
  if (
    !imported ||
    site.fn.parameters.some((parameter: ParameterDeclaration) => parameterName(parameter) === imported.local)
  )
    return;
  return imported.edit ? withInsertion(edits, imported.edit) : edits;
}

function addNewModuleImport(
  site: DuplicateSite,
  file: string,
  helper: string,
  local: string,
  edits: TextEdit[],
): TextEdit[] | undefined {
  const { sourceFile } = site;
  const text = sourceFile.text;
  const relativeImports = moduleImports(sourceFile).filter((statement) =>
    statement.moduleSpecifier.text.startsWith('.'),
  );
  if (relativeImports.some((statement) => /\.[cm]?tsx?$/.test(statement.moduleSpecifier.text))) return;
  const anchor = relativeImports.at(-1) ?? moduleImports(sourceFile).at(-1);
  if (!anchor) return;
  const quote = quoteOf(sourceFile);
  const specifier = relativeSpecifier(site.file, file, sourceFile);
  const named = local === helper ? helper : `${helper} as ${local}`;
  const at = lineEnd(text, anchor.end);
  return withInsertion(edits, {
    start: at,
    end: at,
    text: newlineOf(text) + `import { ${named} } from ${quote}${specifier}${quote};`,
  });
}

// A helper name another fix in this scan already creates gets a number, so both fixes apply in one
// run.
const maximumModuleNumber = 9;

// The module that would hold the shared function, in the nearest folder the files have in common.
function newHelperModule(
  group: readonly MethodCandidate[],
  helper: string,
  claimedModules: ReadonlySet<string> | undefined,
): NewHelperModule | undefined {
  const { references, shape } = group[0];
  const sites = group.map((member) => member.site);
  const [first] = sites;
  const folder = commonFolder(sites.map((site) => site.file));
  const plainStem = kebabCase(helper);
  if (!folder || folder === '.') return;
  const absoluteFolder = path.resolve(
    path.dirname(first.sourceFile.fileName),
    path.posix.relative(path.posix.dirname(first.file), folder),
  );
  const neighbors = fs.readdirSync(absoluteFolder);
  const onDisk = (stem: string): boolean =>
    neighbors.some((name) => name.toLowerCase() === stem || name.toLowerCase().startsWith(stem + '.'));
  // A numbered name never shadows the project's own module of the plain name, or a file another fix
  // creates.
  let stem = plainStem;
  for (let number = 2; claimedModules?.has(folder + '/' + stem + '.ts') || onDisk(stem); number++) {
    if (number > maximumModuleNumber) return;
    stem = plainStem + '-' + number;
  }
  const imports = helperImports(first, references, folder);
  const moduleText = (imports.length ? imports.join('\n') + '\n\n' : '') + 'export function ' + helper + shape + '\n';
  return {
    file: folder + '/' + stem + '.ts',
    text: moduleText.replaceAll('\n', newlineOf(first.sourceFile.text)),
    ...(stem !== plainStem && { sharesNameWith: folder + '/' + plainStem + '.ts' }),
  };
}

// Identical private methods in classes of different files: calls reach one exported function, found
// in the project when it already has one with this implementation and otherwise created in a new
// module. A method that cannot be removed stays and delegates to it. Methods that differ from the
// largest identical set are left alone.
function shareClassMethods(
  sites: readonly MethodSite[],
  checker: TypeChecker,
  claimedModules: ReadonlySet<string> | undefined,
): ModuleCreatingFix | undefined {
  if (new Set(sites.map((site) => site.file)).size !== sites.length) return;
  const helper = ts.isIdentifier(sites[0].fn.name) ? sites[0].fn.name.text : '';
  if (!/^[a-z][A-Za-z0-9]*$/.test(helper)) return;
  const group = largestSharedMethodGroup(sites, helper, checker);
  // The exported function's own name would shadow an outer name the body reads.
  if (!group || group[0].references.some(({ name }) => name === helper)) return;
  const [{ site: first }] = group;
  const projectRoot = path.resolve(first.sourceFile.fileName, ...first.file.split('/').map(() => '..'));
  const existing = findExistingHelper(group, projectRoot);
  const created = existing ? undefined : newHelperModule(group, helper, claimedModules);
  if (!existing && !created) return;
  const sharedName = existing ? existing.fn.name.text : helper;

  const targets: FileTarget[] = [];
  for (const { site } of group) {
    const local = localNameFor(site.sourceFile, sharedName, site.fn);
    if (!local) return;
    const edits = siteEdits(site, local);
    const withImport =
      edits &&
      (existing
        ? addExistingImport(site, existing, edits)
        : created && addNewModuleImport(site, created.file, sharedName, local, edits));
    if (!withImport) return;
    targets.push({ file: site.file, edits: withImport });
  }
  return {
    targets,
    ...(created && { createdModule: { file: created.file, text: created.text } }),
    requiresReview: true,
    note: existing
      ? 'Calls the exported function the project already has with this implementation, so no new module is created. Verify that these methods should evolve with it and that removed imports had no needed side effects.'
      : 'Moves identical private methods into a new shared module, and calls go to it. Verify that these methods should evolve together, that removed imports had no needed side effects and that your build includes the new module.' +
        (created?.sharesNameWith
          ? ` ${created.sharesNameWith} already holds a different ${helper}; merge the two if they should behave the same.`
          : ''),
  };
}

function kebabCase(name: string): string {
  return name.replaceAll(/[A-Z]/g, (letter) => '-' + letter.toLowerCase());
}

function leadingDoc({ fn, sourceFile }: { fn: Node; sourceFile: SourceFile }): string {
  const comments = ts.getLeadingCommentRanges(sourceFile.text, fn.pos);
  return comments?.length ? sourceFile.text.slice(comments[0].pos, fn.getStart(sourceFile)) : '';
}

export default { 'duplicate-implementation': buildDuplicate };
