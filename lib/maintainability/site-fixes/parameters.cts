import { walkNodes } from '../walk.cjs';
import { noteUnreadable } from '../../shared/coverage-notes.cjs';
import { ts, flaggedFunction, functionWithBody, indentationAt, newlineOf, nameUsed } from './helpers.cjs';
import { originalProgram } from './isolated-program.cjs';
import { listFiles } from '../inputs.cjs';
import fs from 'node:fs';
import path from 'node:path';
import { canUseIndex, isPrivateManifest } from '../source-facts.cjs';
import type {
  ArrowFunction,
  CallExpression,
  Expression,
  FunctionDeclaration,
  Identifier,
  MethodDeclaration,
  Node,
  ParameterDeclaration,
  SourceFile,
  TypeChecker,
  TypeNode,
} from 'typescript';
import type { FixResult, SiteFixBuilder, TextEdit } from '../../shared/types.cjs';
import type { ProjectLoad, ProjectSiteFixInput } from '../types/site-fix-loader.cjs';
import type { FunctionWithBody, IdentifierParameter } from '../types/site-fix-nodes.cjs';

// A source file of the private package, with its path relative to the project and on disk.
interface ApplicationFile {
  file: string;
  absolute: string;
}

// The source files of one project and the texts already read from disk.
interface ApplicationSources {
  files: ApplicationFile[];
  diskTexts: Map<string, string>;
}

// What the argument object of a call replaces: a span of arguments, or the whole argument list.
interface ReplacedRange {
  start: number;
  end: number;
  whole: boolean;
}

// What the type literal of the grouped parameters is written from.
interface ParameterTypeContext {
  multiline: boolean;
  sourceFile: SourceFile;
  start: number;
  checker: TypeChecker;
  exact: boolean;
}

