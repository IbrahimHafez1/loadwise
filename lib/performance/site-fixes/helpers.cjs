'use strict';

// Shared syntax helpers for site-fix builders. Builders return edits as { start, end, text } file offsets.
const { syntax: ts } = require('../compiler.cjs');
const { createReferenceChecks } = require('../reference-checks.cjs');
const { isPlainReference, mentionsIdentifier } = createReferenceChecks(ts);

function textOf(node) {
  return node.getText(node.getSourceFile());
}

function replaceNode(node, text) {
  return { start: node.getStart(node.getSourceFile()), end: node.end, text };
}

function ancestor(node, predicate) {
  for (let current = node; current; current = current.parent) if (predicate(current)) return current;
}

// The innermost call whose callee (`find`, `repo.find`) contains the reported position.
function calleeCall(node) {
  for (let call = ancestor(node, ts.isCallExpression); call; call = ancestor(call.parent, ts.isCallExpression)) {
    if (ancestor(node, (current) => current === call.expression)) return call;
  }
}

function enclosingStatement(node) {
  return ancestor(
    node,
    (current) => ts.isStatement(current) && (ts.isBlock(current.parent) || ts.isSourceFile(current.parent)),
  );
}

function lineStart(text, offset) {
  return text.lastIndexOf('\n', offset - 1) + 1;
}

function indentationAt(text, offset) {
  const start = lineStart(text, offset);
  return /^[ \t]*/.exec(text.slice(start))[0];
}

// Inserts whole lines before the line that holds `node`, matching that line's indentation.
function insertLinesBefore(node, lines) {
  const sourceFile = node.getSourceFile();
  const text = sourceFile.text;
  const start = lineStart(text, node.getStart(sourceFile));
  const indentation = indentationAt(text, start);
  return { start, end: start, text: lines.map((line) => indentation + line + '\n').join('') };
}

const loopKinds = new Set([
  ts.SyntaxKind.ForOfStatement,
  ts.SyntaxKind.ForInStatement,
  ts.SyntaxKind.ForStatement,
  ts.SyntaxKind.WhileStatement,
  ts.SyntaxKind.DoStatement,
]);
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

// The nearest loop statement or array-iteration callback around `node`, inside the same function.
function enclosingIteration(node) {
  for (let current = node.parent; current; current = current.parent) {
    if (loopKinds.has(current.kind)) return { kind: 'loop', node: current };
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

// True when `name` is declared anywhere in the file, so a new binding with that name could shadow or clash.
function nameTaken(sourceFile, name) {
  let taken = false;
  (function visit(node) {
    if (taken) return;
    if (ts.isIdentifier(node) && node.text === name) taken = true;
    else ts.forEachChild(node, visit);
  })(sourceFile);
  return taken;
}

function freshName(sourceFile, base) {
  if (!nameTaken(sourceFile, base)) return base;
  for (let suffix = 2; suffix < 100; suffix++) if (!nameTaken(sourceFile, base + suffix)) return base + suffix;
}

function spansLines(text, from, to) {
  return text.slice(from, to).includes('\n');
}

// Adds `property` to an object literal, on its own line when the literal is already multi-line.
function addProperty(literal, property, text) {
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
function addOptionsArgument(call, property, text) {
  const [last] = call.arguments.slice(-1);
  const trailingComma = call.arguments.hasTrailingComma;
  const commaEnd = trailingComma ? text.indexOf(',', last.end) + 1 : last.end;
  const options = `{ ${property} }`;
  if (spansLines(text, call.expression.end, last.getStart())) {
    const lineText = `\n${indentationAt(text, last.getStart())}${options}`;
    return { start: commaEnd, end: commaEnd, text: trailingComma ? `${lineText},` : `,${lineText}` };
  }
  return { start: commaEnd, end: commaEnd, text: trailingComma ? ` ${options},` : `, ${options}` };
}

function hasMultilineTemplate(sourceFile, start, end) {
  let found = false;
  (function visit(child) {
    if (found || child.end <= start || child.getStart(sourceFile) >= end) return;
    const isTemplate = ts.isTemplateExpression(child) || ts.isNoSubstitutionTemplateLiteral(child);
    if (isTemplate && textOf(child).includes('\n')) found = true;
    else ts.forEachChild(child, visit);
  })(sourceFile);
  return found;
}

// Every name a for-of binds per item: `item`, `[index, item]` or `{ id, name }`.
function bindingNames(name, names = new Set()) {
  if (ts.isIdentifier(name)) names.add(name.text);
  else for (const element of name.elements) if (!ts.isOmittedExpression(element)) bindingNames(element.name, names);
  return names;
}

module.exports = {
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
