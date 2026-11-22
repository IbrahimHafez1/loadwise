'use strict';

const { calleeName } = require('../call-syntax.cjs');
const { ts, textOf, replaceNode, insertLinesBefore, freshName, indentationAt } = require('./helpers.cjs');
const { isPure, hoistAnchor, startsOwnLine } = require('./hoisting.cjs');
const { literalAwaiting, directAwaits, skipParentheses } = require('../literal-awaits.cjs');

// Parents where `await Promise.all(...)` can replace an array literal without extra parentheses.
function needsNoParentheses(literal) {
  const parent = literal.parent;
  return (
    ts.isVariableDeclaration(parent) ||
    ts.isReturnStatement(parent) ||
    ts.isExpressionStatement(parent) ||
    ts.isPropertyAssignment(parent) ||
    ts.isArrayLiteralExpression(parent) ||
    ts.isParenthesizedExpression(parent) ||
    (ts.isCallExpression(parent) && parent.expression !== literal) ||
    (ts.isBinaryExpression(parent) && parent.right === literal)
  );
}

const startedTogetherNote =
  'Promise.all starts later calls even if the first one fails. Check shared connection or transaction state, side effects, and concurrency limits before applying.';

// A branch that is the serial twin of a sibling branch already using Promise.all is serial on purpose.
function deliberatelySerialNote(literal) {
  let branch = literal;
  while (ts.isParenthesizedExpression(branch.parent) || ts.isAsExpression(branch.parent)) branch = branch.parent;
  const conditional = branch.parent;
  if (!ts.isConditionalExpression(conditional) || conditional.condition === branch) return;
  const sibling = conditional.whenTrue === branch ? conditional.whenFalse : conditional.whenTrue;
  if (!textOf(sibling).includes('Promise.all')) return;
  return 'The other branch already uses Promise.all, so this one looks serial on purpose (for example one shared transaction connection); keep it if so.';
}

// `as const` only applies to literals, so `(await Promise.all(...)) as const` would not compile.
function assertedConst(literal) {
  let current = literal;
  while (ts.isParenthesizedExpression(current.parent)) current = current.parent;
  const { parent } = current;
  return (ts.isAsExpression(parent) || ts.isTypeAssertionExpression(parent)) && textOf(parent.type) === 'const';
}

const lineWidth = 100;

