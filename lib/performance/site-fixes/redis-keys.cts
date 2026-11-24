import {
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
} from './helpers.cjs';
import { isPure, hoistAnchor, startsOwnLine } from './hoisting.cjs';
import type {
  AwaitExpression,
  Block,
  CallExpression,
  Expression,
  Node,
  SourceFile,
  Statement,
  VariableDeclaration,
  VariableStatement,
} from 'typescript';
import type { FixResult, SiteFixInput, TextEdit } from '../../shared/types.cjs';

/** What the scan rewrite reads from the finding and the file. */
interface ScanContext {
  message: string;
  sourceFile: SourceFile;
  text: string;
}

/** `client.keys(pattern)` taken apart. */
interface KeysCallParts {
  client: string;
  pattern: Expression;
}

/** An `await client.keys(pattern)` inside a statement. */
interface AwaitedKeys extends KeysCallParts {
  awaited: AwaitExpression;
}

/** `const keys = await client.keys(pattern)`. */
interface AwaitedKeysDeclaration {
  statement: VariableStatement;
  declaration: VariableDeclaration;
  name: string;
  call: CallExpression;
}

/** Tells whether a node may be evaluated earlier than it is now, because it is hoisted too. */
type FreeCheck = (node: Node) => boolean;

const SCAN_BATCH_SIZE = 100;
const scanNote =
  'SCAN reads the keyspace over multiple cursor steps. Check that callers tolerate duplicates, unspecified ordering and a changing keyspace. Deduplication alone cannot provide a point-in-time result.';
const reorderedNote =
  'The keys are now read before the synchronous calls that precede them in this statement; none of them should change what the pattern matches.';

// `const keys = await redis.keys(pattern)` as { declaration, call }; other shapes stay manual.
function awaitedKeysDeclaration(statement: Statement): AwaitedKeysDeclaration | undefined {
  if (!ts.isVariableStatement(statement) || statement.declarationList.declarations.length !== 1) return;
  const [declaration] = statement.declarationList.declarations;
  const awaited = declaration.initializer;
  if (!ts.isIdentifier(declaration.name) || declaration.type || !awaited || !ts.isAwaitExpression(awaited)) return;
  const call = awaited.expression;
  if (!ts.isCallExpression(call) || !ts.isPropertyAccessExpression(call.expression)) return;
  if (call.expression.name.text.toLowerCase() !== 'keys' || call.arguments.length !== 1) return;
  if (!isPlainReference(call.expression.expression) || ts.isSpreadElement(call.arguments[0])) return;
  return { statement, declaration, name: declaration.name.text, call };
}

// `client.keys(pattern)` with a plain receiver and one pattern as { client, pattern }.
function keysCallParts(call: Node): KeysCallParts | undefined {
  if (!ts.isCallExpression(call) || !ts.isPropertyAccessExpression(call.expression)) return;
  if (call.expression.name.text.toLowerCase() !== 'keys' || call.arguments.length !== 1) return;
  if (!isPlainReference(call.expression.expression) || ts.isSpreadElement(call.arguments[0])) return;
  return { client: textOf(call.expression.expression), pattern: call.arguments[0] };
}

