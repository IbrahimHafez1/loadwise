// Shared syntax helpers for site-fix builders. Builders return edits as { start, end, text } file
// offsets.
import { ts } from '../compiler.js';
import { createReferenceChecks } from '../reference-checks.js';
import type {
  BindingName,
  CallExpression,
  Node,
  ObjectLiteralExpression,
  SignatureDeclaration,
  SourceFile,
  Statement,
} from 'typescript';
import type { FixResult, TextEdit } from '../../shared/types.js';
let cachedRefChecksTs: typeof ts | undefined;
let cachedRefChecks: ReturnType<typeof createReferenceChecks> | undefined;

function refChecks() {
  if (cachedRefChecksTs !== ts || !cachedRefChecks) {
    cachedRefChecksTs = ts;
    cachedRefChecks = createReferenceChecks(ts);
  }
  return cachedRefChecks;
}

function isPlainReference(node: Node): boolean {
  return refChecks().isPlainReference(node);
}

function mentionsIdentifier(node: Node, name: string): boolean {
  return refChecks().mentionsIdentifier(node, name);
}

function textOf(node: Node): string {
  return node.getText(node.getSourceFile());
}

function replaceNode(node: Node, text: string): TextEdit {
  return { start: node.getStart(node.getSourceFile()), end: node.end, text };
}

function ancestor<Found extends Node>(
  node: Node,
  predicate: (candidate: Node) => candidate is Found,
): Found | undefined;
function ancestor(node: Node, predicate: (candidate: Node) => boolean): Node | undefined;
function ancestor(node: Node, predicate: (candidate: Node) => boolean): Node | undefined {
  for (let current: Node | undefined = node; current; current = current.parent) if (predicate(current)) return current;
}

// The innermost call whose callee (`find`, `repo.find`) contains the reported position.
function calleeCall(node: Node): CallExpression | undefined {
  for (let call = ancestor(node, ts.isCallExpression); call; call = ancestor(call.parent, ts.isCallExpression)) {
    if (ancestor(node, (current) => current === call.expression)) return call;
  }
}

function enclosingStatement(node: Node): Statement | undefined {
  return ancestor(
    node,
    (current): current is Statement =>
      ts.isStatement(current) && (ts.isBlock(current.parent) || ts.isSourceFile(current.parent)),
  );
}

function lineStart(text: string, offset: number): number {
  return offset <= 0 ? 0 : text.lastIndexOf('\n', offset - 1) + 1;
}

function indentationAt(text: string, offset: number): string {
  const start = lineStart(text, offset);
  let end = start;
  while (end < text.length && (text[end] === ' ' || text[end] === '\t')) end++;
  return text.slice(start, end);
}

// Inserts whole lines before the line that holds `node`, matching that line's indentation.
function insertLinesBefore(node: Node, lines: readonly string[]): TextEdit {
  const sourceFile = node.getSourceFile();
  const text = sourceFile.text;
  const start = lineStart(text, node.getStart(sourceFile));
  const indentation = indentationAt(text, start);
  return { start, end: start, text: lines.map((line) => indentation + line + '\n').join('') };
}

function isLoopKind(kind: number): boolean {
  return (
    kind === ts.SyntaxKind.ForOfStatement ||
    kind === ts.SyntaxKind.ForInStatement ||
    kind === ts.SyntaxKind.ForStatement ||
    kind === ts.SyntaxKind.WhileStatement ||
    kind === ts.SyntaxKind.DoStatement
  );
}
const iteratingMethods = new Set([
  'map',
  'forEach',
  'filter',
  'some',
  'every',
  'find',
  'findIndex',
  'flatMap',
  'reduce',
]);

interface LoopIteration {
  kind: 'loop';
  node: Node;
}

interface CallbackIteration {
  kind: 'callback';
  node: CallExpression;
  callback: SignatureDeclaration;
  method: string;
}

type Iteration = LoopIteration | CallbackIteration;

// The nearest loop statement or array-iteration callback around `node`, inside the same function.
function enclosingIteration(node: Node): Iteration | undefined {
  for (let current = node.parent; current; current = current.parent) {
    if (isLoopKind(current.kind)) return { kind: 'loop', node: current };
    if (ts.isFunctionLike(current)) {
      const call = current.parent;
      if (
        call &&
        ts.isCallExpression(call) &&
        call.arguments[0] === current &&
        ts.isPropertyAccessExpression(call.expression) &&
        iteratingMethods.has(call.expression.name.text)
      ) {
        return { kind: 'callback', node: call, callback: current, method: call.expression.name.text };
      }
      return;
    }
  }
}

const identifiersByFile = new WeakMap<SourceFile, Set<string>>();

function identifiersIn(sourceFile: SourceFile): Set<string> {
  let names = identifiersByFile.get(sourceFile);
  if (names) return names;
  names = new Set<string>();
  const collect = (node: Node): void => {
    if (ts.isIdentifier(node)) names.add(node.text);
    ts.forEachChild(node, collect);
  };
  collect(sourceFile);
  identifiersByFile.set(sourceFile, names);
  return names;
}

