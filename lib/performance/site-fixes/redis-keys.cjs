'use strict';

const {
  ts,
  textOf,
  replaceNode,
  calleeCall,
  enclosingStatement,
  freshName,
  indentationAt,
  insertLinesBefore,
  nameTaken,
  isPlainReference,
} = require('./helpers.cjs');
const { isPure, hoistAnchor, startsOwnLine } = require('./hoisting.cjs');

const SCAN_BATCH_SIZE = 100;
const scanNote =
  'SCAN reads the keyspace over multiple cursor steps. Check that callers tolerate duplicates, unspecified ordering and a changing keyspace. Deduplication alone cannot provide a point-in-time result.';
const reorderedNote =
  'The keys are now read before the synchronous calls that precede them in this statement; none of them should change what the pattern matches.';

// `const keys = await redis.keys(pattern)` as { declaration, call }; other shapes stay manual.
function awaitedKeysDeclaration(statement) {
  if (!statement || !ts.isVariableStatement(statement) || statement.declarationList.declarations.length !== 1) return;
  const [declaration] = statement.declarationList.declarations;
  const awaited = declaration.initializer;
  if (!ts.isIdentifier(declaration.name) || declaration.type || !awaited || !ts.isAwaitExpression(awaited)) return;
  const call = awaited.expression;
  if (!ts.isCallExpression(call) || !ts.isPropertyAccessExpression(call.expression)) return;
  if (call.expression.name.text.toLowerCase() !== 'keys' || call.arguments.length !== 1) return;
  if (!isPlainReference(call.expression.expression) || ts.isSpreadElement(call.arguments[0])) return;
  return { declaration, call };
}

// `client.keys(pattern)` with a plain receiver and one pattern as { client, pattern }.
function keysCallParts(call) {
  if (!ts.isCallExpression(call) || !ts.isPropertyAccessExpression(call.expression)) return;
  if (call.expression.name.text.toLowerCase() !== 'keys' || call.arguments.length !== 1) return;
  if (!isPlainReference(call.expression.expression) || ts.isSpreadElement(call.arguments[0])) return;
  return { client: textOf(call.expression.expression), pattern: call.arguments[0] };
}

// The statements that collect every key of `pattern` through the cursor loop, or nothing for an unknown client.
function collectLines({ message, sourceFile }, { client, pattern }, keys, keyword = 'const') {
  const typed = /\.[cm]?tsx?$/.test(sourceFile.fileName) ? ': string[]' : '';
  const declaration = `${keyword} ${keys}${typed} = [];`;
  if (message.includes('.scanStream(')) {
    const batch = freshName(sourceFile, 'batch');
    return [
      declaration,
      `for await (const ${batch} of ${client}.scanStream({ match: ${textOf(pattern)}, count: ${SCAN_BATCH_SIZE} })) ${keys}.push(...${batch});`,
    ];
  }
  if (message.includes('(yields one key per step)')) {
    const key = freshName(sourceFile, 'key');
    return [
      declaration,
      `for await (const ${key} of ${client}.scanIterator({ MATCH: ${textOf(pattern)}, COUNT: ${SCAN_BATCH_SIZE} })) ${keys}.push(${key});`,
    ];
  }
}

// Every `await client.keys(pattern)` in the statement outside nested functions.
function awaitedKeysIn(statement, client) {
  const found = [];
  (function visit(node) {
    if (ts.isFunctionLike(node)) return;
    if (ts.isAwaitExpression(node)) {
      const parts = keysCallParts(skipParens(node.expression));
      if (parts && (!client || parts.client === client)) found.push({ awaited: node, ...parts });
    }
    ts.forEachChild(node, visit);
  })(statement);
  return found;
}

function skipParens(node) {
  return ts.isParenthesizedExpression(node) ? skipParens(node.expression) : node;
}

// A call that runs synchronously (no await inside) with plain arguments, such as `codeKey(userId)`.
function isSynchronousCall(node, isFree) {
  if (!ts.isCallExpression(node) || !isPure(node.expression, isFree)) return false;
  return !hasAwait(node) && node.arguments.every((argument) => isPure(argument, isFree));
}

function hasAwait(node) {
  if (ts.isAwaitExpression(node)) return true;
  if (ts.isFunctionLike(node)) return false;
  return !!ts.forEachChild(node, (child) => hasAwait(child) || undefined);
}

