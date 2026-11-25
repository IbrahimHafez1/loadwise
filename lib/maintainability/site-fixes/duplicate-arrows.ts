import path from 'node:path';
import { ts, lineStart, nextLineStart, indentationAt, newlineOf, nameUsed } from './helpers.js';
import { testFile } from '../duplicates.js';
import { bindings, checkerFor } from './duplicate-bindings.js';
import { callSensitive, exported, moduleImports, parameterName, simpleParameters } from './duplicate-edits.js';
import type {
  ArrayLiteralExpression,
  ArrowFunction,
  CompilerHost,
  CompilerOptions,
  Identifier,
  Node,
  ParameterDeclaration,
  PropertyAssignment,
  ResolvedModuleFull,
  SourceFile,
  Statement,
  TypeChecker,
} from 'typescript';
import type { FixResult, TextEdit } from '../../shared/types.js';
import type { ProjectLoad } from '../types/site-fix-loader.js';
import type { DuplicateSite } from '../types/duplicate-sites.js';
import type {
  ArrowSite,
  ConfigDeclaration,
  ConfigProperty,
  ConfigVariable,
  ExportedArrow,
  HelperAnchors,
} from '../types/duplicates.js';

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

export function shareExportedArrows(sites: readonly ArrowSite[]): FixResult | undefined {
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
    const importedBindings = statement.importClause?.namedBindings;
    if (
      !importedBindings ||
      !ts.isNamedImports(importedBindings) ||
      !importedBindings.elements.some((binding) => nameUsed(variable.type, binding.name.text))
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

export function shareConfigCallbacks(sites: readonly ArrowSite[], load: ProjectLoad): FixResult | undefined {
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