// Used when the project configures no width; Prettier's own 80 is rarely what a NestJS service is
// written to.
const defaultPrintWidth = 120;
const printWidthSources = [
  { file: '.prettierrc', pattern: /["']?printWidth["']?\s*[:=]\s*(\d+)/ },
  { file: '.prettierrc.json', pattern: /["']?printWidth["']?\s*[:=]\s*(\d+)/ },
  { file: '.prettierrc.yaml', pattern: /printWidth\s*:\s*(\d+)/ },
  { file: '.prettierrc.yml', pattern: /printWidth\s*:\s*(\d+)/ },
  { file: '.editorconfig', pattern: /max_line_length\s*=\s*(\d+)/ },
];

// Prettier is not guaranteed to run after a fix, so the width its configuration asks for has to be
// met here.
function printWidthOf(load: ProjectLoad): number {
  if (!load.projectRoot) return defaultPrintWidth;
  for (const { file, pattern } of printWidthSources) {
    try {
      const match = pattern.exec(fs.readFileSync(path.join(load.projectRoot, file), 'utf8'));
      if (match) return Number(match[1]);
    } catch (error) {
      // A missing configuration file just means the next source is tried; one that cannot be read
      // is said once.
      if (error instanceof Error)
        noteUnreadable({
          error,
          location: path.join(load.projectRoot, file),
          consequence: 'used the default print width',
        });
    }
  }
  return defaultPrintWidth;
}

function columnOf(text: string, offset: number): number {
  return offset - (text.lastIndexOf('\n', offset - 1) + 1);
}

// Length of the line after `start..end` is replaced by `replacement`.
function lineLengthWith(text: string, start: number, end: number, replacement: string): number {
  const lineStart = text.lastIndexOf('\n', start - 1) + 1;
  const nextBreak = text.indexOf('\n', end);
  const lineEnd = nextBreak === -1 ? text.length : nextBreak;
  return (text.slice(lineStart, start) + replacement + text.slice(end, lineEnd)).replace(/\r$/, '').length;
}

// Groups every position any caller supplies, so no call is left with an object followed by
// positional arguments.
function isIdentifierParameter(parameter: ParameterDeclaration): parameter is IdentifierParameter {
  return ts.isIdentifier(parameter.name);
}

function suppliedPrefix(fn: FunctionWithBody, calls: readonly CallExpression[]): IdentifierParameter[] {
  const supplied = calls.reduce((maximum, call) => Math.max(maximum, call.arguments.length), 0);
  const prefix = fn.parameters.slice(0, supplied);
  for (const parameter of prefix) {
    if (!parameter.type && !parameter.initializer) return [];
    if (parameter.dotDotDotToken || !ts.isIdentifier(parameter.name)) return [];
    if (parameter.name.text === '__proto__' || parameter.modifiers?.length) return [];
  }
  // Moving a type that refers to a sibling parameter into that parameter's binding pattern can make
  // it circular.
  const identifiers = prefix.filter(isIdentifierParameter);
  const referencesSibling = identifiers.some((parameter) => {
    const type = parameter.type;
    return type !== undefined && identifiers.some((sibling) => nameUsed(type, sibling.name.text));
  });
  return referencesSibling ? [] : identifiers;
}

// An optional or defaulted parameter reads a missing property exactly like an explicit `undefined`.
function omittable(parameter: ParameterDeclaration): boolean {
  return Boolean(parameter.questionToken || parameter.initializer);
}

function isUndefinedLiteral(argument: Expression): boolean {
  return ts.isIdentifier(argument) && argument.text === 'undefined';
}

// Swapping two arguments of a closure whose parameter types are mutually unassignable already fails
// to compile.
function distinctlyTyped(fn: FunctionWithBody, checker: TypeChecker): boolean {
  const types = fn.parameters.map((parameter: ParameterDeclaration) => checker.getTypeAtLocation(parameter));
  return types.every((type, index) =>
    types.every(
      (other, otherIndex) =>
        index === otherIndex || (!checker.isTypeAssignableTo(type, other) && !checker.isTypeAssignableTo(other, type)),
    ),
  );
}

// Under exactOptionalPropertyTypes an optional property rejects an explicit `undefined` the
// parameter accepted.
function exactOptionalTypes(load: ProjectLoad): boolean {
  if (!load.projectRoot) return true;
  try {
    const config = fs.readFileSync(path.join(load.projectRoot, 'tsconfig.json'), 'utf8');
    return /"exactOptionalPropertyTypes"\s*:\s*true/.test(config);
  } catch {
    return false;
  }
}

function directCalls(block: Node, name: Identifier): CallExpression[] {
  const calls: CallExpression[] = [];
  let escapes = false;
  walkNodes(block, (node: Node) => {
    if (ts.isWithStatement(node) || (ts.isIdentifier(node) && node.text === 'eval')) escapes = true;
    if (!ts.isIdentifier(node) || node.text !== name.text || node === name) return;
    if (ts.isCallExpression(node.parent) && node.parent.expression === node) calls.push(node.parent);
    else escapes = true;
  });
  return escapes ? [] : calls;
}

// In a named property, an anonymous function or class is assigned an observable name.
function gainsPropertyName(argument: Expression): boolean {
  const value = ts.skipOuterExpressions(argument);
  return ts.isArrowFunction(value) || ((ts.isFunctionExpression(value) || ts.isClassExpression(value)) && !value.name);
}

function multilineObject(properties: readonly string[], newline: string, indentation: string): string {
  const inner = indentation + '  ';
  return '{' + newline + inner + properties.join(',' + newline + inner) + ',' + newline + indentation + '}';
}

// A call whose arguments are all grouped is rewritten up to its closing parenthesis, so the edit
// covers every row the old call used. A formatter that reformats the changed rows then sees the
// whole call, never half of it.
function replacedRange(call: CallExpression, first: number, last: number, sourceFile: SourceFile): ReplacedRange {
  const open = call.arguments.pos;
  const close = call.end - 1;
  const lastArgument = call.arguments.at(-1);
  const wholeList =
    lastArgument !== undefined && first === call.arguments[0].getStart(sourceFile) && last === lastArgument.end;
  if (!wholeList || !sourceFile.text.slice(open, close).includes('\n'))
    return { start: first, end: last, whole: false };
  return { start: open, end: close, whole: true };
}

// What the call-site rewrite of the grouped arguments is built from.
interface OptionsArgumentInput {
  readonly call: CallExpression;
  readonly parameters: readonly IdentifierParameter[];
  readonly sourceFile: SourceFile;
  readonly firstIndex: number;
  readonly javaScript: boolean;
  readonly printWidth: number;
}

function optionsArgument({
  call,
  parameters,
  sourceFile,
  firstIndex,
  javaScript,
  printWidth,
}: OptionsArgumentInput): TextEdit | undefined {
  const endIndex = firstIndex + parameters.length;
  const grouped = call.arguments.slice(firstIndex, endIndex);
  if (call.arguments.slice(0, endIndex).some(ts.isSpreadElement)) return;
  // A TypeScript call may stop early only before optional or defaulted parameters, which the
  // compiler enforces.
  if (grouped.length !== parameters.length && (javaScript || !grouped.length)) return;
  const properties: string[] = [];
  for (const [index, argument] of grouped.entries()) {
    if (gainsPropertyName(argument)) return;
    if (!javaScript && omittable(parameters[index]) && isUndefinedLiteral(argument)) continue;
    const name = parameters[index].name.text;
    properties.push(
      ts.isIdentifier(argument) && argument.text === name ? name : name + ': ' + argument.getText(sourceFile),
    );
  }
  const range = replacedRange(call, grouped[0].getStart(sourceFile), grouped[grouped.length - 1].end, sourceFile);
  const { start, end } = range;
  const original = sourceFile.text.slice(start, end);
  if (/\/\/|\/\*/.test(original)) return;
  const newline = newlineOf(original);
  const indentation = indentationAt(sourceFile.text, range.whole ? call.arguments.pos : start);
  const inline = properties.length ? '{ ' + properties.join(', ') + ' }' : '{}';
  const tooWide = lineLengthWith(sourceFile.text, start, end, inline) > printWidth;
  if (!properties.length || !(original.includes('\n') || tooWide)) return { start, end, text: inline };
  return { start, end, text: multilineObject(properties, newline, indentation) };
}

function arrowCalls(fn: ArrowFunction): CallExpression[] {
  const declaration = fn.parent;
  if (!ts.isVariableDeclaration(declaration) || declaration.type || !ts.isIdentifier(declaration.name)) return [];
  const list = declaration.parent;
  if (!(list.flags & ts.NodeFlags.Const) || !ts.isVariableStatement(list.parent)) return [];
  const block = list.parent.parent;
  return ts.isBlock(block) ? directCalls(block, declaration.name) : [];
}

function hasStrictDirective(block: Node): boolean {
  const statements = ts.isBlock(block) || ts.isSourceFile(block) ? block.statements : [];
  for (const statement of statements) {
    if (!ts.isPrologueDirective(statement)) break;
    if (statement.expression.getText() === "'use strict'" || statement.expression.getText() === '"use strict"')
      return true;
  }
  return false;
}

function isolatedModule(sourceFile: SourceFile): boolean {
  return ts.isExternalModule(sourceFile) || /\.[cm]js$/i.test(sourceFile.fileName);
}

function strictSource(sourceFile: SourceFile): boolean {
  return ts.isExternalModule(sourceFile) || /\.mjs$/i.test(sourceFile.fileName) || hasStrictDirective(sourceFile);
}

function declarationCalls(fn: FunctionDeclaration, sourceFile: SourceFile): CallExpression[] {
  if (!fn.name || fn.modifiers?.some((modifier) => modifier.kind !== ts.SyntaxKind.AsyncKeyword)) return [];
  const scope = fn.parent;
  if (scope === sourceFile) {
    if (!isolatedModule(sourceFile)) return [];
  } else if (!ts.isBlock(scope) || !functionWithBody(scope.parent) || scope.parent.body !== scope) return [];
  return directCalls(scope, fn.name);
}

// Leave defaults and binding patterns in place. Only group positions that every caller actually
// supplies.
function suppliedJsParameters(fn: FunctionWithBody, calls: readonly CallExpression[]): IdentifierParameter[] {
  const supplied = calls.reduce((minimum, call) => Math.min(minimum, call.arguments.length), fn.parameters.length);
  let longest: IdentifierParameter[] = [];
  let current: IdentifierParameter[] = [];
  for (const [index, parameter] of fn.parameters.slice(0, supplied).entries()) {
    if (calls.some((call) => ts.isSpreadElement(call.arguments[index]))) break;
    if (
      parameter.initializer ||
      parameter.dotDotDotToken ||
      !isIdentifierParameter(parameter) ||
      parameter.name.text === '__proto__' ||
      calls.some((call) => gainsPropertyName(call.arguments[index]))
    ) {
      current = [];
      continue;
    }
    current.push(parameter);
    if (current.length > longest.length) longest = current;
  }
  return longest;
}

const applicationSources = new WeakMap<ProjectLoad, ApplicationSources>();

// Every source file of a private package, as the files that can be searched and those read only
// when needed.
function applicationFiles(projectRoot: string): ApplicationFile[] {
  const files: ApplicationFile[] = [];
  for (const file of listFiles(projectRoot)) {
    if (/\.[cm]?[jt]sx?$/i.test(file)) files.push({ file, absolute: path.resolve(projectRoot, file) });
  }
  return files;
}

// The scan's identifier index answers for the files it read; any other file is read from disk once.
function mentionsName(
  entry: ApplicationFile,
  name: string,
  identifierIndex: ReadonlyMap<string, string> | undefined,
  diskTexts: Map<string, string>,
): boolean {
  const indexed = identifierIndex?.get(entry.file);
  if (indexed !== undefined && canUseIndex(name)) return indexed.includes(name);
  let text = diskTexts.get(entry.absolute);
  if (text === undefined) {
    text = fs.readFileSync(entry.absolute, 'utf8');
    diskTexts.set(entry.absolute, text);
  }
  return text.includes(name);
}

function usedOutsideFile(
  load: ProjectLoad,
  filename: string,
  name: string,
  identifierIndex: ReadonlyMap<string, string> | undefined,
): boolean {
  const projectRoot = load.projectRoot;
  if (!projectRoot) return true;
  let sources = applicationSources.get(load);
  if (!sources) {
    if (!isPrivateManifest(path.join(projectRoot, 'package.json'))) return true;
    sources = { files: applicationFiles(projectRoot), diskTexts: new Map() };
    applicationSources.set(load, sources);
  }
  const { files, diskTexts } = sources;
  const currentFile = path.resolve(filename);
  return files.some((entry) => entry.absolute !== currentFile && mentionsName(entry, name, identifierIndex, diskTexts));
}

function methodCalls(fn: MethodDeclaration, sourceFile: SourceFile, load: ProjectLoad): CallExpression[] {
  const runtimePrivate = ts.isPrivateIdentifier(fn.name);
  const modifiers = fn.modifiers ?? [];
  if (!runtimePrivate && !(ts.isIdentifier(fn.name) && modifiers.some((m) => m.kind === ts.SyntaxKind.PrivateKeyword)))
    return [];
  if (modifiers.some((m) => ![ts.SyntaxKind.PrivateKeyword, ts.SyntaxKind.AsyncKeyword].includes(m.kind))) return [];
  if (fn.parameters.some((p) => p.modifiers?.length) || fn.asteriskToken || nameUsed(fn, 'arguments')) return [];
  const nameText = ts.isIdentifier(fn.name) || ts.isPrivateIdentifier(fn.name) ? fn.name.text : undefined;
  if (nameText === undefined) return [];
  if (!runtimePrivate && usedOutsideFile(load, sourceFile.fileName, nameText, load.identifierIndex)) return [];
  const checker = originalProgram(sourceFile).getTypeChecker();
  const method = checker.getSymbolAtLocation(fn.name);
  if (!method || method.declarations?.length !== 1) return [];
  const calls: CallExpression[] = [];
  let indirect = false;
  walkNodes(runtimePrivate ? fn.parent : sourceFile, (node: Node) => {
    if (ts.isWithStatement(node) || (ts.isIdentifier(node) && node.text === 'eval')) indirect = true;
    if (!runtimePrivate && ts.isElementAccessExpression(node) && node.expression.kind === ts.SyntaxKind.ThisKeyword)
      indirect = true;
    const text = 'text' in node ? node.text : undefined;
    if (node === fn.name || text !== nameText) return;
    const access = node.parent;
    if (
      ts.isPropertyAccessExpression(access) &&
      access.name === node &&
      access.expression.kind === ts.SyntaxKind.ThisKeyword &&
      ts.isCallExpression(access.parent) &&
      access.parent.expression === access &&
      checker.getSymbolAtLocation(node) === method
    ) {
      calls.push(access.parent);
    } else indirect = true;
  });
  return indirect ? [] : calls;
}

function callsForHelper(
  fn: FunctionWithBody,
  sourceFile: SourceFile,
  load: ProjectLoad,
  javaScript: boolean,
): CallExpression[] {
  if (ts.isMethodDeclaration(fn) && ts.isClassDeclaration(fn.parent)) return methodCalls(fn, sourceFile, load);
  if (javaScript && !strictSource(sourceFile)) return [];
  if (ts.isArrowFunction(fn)) return arrowCalls(fn);
  if (javaScript && ts.isFunctionDeclaration(fn) && !nameUsed(fn, 'arguments')) return declarationCalls(fn, sourceFile);
  return [];
}

function documentedSignature(fn: FunctionWithBody): boolean {
  return (
    ts.getJSDocCommentsAndTags(fn).length > 0 ||
    fn.parameters.some((parameter: ParameterDeclaration) => ts.getJSDocCommentsAndTags(parameter).length > 0)
  );
}

interface GroupedBindingInput {
  readonly grouped: readonly IdentifierParameter[];
  readonly names: readonly string[];
  readonly original: string;
  readonly sourceFile: SourceFile;
  readonly start: number;
  readonly end: number;
  readonly javaScript: boolean;
  readonly checker: TypeChecker | undefined;
  readonly printWidth: number;
  readonly load: ProjectLoad;
}

// The destructuring pattern that replaces the grouped parameters, with its type literal in
// TypeScript.
function groupedBinding({
  grouped,
  names,
  original,
  sourceFile,
  start,
  end,
  javaScript,
  checker,
  printWidth,
  load,
}: GroupedBindingInput): string | undefined {
  let binding = '{ ' + names.join(', ') + ' }';
  if (!javaScript && checker) {
    const typeContext = { sourceFile, start, checker, exact: exactOptionalTypes(load) };
    const types = parameterTypes(grouped, { ...typeContext, multiline: original.includes('\n') });
    if (!types) return;
    binding += ': ' + types;
    // A one-line type literal of a long list overflows the line, so its members go one per line.
    if (!types.includes('\n') && lineLengthWith(sourceFile.text, start, end, binding) > printWidth) {
      const pattern = '{ ' + names.join(', ') + ' }';
      const wrappedNames = columnOf(sourceFile.text, start) + (pattern + ': {').length > printWidth;
      const namesText = wrappedNames
        ? multilineObject(names, newlineOf(sourceFile.text), indentationAt(sourceFile.text, start))
        : pattern;
      binding = namesText + ': ' + parameterTypes(grouped, { ...typeContext, multiline: true });
    }
  }
  return binding;
}

function groupingFix(fn: FunctionWithBody, edits: TextEdit[]): FixResult {
  if (ts.isMethodDeclaration(fn) && !ts.isPrivateIdentifier(fn.name))
    return {
      edits,
      requiresReview: true,
      note: 'Names the arguments at the known internal calls to this TypeScript-private method. Check runtime hooks, external callers and dynamically constructed method names before applying.',
    };
  return { edits, note: 'Names the grouped arguments of this local helper at every direct call site.' };
}

// Whether the function's own shape allows its parameters to become one destructured object.
function groupable(fn: FunctionWithBody, javaScript: boolean): boolean {
  if (fn.typeParameters || (fn.type && ts.isTypePredicateNode(fn.type))) return false;
  // A non-simple parameter list makes a function's own "use strict" directive illegal.
  if (hasStrictDirective(fn.body) || (javaScript && documentedSignature(fn))) return false;
  return javaScript || fn.parameters.every((parameter) => ts.isIdentifier(parameter.name));
}

const groupLocalParameters: SiteFixBuilder = ({ node, sourceFile, load }: ProjectSiteFixInput) => {
  if (!node || !sourceFile) return;
  const fn = flaggedFunction(node);
  if (!fn) return;
  const javaScript = /\.[cm]?jsx?$/i.test(sourceFile.fileName);
  if (!groupable(fn, javaScript)) return;
  const calls = callsForHelper(fn, sourceFile, load, javaScript);
  if (!calls.length) return;
  const checker = javaScript ? undefined : originalProgram(sourceFile).getTypeChecker();
  if (ts.isArrowFunction(fn) && checker && distinctlyTyped(fn, checker)) return;
  const grouped = javaScript ? suppliedJsParameters(fn, calls) : suppliedPrefix(fn, calls);
  if (grouped.length < 2) return;
  const names = grouped.map((p) =>
    p.initializer ? p.name.text + ' = ' + p.initializer.getText(sourceFile) : p.name.text,
  );
  const firstIndex = fn.parameters.indexOf(grouped[0]);
  const start = grouped[0].getStart(sourceFile);
  const end = grouped[grouped.length - 1].end;
  const original = sourceFile.text.slice(start, end);
  if (/\/\/|\/\*/.test(original)) return;
  const printWidth = printWidthOf(load);
  const binding = groupedBinding({
    grouped,
    names,
    original,
    sourceFile,
    start,
    end,
    javaScript,
    checker,
    printWidth,
    load,
  });
  if (binding === undefined) return;
  const edits: TextEdit[] = [{ start, end, text: binding }];
  for (const call of calls) {
    const edit = optionsArgument({
      call,
      parameters: grouped,
      sourceFile,
      firstIndex,
      javaScript,
      printWidth,
    });
    if (!edit) return;
    edits.push(edit);
  }
  return groupingFix(fn, edits);
};

// A function, constructor or conditional type needs parentheses before `| undefined`.
function optionalType(typeText: string, typeNode: TypeNode | undefined, exact: boolean): string {
  if (!exact) return typeText;
  const needsParentheses =
    typeNode &&
    (ts.isFunctionTypeNode(typeNode) || ts.isConstructorTypeNode(typeNode) || ts.isConditionalTypeNode(typeNode));
  return (needsParentheses ? '(' + typeText + ')' : typeText) + ' | undefined';
}

function memberType(parameter: ParameterDeclaration, sourceFile: SourceFile, checker: TypeChecker): string | undefined {
  if (parameter.type) return parameter.type.getText(sourceFile);
  const type = checker.getBaseTypeOfLiteralType(checker.getTypeAtLocation(parameter));
  // An unresolved import reads as `any`; writing that out would drop the type the default gave the
  // parameter.
  if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return;
  return checker.typeToString(type, parameter, ts.TypeFormatFlags.NoTruncation);
}

function parameterTypes(
  parameters: readonly IdentifierParameter[],
  { multiline, sourceFile, start, checker, exact }: ParameterTypeContext,
): string | undefined {
  const typeMembers: string[] = [];
  for (const p of parameters) {
    if (!omittable(p)) {
      typeMembers.push(p.getText(sourceFile));
      continue;
    }
    const typeText = memberType(p, sourceFile, checker);
    if (typeText === undefined) return;
    typeMembers.push(p.name.text + '?: ' + optionalType(typeText, p.type, exact));
  }
  const newline = newlineOf(sourceFile.text);
  const indentation = indentationAt(sourceFile.text, start);
  const inner = indentation + '  ';
  return multiline
    ? '{' + newline + inner + typeMembers.join(';' + newline + inner) + ';' + newline + indentation + '}'
    : '{ ' + typeMembers.join('; ') + ' }';
}

export default { 'long-parameter-list': groupLocalParameters };
