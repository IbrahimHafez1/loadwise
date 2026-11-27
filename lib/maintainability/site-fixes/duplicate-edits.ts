import path from 'node:path';
import { innermostNodeAt } from '../../shared/fix-hunks.js';
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
} from './helpers.js';
import { testFile } from '../duplicates.js';
import { stripExtension, moduleKey } from './duplicate-bindings.js';
import type { ImportDeclaration, Node, ParameterDeclaration, PropertyName, SourceFile, Statement } from 'typescript';
import type { Finding, TextEdit } from '../../shared/types.js';
import type { ProjectLoad } from '../types/site-fix-loader.js';
import type {
  BlockBodiedFunction,
  DuplicateSite,
  FunctionInFile,
  NamedFunctionDeclaration,
  NamedFunctionSite,
  StringLiteralImport,
} from '../types/duplicate-sites.js';
import type { FunctionWithBody } from '../types/site-fix-nodes.js';
import type { ArrowSite, ImportBinding, ImportEdit, MethodSite, StrandedImport } from '../types/duplicates.js';

const forbiddenKinds = new Set([
  ts.SyntaxKind.ThisKeyword,
  ts.SyntaxKind.SuperKeyword,
  ts.SyntaxKind.YieldExpression,
  ts.SyntaxKind.MetaProperty,
]);

export function siteAt(load: ProjectLoad, location: Finding): DuplicateSite | undefined {
  if (location.file === undefined || location.line === undefined || location.column === undefined) return;
  const entry = load(location.file);
  if (!entry?.sourceFile || !(location.line >= 1 && location.line <= entry.lineStarts.length)) return;
  const node = innermostNodeAt(ts, entry.sourceFile, entry.lineStarts[location.line - 1] + location.column - 1);
  const fn = node && flaggedFunction(node);
  if (fn && hasBlockBody(fn)) return { file: location.file, entry, sourceFile: entry.sourceFile, fn };
}

export function isGenerator(fn: FunctionWithBody): boolean {
  return 'asteriskToken' in fn && fn.asteriskToken !== undefined;
}

export function isArrowSite(site: DuplicateSite): site is ArrowSite {
  return ts.isArrowFunction(site.fn);
}

export function isMethodSite(site: DuplicateSite): site is MethodSite {
  return ts.isMethodDeclaration(site.fn);
}

export function isNamedFunctionDeclaration(node: Node): node is NamedFunctionDeclaration {
  return ts.isFunctionDeclaration(node) && node.name !== undefined && node.body !== undefined;
}

export function isStringImport(declaration: ImportDeclaration): declaration is StringLiteralImport {
  return ts.isStringLiteral(declaration.moduleSpecifier);
}

// The text of a parameter's name; destructuring patterns have none.
export function parameterName(parameter: ParameterDeclaration): string | undefined {
  return ts.isIdentifier(parameter.name) ? parameter.name.text : undefined;
}

// The text of a method's name, or undefined for a computed one.
export function propertyNameText(name: PropertyName): string | undefined {
  return 'text' in name ? name.text : undefined;
}

// Code that depends on how the function is called, so a plain call from elsewhere would behave
// differently.
export function callSensitive(fn: FunctionWithBody): boolean {
  let found = false;
  (function visit(node: Node): void {
    if (found) return;
    if (forbiddenKinds.has(node.kind) || (ts.isIdentifier(node) && node.text === 'arguments')) found = true;
    else ts.forEachChild(node, visit);
  })(fn.body);
  return found || isGenerator(fn);
}

export function exported(node: Node): boolean {
  const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  return modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false;
}

// A top-level function in a module that is not a test, so importing it runs no test registration.
export function canonicalCandidate(site: DuplicateSite): site is NamedFunctionSite {
  const { fn, file, sourceFile } = site;
  return (
    isNamedFunctionDeclaration(fn) &&
    ts.isSourceFile(fn.parent) &&
    !testFile.test(file) &&
    ts.isExternalModule(sourceFile) &&
    !callSensitive(fn)
  );
}

export function simpleParameters(fn: FunctionWithBody): boolean {
  return fn.parameters.every(
    (parameter: ParameterDeclaration) =>
      ts.isIdentifier(parameter.name) && !parameter.initializer && parameter.name.text !== 'this',
  );
}

// Local names that an import or a top-level declaration would clash with.
export function bindingDeclared(sourceFile: SourceFile, name: string, except: Node | undefined): boolean {
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

export function moduleImports(sourceFile: SourceFile): StringLiteralImport[] {
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

export function relativeSpecifier(fromFile: string, toFile: string, sourceFile: SourceFile): string {
  let specifier = path.relative(path.dirname(fromFile), toFile).replaceAll('\\', '/');
  const explicitExtensions = moduleImports(sourceFile).some((declaration) =>
    /^\.{1,2}\/.*\.[cm]?js$/.test(declaration.moduleSpecifier.text),
  );
  specifier = explicitExtensions ? specifier.replace(/\.([cm]?)tsx?$/, '.$1js') : stripExtension(specifier);
  return specifier.startsWith('.') ? specifier : './' + specifier;
}

export function quoteOf(sourceFile: SourceFile): string {
  const first = moduleImports(sourceFile)[0];
  return first && first.moduleSpecifier.getText(sourceFile).startsWith('"') ? '"' : "'";
}

// The edit that makes `localName` refer to the canonical function in the copy's file, or { local }
// when it is already imported. Undefined when the import cannot be added without changing load
// order.
export function importEdit(
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
export function removal(fn: Node, sourceFile: SourceFile): TextEdit {
  const text = sourceFile.text;
  const comments = ts.getLeadingCommentRanges(text, fn.pos) ?? [];
  let start = lineStart(text, comments.length ? comments[0].pos : fn.getStart(sourceFile));
  const before = text.slice(lineStart(text, Math.max(0, start - 1)), start);
  if (start > 0 && !before.trim()) start = lineStart(text, start - 1);
  return lineDeletion(text, start, fn.end);
}

// Two edits at one offset apply in no defined order, so an insertion joins the edit that starts
// where it does.
export function withInsertion(edits: TextEdit[], insertion: TextEdit): TextEdit[] | undefined {
  if (edits.some((edit: TextEdit) => edit.start < insertion.start && insertion.start < edit.end)) return;
  const joined = edits.find((edit: TextEdit) => edit.start === insertion.start);
  if (!joined) return [...edits, insertion];
  return edits.map((edit: TextEdit) => (edit === joined ? { ...edit, text: insertion.text + edit.text } : edit));
}

// Replaces the copy's body with a call to the shared function. An async copy returns the shared
// promise itself.
export function delegation(copy: DuplicateSite, local: string): TextEdit[] | undefined {
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

export function rewriteCopy(copy: DuplicateSite, canonical: NamedFunctionSite): TextEdit[] | undefined {
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

// Removes imports that only the replaced method body used. Undefined when one cannot be removed on
// its own lines.
export function strandedImportRemovals(sourceFile: SourceFile, body: Node): TextEdit[] | undefined {
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

export function kebabCase(name: string): string {
  return name.replaceAll(/[A-Z]/g, (letter) => '-' + letter.toLowerCase());
}

export function leadingDoc({ fn, sourceFile }: { fn: Node; sourceFile: SourceFile }): string {
  const comments = ts.getLeadingCommentRanges(sourceFile.text, fn.pos);
  return comments?.length ? sourceFile.text.slice(comments[0].pos, fn.getStart(sourceFile)) : '';
}