// True when `name` is declared anywhere in the file, so a new binding with that name could shadow
// or clash.
function nameTaken(sourceFile: SourceFile, name: string): boolean {
  return identifiersIn(sourceFile).has(name);
}

function freshName(sourceFile: SourceFile, base: string): string | undefined {
  if (!nameTaken(sourceFile, base)) return base;
  for (let suffix = 2; suffix < 100; suffix++) if (!nameTaken(sourceFile, base + suffix)) return base + suffix;
}

function spansLines(text: string, from: number, to: number): boolean {
  return text.slice(from, to).includes('\n');
}

// Adds `property` to an object literal, on its own line when the literal is already multi-line.
function addProperty(literal: ObjectLiteralExpression, property: string, text: string): TextEdit {
  const [last] = literal.properties.slice(-1);
  if (!last) return { start: literal.getStart(), end: literal.end, text: `{ ${property} }` };
  const trailingComma = literal.properties.hasTrailingComma;
  const multiline = spansLines(text, literal.getStart(), last.getStart());
  const commaEnd = trailingComma ? text.indexOf(',', last.end) + 1 : last.end;
  if (multiline) {
    const indentation = indentationAt(text, last.getStart());
    const lineText = `\n${indentation}${property}`;
    return { start: commaEnd, end: commaEnd, text: trailingComma ? `${lineText},` : `,${lineText}` };
  }
  return { start: commaEnd, end: commaEnd, text: trailingComma ? ` ${property},` : `, ${property}` };
}

// Appends `{ property }` as a new last argument.
function addOptionsArgument(call: CallExpression, property: string, text: string): TextEdit {
  const options = `{ ${property} }`;
  const [last] = call.arguments.slice(-1);
  if (!last) {
    const open = text.indexOf('(', call.expression.end);
    const insertAt = open === -1 ? call.end - 1 : open + 1;
    return { start: insertAt, end: insertAt, text: options };
  }
  const trailingComma = call.arguments.hasTrailingComma;
  const commaEnd = trailingComma ? text.indexOf(',', last.end) + 1 : last.end;
  if (spansLines(text, call.expression.end, last.getStart())) {
    const lineText = `\n${indentationAt(text, last.getStart())}${options}`;
    return { start: commaEnd, end: commaEnd, text: trailingComma ? `${lineText},` : `,${lineText}` };
  }
  return { start: commaEnd, end: commaEnd, text: trailingComma ? ` ${options},` : `, ${options}` };
}

function hasMultilineTemplate(sourceFile: SourceFile, start: number, end: number): boolean {
  let found = false;
  (function visit(child: Node): void {
    if (found || child.end <= start || child.getStart(sourceFile) >= end) return;
    const isTemplate = ts.isTemplateExpression(child) || ts.isNoSubstitutionTemplateLiteral(child);
    if (isTemplate && textOf(child).includes('\n')) found = true;
    else ts.forEachChild(child, visit);
  })(sourceFile);
  return found;
}

// Every name a for-of binds per item: `item`, `[index, item]` or `{ id, name }`.
function bindingNames(name: BindingName, names = new Set<string>()): Set<string> {
  if (ts.isIdentifier(name)) names.add(name.text);
  else for (const element of name.elements) if (!ts.isOmittedExpression(element)) bindingNames(element.name, names);
  return names;
}

// Wraps a builder so the fixes it returns wait for individual review: `loadwise fix --yes` and
// `--fix --yes` skip them. `reason` leads the note. `appliesTo(fix)` limits the review to the
// variants that change behaviour.
function requireReview<Args extends unknown[]>(
  reason: string,
  builder: (...args: Args) => FixResult | undefined,
  appliesTo: (fix: FixResult) => boolean = () => true,
): (...args: Args) => FixResult | undefined {
  return (...args) => {
    const fix = builder(...args);
    if (!fix || !appliesTo(fix)) return fix;
    return { ...fix, requiresReview: true, note: fix.note ? `${reason} ${fix.note}` : reason };
  };
}

// True when `text` between the offsets holds a comment, which a whole-loop rewrite would silently
// drop.
function hasCommentBetween(text: string, from: number, to: number): boolean {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, text.slice(from, to));
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan())
    if (token === ts.SyntaxKind.SingleLineCommentTrivia || token === ts.SyntaxKind.MultiLineCommentTrivia) return true;
  return false;
}

export {
  requireReview,
  hasCommentBetween,
  bindingNames,
  hasMultilineTemplate,
  addProperty,
  addOptionsArgument,
  ts,
  textOf,
  replaceNode,
  ancestor,
  calleeCall,
  enclosingStatement,
  enclosingIteration,
  indentationAt,
  insertLinesBefore,
  lineStart,
  freshName,
  nameTaken,
  isPlainReference,
  mentionsIdentifier,
};
