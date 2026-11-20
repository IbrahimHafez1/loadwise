'use strict';

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

function awaitedOperands(awaits) {
  return awaits.map((awaited) => textOf(skipParentheses(awaited.expression)));
}

const startedTogetherNote =
  'Promise.all starts the calls together; keep them serial if a later call reads what an earlier one writes.';

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

function arrayFix(literal) {
  const awaits = directAwaits(literal);
  if (awaits.length !== literal.elements.length || assertedConst(literal)) return;
  const all = `await Promise.all([${awaitedOperands(awaits).join(', ')}])`;
  const note = deliberatelySerialNote(literal) ?? startedTogetherNote;
  return { edits: [replaceNode(literal, needsNoParentheses(literal) ? all : `(${all})`)], note };
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

// The binding name for an awaited slot: the property key, else the called function, else a generic word.
function baseNameFor(slot, awaited, suffix) {
  if (slot.key && isIdentifierName(slot.key)) return slot.key + suffix;
  let callee = skipParentheses(awaited.expression);
  if (ts.isCallExpression(callee)) callee = callee.expression;
  const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : '';
  return (name || 'awaited') + 'Result';
}

function hoistFix(literal, sourceFile) {
  const slots = slotsOf(literal).map((slot) => ({ ...slot, awaited: slot.value ? leadingAwait(slot.value) : null }));
  if (slots.some((slot) => slot.awaited === undefined)) return;
  const awaiting = slots.filter((slot) => slot.awaited);
  const anchor = hoistAnchor(literal);
  if (awaiting.length < 2 || !anchor || (anchor.statement && !startsOwnLine(anchor.statement))) return;
  const used = new Set();
  for (const slot of awaiting) {
    const base = baseNameFor(slot, slot.awaited, skipParentheses(slot.value) === slot.awaited ? 'Value' : 'Result');
    let name = freshName(sourceFile, base);
    for (let suffix = 2; name && used.has(name); suffix++) name = freshName(sourceFile, base + suffix);
    if (!name) return;
    used.add(name);
    slot.name = name;
  }
  const line = `const [${awaiting.map((slot) => slot.name).join(', ')}] = await Promise.all([${awaitedOperands(awaiting.map((slot) => slot.awaited)).join(', ')}]);`;
  const replacements = awaiting.map((slot) => {
    let target = slot.awaited;
    while (ts.isParenthesizedExpression(target.parent)) target = target.parent;
    return replaceNode(target, slot.name);
  });
  const lastAwaitIndex = slots.lastIndexOf(awaiting.at(-1));
  const reordered = slots.slice(0, lastAwaitIndex).filter((slot) => !slot.awaited && slot.value && !isPure(slot.value));
  const note = reordered.length
    ? `Values computed in the literal (${reordered.map((slot) => slot.key ?? textOf(slot.value)).join(', ')}) now run after all the awaited calls, not between them; check none depends on a call that ran before it. ${startedTogetherNote}`
    : startedTogetherNote;
  return { edits: [...anchorEdits(anchor, line, literal), ...replacements], note };
}

function anchorEdits(anchor, line, literal) {
  if (anchor.statement) return [insertLinesBefore(anchor.statement, [line])];
  const { body } = anchor.arrow;
  const text = body.getSourceFile().text;
  const indentation = indentationAt(text, anchor.arrow.getStart());
  const inner = indentation + (indentation.includes('\t') ? '\t' : '  ');
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  return [
    { start: body.getStart(), end: literal.getStart(), text: `{${eol}${inner}${line}${eol}${inner}return ` },
    { start: literal.end, end: body.end, text: `;${eol}${indentation}}` },
  ];
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

function calledName(call) {
  const callee = skipParentheses(call.expression);
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
}

// True when the awaited call is named as a write, or is a fetch whose options may pick a writing method. Starting
// a write together with the other calls could let a later read miss it, or swap the order of two writes.
function looksLikeWrite(awaited) {
  const operand = skipParentheses(awaited.expression);
  if (ts.isNewExpression(operand)) return true;
  if (!ts.isCallExpression(operand)) return false;
  const name = calledName(operand);
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
  if (ts.isArrayLiteralExpression(found.literal)) return arrayFix(found.literal) ?? hoistFix(found.literal, sourceFile);
  return hoistFix(found.literal, sourceFile);
}

module.exports = { 'serial-awaits-in-literal': serialLiteralFix };