// Collected arrays in one block share a scope, so each awaited keys call gets its position-based name.
function keysNames(sourceFile, block) {
  const names = new Map();
  let number = 1;
  for (const sibling of block.statements) {
    for (const entry of awaitedKeysIn(sibling)) {
      let name = 'matchedKeys' + (number > 1 ? number : '');
      number++;
      while (nameTaken(sourceFile, name)) name = 'matchedKeys' + number++;
      names.set(entry.awaited, name);
    }
  }
  return names;
}

// `await client.keys(pattern)` used inside a statement: collect the keys in the lines above it and use the array.
function hoistedKeysFix(context, awaitedNode, parts) {
  const { sourceFile } = context;
  const statement = enclosingStatement(awaitedNode);
  if (!statement || !startsOwnLine(statement) || (!ts.isBlock(statement.parent) && !ts.isSourceFile(statement.parent)))
    return;
  const group = awaitedKeysIn(statement, parts.client);
  const grouped = new Set(group.map((entry) => entry.awaited));
  const isFree = (node) => grouped.has(node) || isSynchronousCall(node, isFree);
  if (!group.some((entry) => entry.awaited === awaitedNode)) return;
  if (!group.every((entry) => isPure(entry.pattern) && hoistAnchor(entry.awaited, isFree)?.statement === statement))
    return;
  const names = keysNames(sourceFile, statement.parent);
  const lines = [];
  const edits = [];
  for (const entry of group) {
    const collected = collectLines(context, entry, names.get(entry.awaited));
    if (!collected) return;
    lines.push(...collected);
    let replaced = entry.awaited;
    while (ts.isParenthesizedExpression(replaced.parent)) replaced = replaced.parent;
    edits.push(replaceNode(replaced, names.get(entry.awaited)));
  }
  const reordered = group.some((entry) => callsBefore(statement, entry.awaited));
  const note = reordered ? `${reorderedNote} ${scanNote}` : scanNote;
  return { edits: [insertLinesBefore(statement, lines), ...edits], note };
}

function callsBefore(statement, awaited) {
  let found = false;
  (function visit(node) {
    if (found || ts.isFunctionLike(node)) return;
    if (ts.isCallExpression(node) && node.end <= awaited.getStart()) found = true;
    ts.forEachChild(node, visit);
  })(statement);
  return found;
}

// `patterns.map((pattern) => client.keys(pattern))`: the arrow collects the keys itself and returns the array.
function callbackKeysFix(context, call, parts) {
  const arrow = call.parent;
  if (!ts.isArrowFunction(arrow) || arrow.body !== call) return;
  const { sourceFile, text } = context;
  const keys = freshName(sourceFile, 'matchedKeys');
  const collected = keys && collectLines(context, parts, keys);
  if (!collected) return;
  const indentation = indentationAt(text, arrow.getStart());
  const inner = indentation + '  ';
  const lines = [...collected, `return ${keys};`].map((line) => inner + line);
  const body = `{\n${lines.join('\n')}\n${indentation}}`;
  const edits = [replaceNode(call, body)];
  if (!arrow.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)) {
    edits.push({ start: arrow.getStart(), end: arrow.getStart(), text: 'async ' });
  }
  return { edits };
}

function buildScan({ finding, node, sourceFile, text }) {
  const call = calleeCall(node);
  const context = { message: finding.message, sourceFile, text };
  const parts = keysCallParts(call);
  if (!parts) return;
  const statement = enclosingStatement(node);
  const found = awaitedKeysDeclaration(statement);
  if (!found) {
    const awaited = ts.isAwaitExpression(skipParensUp(call)) ? skipParensUp(call) : undefined;
    return awaited ? hoistedKeysFix(context, awaited, parts) : callbackKeysFix(context, call, parts);
  }
  if (found.call !== call) return;
  const { declaration } = found;
  const keys = declaration.name.text;
  const indentation = indentationAt(sourceFile.text, statement.getStart());
  const keyword = declaration.parent.flags & ts.NodeFlags.Const ? 'const' : 'let';
  const collected = collectLines(context, parts, keys, keyword);
  if (!collected) return;
  return {
    edits: [
      {
        start: statement.getStart(),
        end: statement.end,
        text: collected.join(`\n${indentation}`),
      },
    ],
  };
}

function skipParensUp(node) {
  let current = node;
  while (ts.isParenthesizedExpression(current.parent)) current = current.parent;
  return current.parent;
}

function redisKeysFix(context) {
  const rewrite = buildScan(context);
  if (rewrite) return { ...rewrite, requiresReview: true, note: rewrite.note ?? scanNote };
}

module.exports = { 'redis-keys-command': redisKeysFix };