// The statements that collect every key of `pattern` through the cursor loop, or nothing for an
// unknown client.
function collectLines(
  { message, sourceFile }: ScanContext,
  { client, pattern }: KeysCallParts,
  keys: string,
  keyword = 'const',
): string[] | undefined {
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
function awaitedKeysIn(statement: Statement, client?: string): AwaitedKeys[] {
  const found: AwaitedKeys[] = [];
  (function visit(node: Node): void {
    if (ts.isFunctionLike(node)) return;
    if (ts.isAwaitExpression(node)) {
      const parts = keysCallParts(skipParens(node.expression));
      if (parts && (!client || parts.client === client)) found.push({ awaited: node, ...parts });
    }
    ts.forEachChild(node, visit);
  })(statement);
  return found;
}

function skipParens(node: Node): Node {
  return ts.isParenthesizedExpression(node) ? skipParens(node.expression) : node;
}

// A call that runs synchronously (no await inside) with plain arguments, such as `codeKey(userId)`.
function isSynchronousCall(node: Node, isFree: FreeCheck): boolean {
  if (!ts.isCallExpression(node) || !isPure(node.expression, isFree)) return false;
  return !hasAwait(node) && node.arguments.every((argument: Expression) => isPure(argument, isFree));
}

function hasAwait(node: Node): boolean {
  if (ts.isAwaitExpression(node)) return true;
  if (ts.isFunctionLike(node)) return false;
  return !!ts.forEachChild(node, (child) => hasAwait(child) || undefined);
}

// Collected arrays in one block share a scope, so each awaited keys call gets its position-based
// name.
function keysNames(sourceFile: SourceFile, block: Block | SourceFile): Map<AwaitExpression, string> {
  const names = new Map<AwaitExpression, string>();
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

// `await client.keys(pattern)` used inside a statement: collect the keys in the lines above it and
// use the array.
function hoistedKeysFix(
  context: ScanContext,
  awaitedNode: AwaitExpression,
  parts: KeysCallParts,
): FixResult | undefined {
  const { sourceFile } = context;
  const statement = enclosingStatement(awaitedNode);
  if (!statement || !startsOwnLine(statement) || (!ts.isBlock(statement.parent) && !ts.isSourceFile(statement.parent)))
    return;
  const group = awaitedKeysIn(statement, parts.client);
  const grouped = new Set<Node>(group.map((entry) => entry.awaited));
  const isFree: FreeCheck = (node) => grouped.has(node) || isSynchronousCall(node, isFree);
  if (!group.some((entry) => entry.awaited === awaitedNode)) return;
  if (!group.every((entry) => isPure(entry.pattern) && hoistAnchor(entry.awaited, isFree)?.statement === statement))
    return;
  const names = keysNames(sourceFile, statement.parent);
  const lines: string[] = [];
  const edits: TextEdit[] = [];
  for (const entry of group) {
    const name = names.get(entry.awaited);
    if (name === undefined) return;
    const collected = collectLines(context, entry, name);
    if (!collected) return;
    lines.push(...collected);
    let replaced: Node = entry.awaited;
    while (ts.isParenthesizedExpression(replaced.parent)) replaced = replaced.parent;
    edits.push(replaceNode(replaced, name));
  }
  const reordered = group.some((entry) => callsBefore(statement, entry.awaited));
  const note = reordered ? `${reorderedNote} ${scanNote}` : scanNote;
  return { edits: [insertLinesBefore(statement, lines), ...edits], note };
}

function callsBefore(statement: Statement, awaited: Node): boolean {
  let found = false;
  (function visit(node: Node): void {
    if (found || ts.isFunctionLike(node)) return;
    if (ts.isCallExpression(node) && node.end <= awaited.getStart()) found = true;
    ts.forEachChild(node, visit);
  })(statement);
  return found;
}

// `patterns.map((pattern) => client.keys(pattern))`: the arrow collects the keys itself and returns
// the array.
function callbackKeysFix(context: ScanContext, call: CallExpression, parts: KeysCallParts): FixResult | undefined {
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
  const edits: TextEdit[] = [replaceNode(call, body)];
  if (!arrow.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)) {
    edits.push({ start: arrow.getStart(), end: arrow.getStart(), text: 'async ' });
  }
  return { edits };
}

function buildScan({ finding, node, sourceFile, text }: SiteFixInput): FixResult | undefined {
  if (!node || !sourceFile || text === undefined) return;
  const call = calleeCall(node);
  if (!call) return;
  const context: ScanContext = { message: finding.message, sourceFile, text };
  const parts = keysCallParts(call);
  if (!parts) return;
  const statement = enclosingStatement(node);
  const found = statement && awaitedKeysDeclaration(statement);
  if (!found) {
    const awaitedCandidate = skipParensUp(call);
    const awaited = ts.isAwaitExpression(awaitedCandidate) ? awaitedCandidate : undefined;
    return awaited ? hoistedKeysFix(context, awaited, parts) : callbackKeysFix(context, call, parts);
  }
  if (found.call !== call) return;
  const { declaration, name: keys } = found;
  const indentation = indentationAt(sourceFile.text, found.statement.getStart());
  const keyword = declaration.parent.flags & ts.NodeFlags.Const ? 'const' : 'let';
  const collected = collectLines(context, parts, keys, keyword);
  if (!collected) return;
  return {
    edits: [
      {
        // Starting at the list keeps a leading `export` or `declare` on the declaration.
        start: found.statement.declarationList.getStart(),
        end: found.statement.end,
        text: collected.join(`\n${indentation}`),
      },
    ],
  };
}

function skipParensUp(node: Node): Node {
  let current: Node = node;
  while (ts.isParenthesizedExpression(current.parent)) current = current.parent;
  return current.parent;
}

function redisKeysFix(context: SiteFixInput): FixResult | undefined {
  const rewrite = buildScan(context);
  if (rewrite) return { ...rewrite, requiresReview: true, note: rewrite.note ?? scanNote };
}

export default { 'redis-keys-command': redisKeysFix };