function lineBreakOf(text) {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

// The file's indentation step: a tab, else the smallest space indent of 2 or 4 (JSDoc ` *` lines aside).
function indentUnitOf(text, indentation) {
  if (indentation.includes('\t')) return '\t';
  let smallest;
  for (const match of text.matchAll(/^( +)(?=[^ *\r\n])/gm)) {
    if (smallest === undefined || match[1].length < smallest) smallest = match[1].length;
  }
  return ' '.repeat(smallest === 4 ? 4 : 2);
}

// Re-indenting a string or template that spans lines would change its value.
function hasMultilineString(node) {
  let found = false;
  (function visit(child) {
    if (found) return;
    if ((ts.isStringLiteralLike(child) || ts.isTemplateExpression(child)) && textOf(child).includes('\n')) found = true;
    else ts.forEachChild(child, visit);
  })(node);
  return found;
}

// The lines of `node`, with continuation lines made relative to the indentation of the line it starts on.
function relativeLines(node) {
  const base = indentationAt(node.getSourceFile().text, node.getStart());
  return textOf(node)
    .split(/\r?\n/)
    .map((line, index) => (index > 0 && line.startsWith(base) ? line.slice(base.length) : line));
}

// `head` + the operands + `tail`, on one line when it fits, else one operand per line one step deeper, with a
// trailing comma when the original literal had one. Lines after the first are relative to `indentation`, which the
// caller adds.
function promiseAllLines(head, operands, tail, { unit, indentation, forceBreak = false, trailingComma = false }) {
  const single = `${head}${operands.map(textOf).join(', ')}${tail}`;
  const fits = !single.includes('\n') && indentation.length + single.length <= lineWidth;
  if ((fits && !forceBreak) || operands.some(hasMultilineString)) return [single];
  const lines = [head];
  operands.forEach((operand, index) => {
    const operandLines = relativeLines(operand);
    if (trailingComma || index < operands.length - 1) operandLines[operandLines.length - 1] += ',';
    lines.push(...operandLines.map((line) => (line ? unit + line : line)));
  });
  lines.push(tail);
  return lines;
}

function arrayFix(literal) {
  const awaits = directAwaits(literal);
  if (awaits.length !== literal.elements.length || assertedConst(literal)) return;
  const text = literal.getSourceFile().text;
  const indentation = indentationAt(text, literal.getStart());
  const parenthesized = !needsNoParentheses(literal);
  const lines = promiseAllLines(
    `${parenthesized ? '(' : ''}await Promise.all([`,
    awaits.map((awaited) => skipParentheses(awaited.expression)),
    parenthesized ? ']))' : '])',
    {
      unit: indentUnitOf(text, indentation),
      indentation,
      forceBreak: textOf(literal).includes('\n'),
      trailingComma: literal.elements.hasTrailingComma,
    },
  );
  const note = deliberatelySerialNote(literal) ?? startedTogetherNote;
  return { edits: [replaceNode(literal, lines.join(lineBreakOf(text) + indentation))], note };
}

// Awaits that sit inside `node`, not counting nested functions (their awaits belong to another call).
function awaitsWithin(node, found = []) {
  if (ts.isAwaitExpression(node)) found.push(node);
  if (ts.isFunctionLike(node)) return found;
  ts.forEachChild(node, (child) => void awaitsWithin(child, found));
  return found;
}

// The await a slot value runs unconditionally: the value itself or the head of a member/call chain, such as
// `(await load()).items`. A value with any other await (an argument, a branch) is not hoistable.
function leadingAwait(value) {
  const awaits = awaitsWithin(value);
  if (awaits.length !== 1) return awaits.length === 0 ? null : undefined;
  let current = value;
  for (;;) {
    if (ts.isAwaitExpression(current)) return current;
    if (ts.isParenthesizedExpression(current) || ts.isNonNullExpression(current) || ts.isAsExpression(current)) {
      current = current.expression;
    } else if (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
      current = current.expression;
    } else if (ts.isCallExpression(current)) current = current.expression;
    else return undefined;
  }
}

function slotsOf(literal) {
  if (ts.isArrayLiteralExpression(literal)) {
    return literal.elements.map((element) => ({
      node: element,
      value: ts.isSpreadElement(element) ? element.expression : element,
      key: undefined,
    }));
  }
  return literal.properties.map((property) => {
    if (ts.isPropertyAssignment(property)) {
      const named = ts.isIdentifier(property.name) || ts.isStringLiteral(property.name);
      return { node: property, value: property.initializer, key: named ? property.name.text : undefined };
    }
    if (ts.isSpreadAssignment(property)) return { node: property, value: property.expression };
    return { node: property, value: undefined };
  });
}

function isIdentifierName(text) {
  return /^[A-Za-z_$][\w$]*$/.test(text);
}

// The binding name for an awaited slot whose key is taken: the key, else the called function, plus `Result`.
function baseNameFor(slot, awaited) {
  if (slot.key && isIdentifierName(slot.key)) return slot.key + 'Result';
  let callee = skipParentheses(awaited.expression);
  if (ts.isCallExpression(callee)) callee = callee.expression;
  const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : '';
  return (name || 'awaited') + 'Result';
}

// Names a `const` cannot take, or that the generated `await Promise.all` line itself reads.
const unbindableNames = new Set([
  'arguments',
  'eval',
  'await',
  'yield',
  'let',
  'static',
  'implements',
  'interface',
  'package',
  'private',
  'protected',
  'public',
  'undefined',
  'Promise',
]);

function isBindableName(name) {
  if (!isIdentifierName(name) || unbindableNames.has(name)) return false;
  const token = ts.stringToToken(name);
  return token === undefined || token < ts.SyntaxKind.FirstReservedWord || token > ts.SyntaxKind.LastReservedWord;
}

// Identifiers that name a property or a remote export rather than reading a variable.
function isPropertyNameOnly(identifier) {
  const { parent } = identifier;
  if (ts.isPropertyAccessExpression(parent)) return parent.name === identifier;
  if (ts.isQualifiedName(parent)) return parent.right === identifier;
  if (ts.isBindingElement(parent) || ts.isImportSpecifier(parent)) return parent.propertyName === identifier;
  return (
    (ts.isPropertyAssignment(parent) ||
      ts.isPropertySignature(parent) ||
      ts.isPropertyDeclaration(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isMethodSignature(parent) ||
      ts.isGetAccessor(parent) ||
      ts.isSetAccessor(parent)) &&
    parent.name === identifier
  );
}

// A new `const` inside `scope` can only clash with or shadow a variable that `scope` itself mentions.
function nameFreeIn(scope, name) {
  let free = true;
  (function visit(node) {
    if (!free) return;
    if (ts.isIdentifier(node) && node.text === name && !isPropertyNameOnly(node)) free = false;
    else ts.forEachChild(node, visit);
  })(scope);
  return free;
}

// Names each awaited slot after its property key when that name is free, so the literal can use shorthand
// (`{ seats }`); otherwise `<key>Result` or `<callee>Result`. Returns false when no free name is found.
function nameSlots(awaiting, scope, sourceFile) {
  const used = new Set();
  for (const slot of awaiting) {
    const direct = skipParentheses(slot.value) === slot.awaited;
    if (direct && slot.key && isBindableName(slot.key) && !used.has(slot.key) && nameFreeIn(scope, slot.key)) {
      slot.name = slot.key;
      slot.shorthand = true;
    } else {
      const base = baseNameFor(slot, slot.awaited);
      let name = freshName(sourceFile, base);
      for (let suffix = 2; name && used.has(name); suffix++) name = freshName(sourceFile, base + suffix);
      if (!name) return false;
      slot.name = name;
    }
    used.add(slot.name);
  }
  return true;
}

function slotReplacement(slot, text) {
  let target = slot.awaited;
  while (ts.isParenthesizedExpression(target.parent)) target = target.parent;
  // `key: await load()` becomes `key`; a comment between the key and the value keeps the long form.
  if (slot.shorthand && /^\s*:\s*$/.test(text.slice(slot.node.name.end, target.getStart())))
    return replaceNode(slot.node, slot.name);
  return replaceNode(target, slot.name);
}

function hoistFix(literal, sourceFile) {
  const slots = slotsOf(literal).map((slot) => ({ ...slot, awaited: slot.value ? leadingAwait(slot.value) : null }));
  if (slots.some((slot) => slot.awaited === undefined)) return;
  const awaiting = slots.filter((slot) => slot.awaited);
  const anchor = hoistAnchor(literal);
  if (awaiting.length < 2 || !anchor || (anchor.statement && !startsOwnLine(anchor.statement))) return;
  const scope = ts.findAncestor(anchor.statement ?? anchor.arrow.body, ts.isFunctionLike) ?? sourceFile;
  if (!nameSlots(awaiting, scope, sourceFile)) return;
  const { text } = sourceFile;
  const indentation = indentationAt(text, (anchor.statement ?? anchor.arrow).getStart());
  const unit = indentUnitOf(text, indentation);
  const lines = promiseAllLines(
    `const [${awaiting.map((slot) => slot.name).join(', ')}] = await Promise.all([`,
    awaiting.map((slot) => skipParentheses(slot.awaited.expression)),
    ']);',
    {
      unit,
      indentation: anchor.statement ? indentation : indentation + unit,
      trailingComma: (ts.isArrayLiteralExpression(literal) ? literal.elements : literal.properties).hasTrailingComma,
    },
  );
  const replacements = awaiting.map((slot) => slotReplacement(slot, text));
  const lastAwaitIndex = slots.lastIndexOf(awaiting.at(-1));
  const reordered = slots.slice(0, lastAwaitIndex).filter((slot) => !slot.awaited && slot.value && !isPure(slot.value));
  const note = reordered.length
    ? `Values computed in the literal (${reordered.map((slot) => slot.key ?? textOf(slot.value)).join(', ')}) now run after all the awaited calls, not between them; check none depends on a call that ran before it. ${startedTogetherNote}`
    : startedTogetherNote;
  if (anchor.statement) return { edits: [insertLinesBefore(anchor.statement, lines), ...replacements], note };
  return { edits: arrowBodyEdits(anchor.arrow, lines, literal, replacements, { indentation, unit }), note };
}

// Turns `async () => ({ ... })` into a block that hoists `lines` and returns the literal, one step deeper.
function arrowBodyEdits(arrow, lines, literal, replacements, { indentation, unit }) {
  const { body } = arrow;
  const text = body.getSourceFile().text;
  const inner = indentation + unit;
  const eol = lineBreakOf(text);
  // Only the parentheses around a bare literal are dropped; a wrapping call such as `wrap({ ... })` stays.
  const dropsParentheses = ts.isParenthesizedExpression(body) && body.expression === literal;
  const openEnd = dropsParentheses ? literal.getStart() : body.getStart();
  const closeStart = dropsParentheses ? literal.end : body.end;
  const hoisted = lines.join(eol + inner);
  return [
    { start: body.getStart(), end: openEnd, text: `{${eol}${inner}${hoisted}${eol}${inner}return ` },
    { start: closeStart, end: body.end, text: `;${eol}${indentation}}` },
    ...replacements,
    ...(hasMultilineString(body) ? [] : reindentEdits(text, openEnd, closeStart, unit, replacements)),
  ];
}

// Adds one indentation step to every non-blank line that starts inside [from, to). A line that starts where a
// replacement starts gets the step in that replacement; a line inside a replacement is rewritten anyway.
function reindentEdits(text, from, to, unit, replacements) {
  const edits = [];
  for (let index = text.indexOf('\n', from); index !== -1 && index + 1 < to; index = text.indexOf('\n', index + 1)) {
    const start = index + 1;
    if (/^[ \t]*\r?(?:\n|$)/.test(text.slice(start))) continue;
    const replaced = replacements.find((edit) => edit.start <= start && start < edit.end);
    if (replaced?.start === start) replaced.text = unit + replaced.text;
    else if (!replaced) edits.push({ start, end: start, text: unit });
  }
  return edits;
}

// Tests create fixtures in a fixed order on purpose (ids, timestamps, foreign keys), so their literals stay serial.
const testFile =
  /(?:^|[\\/])(?:__tests__|__mocks__|tests?|specs?|e2e|fixtures)[\\/]|[.-](?:test|spec|e2e|itest|e2e-spec|int-spec)\.[cm]?[jt]sx?$/i;
// A call writes when its name starts with one of these verbs (`create`, `addStore`, `$executeRaw`, Redis `hset`) or
// joins one with Or/And (`findOrCreate`). Nouns later in a name, such as `getPost`, do not count.
const writeVerbs = new Set([
  'create',
  'insert',
  'save',
  'update',
  'upsert',
  'delete',
  'del',
  'remove',
  'destroy',
  'set',
  'put',
  'post',
  'patch',
  'write',
  'send',
  'increment',
  'decrement',
  'incr',
  'decr',
  'push',
  'publish',
  'emit',
  'add',
  'lock',
  'reset',
  'clear',
  'mark',
  'persist',
  'execute',
  'exec',
  'run',
  'refresh',
  'sync',
  'upload',
  'enqueue',
  'claim',
  'seed',
  'hset',
  'hdel',
  'hincrby',
  'sadd',
  'srem',
  'zadd',
  'zrem',
  'lpush',
  'rpush',
  'expire',
  'setex',
  'mset',
  'unlink',
]);
const joiningWords = new Set(['or', 'and']);

// True when the awaited call is named as a write, or is a fetch whose options may pick a writing method. Starting
// a write together with the other calls could let a later read miss it, or swap the order of two writes.
function looksLikeWrite(awaited) {
  const operand = skipParentheses(awaited.expression);
  if (ts.isNewExpression(operand)) return true;
  if (!ts.isCallExpression(operand)) return false;
  const name = calleeName(operand, skipParentheses);
  if (!name) return false;
  if (name === 'fetch' && operand.arguments.length > 1) return true;
  const words = name
    .replace(/^\$/, '')
    .split(/(?=[A-Z])|_/)
    .map((word) => word.toLowerCase());
  return words.some((word, index) => writeVerbs.has(word) && (index === 0 || joiningWords.has(words[index - 1])));
}

function serialLiteralFix({ node, sourceFile }) {
  if (testFile.test(sourceFile.fileName)) return;
  let call = node;
  while (call && !(ts.isCallExpression(call) && literalAwaiting(call))) call = call.parent;
  const found = call && literalAwaiting(call);
  if (!found || awaitsWithin(found.literal).some(looksLikeWrite)) return;
  const fix =
    (ts.isArrayLiteralExpression(found.literal) && arrayFix(found.literal)) || hoistFix(found.literal, sourceFile);
  return fix && { ...fix, requiresReview: true };
}

module.exports = { 'serial-awaits-in-literal': serialLiteralFix };
