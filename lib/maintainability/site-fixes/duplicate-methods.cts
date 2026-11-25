import fs from 'node:fs';
import path from 'node:path';
import { ts, lineEnd, indentationAt, newlineOf, nameUsed, hasMultilineLiteral, dedentLines } from './helpers.cjs';
import { testFile, canonicalKey } from '../duplicates.cjs';
import { moduleKey, importedBinding } from './duplicate-bindings.cjs';
import {
  bindingDeclared,
  callSensitive,
  delegation,
  exported,
  importEdit,
  isNamedFunctionDeclaration,
  isStringImport,
  kebabCase,
  moduleImports,
  parameterName,
  propertyNameText,
  quoteOf,
  relativeSpecifier,
  removal,
  simpleParameters,
  strandedImportRemovals,
  withInsertion,
} from './duplicate-edits.cjs';
import type { ImportDeclaration, Node, ParameterDeclaration, SourceFile, TypeChecker } from 'typescript';
import type { FileTarget, TextEdit } from '../../shared/types.cjs';
import type { ModuleCreatingFix } from '../types/created-module.cjs';
import type { DuplicateSite, FunctionInFile, StringLiteralImport } from '../types/duplicate-sites.cjs';
import type {
  ImportBinding,
  MethodCandidate,
  MethodReference,
  MethodSite,
  NewHelperModule,
} from '../types/duplicates.cjs';

const maximumHelperSearchFiles = 400;

// A helper name another fix in this scan already creates gets a number, so both fixes apply in one
// run.
const maximumModuleNumber = 9;

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
    let importedBindings = used.get(imported);
    if (!importedBindings) {
      importedBindings = new Set();
      used.set(imported, importedBindings);
    }
    importedBindings.add(binding);
  }
  const quote = quoteOf(site.sourceFile);
  return [...used].flatMap(([declaration, importedBindings]) => {
    let specifier = declaration.moduleSpecifier.text;
    if (specifier.startsWith('.')) {
      const target = path.posix.join(path.posix.dirname(site.file), specifier);
      specifier = path.posix.relative(folder, target);
      if (!specifier.startsWith('.')) specifier = './' + specifier;
    }
    const clause = declaration.importClause;
    if (!clause) return [];
    const parts: string[] = [];
    if (importedBindings.has(clause) && clause.name) parts.push(clause.name.text);
    const named = clause.namedBindings;
    if (named && importedBindings.has(named) && ts.isNamespaceImport(named)) parts.push('* as ' + named.name.text);
    const elements =
      named && ts.isNamedImports(named) ? named.elements.filter((item) => importedBindings.has(item)) : [];
    if (elements.length) parts.push(`{ ${elements.map((item) => item.getText(site.sourceFile)).join(', ')} }`);
    return [`import ${clause.isTypeOnly ? 'type ' : ''}${parts.join(', ')} from ${quote}${specifier}${quote};`];
  });
}

function commonFolder(files: readonly string[]): string {
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

function folderEntries(folder: string): string[] {
  try {
    return fs.readdirSync(folder);
  } catch {
    // An unreadable folder offers no candidates.
    return [];
  }
}

function isHelperCandidateFile(name: string, file: string, excludedFiles: ReadonlySet<string>): boolean {
  return name.endsWith('.ts') && !name.endsWith('.d.ts') && !testFile.test(file) && !excludedFiles.has(file);
}

function* exportedFunctionsIn(file: string): Generator<FunctionInFile> {
  const text = fs.readFileSync(file, 'utf8');
  if (!text.includes('export function')) return;
  const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  for (const statement of sourceFile.statements)
    if (isNamedFunctionDeclaration(statement) && exported(statement)) yield { fn: statement, sourceFile };
}

// Exported top-level functions in the folders from `folderPath` up to the project root.
function* exportedFunctionsAbove(
  folderPath: string,
  rootPath: string,
  excludedFiles: ReadonlySet<string>,
): Generator<FunctionInFile> {
  let scanned = 0;
  for (let current = folderPath; current.startsWith(rootPath); current = path.dirname(current)) {
    for (const name of folderEntries(current)) {
      const file = path.join(current, name);
      if (!isHelperCandidateFile(name, file, excludedFiles)) continue;
      if (++scanned > maximumHelperSearchFiles) return;
      yield* exportedFunctionsIn(file);
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
export function shareClassMethods(
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
