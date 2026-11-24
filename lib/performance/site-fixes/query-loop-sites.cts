// Finds the for-of loops the per-item query rewrites can batch: the loop site, the item key its
// read filters by, and what the rest of the loop does to the rows it reads.
import { bindingNames, ts, textOf, enclosingIteration, isPlainReference } from './helpers.cjs';
import type {
  AwaitExpression,
  CallExpression,
  Expression,
  ForOfStatement,
  Identifier,
  Node,
  ObjectLiteralElementLike,
  Statement,
  SyntaxKind,
} from 'typescript';
import {
  someNode,
  outerParentheses,
  startsLine,
  textWith,
  localNames,
  receiverRoot,
  readsOnlyNames,
  plainProperties,
  propertyValue,
} from './query-loop-nodes.cjs';
import { identifierPattern } from './query-loop-names.cjs';
import { mapItems, collectionKind, fixedList } from './query-loop-collections.cjs';
import type { ForOfLoopBinding, LoopItemKey, LoopItemSource, LoopLookupSite } from '../types/loop-lookup.cjs';
import type { MethodCall } from '../types/method-call.cjs';
import type { LoopKeySite } from '../types/loop-key-site.cjs';
import type { TextEdit } from '../../shared/types.cjs';

/** A for-of over a plain reference, with its single loop variable. */
interface LoopVariableSite {
  loop: ForOfStatement;
  loopVariable: string;
  locals: Set<string>;
}

/** A loop variable site together with the statement and awaited call it issues. */
interface LoopCallSite extends LoopVariableSite {
  statement: Statement;
  awaited: AwaitExpression;
}

/** The filter property that depends on the item, with the whole filter it came from. */
interface ItemKeyFilter extends LoopItemKey {
  property: ObjectLiteralElementLike;
  properties: ReadonlyMap<string, ObjectLiteralElementLike>;
}

const exitKinds = new Set([
  ts.SyntaxKind.ContinueStatement,
  ts.SyntaxKind.BreakStatement,
  ts.SyntaxKind.ReturnStatement,
  ts.SyntaxKind.ThrowStatement,
]);

// The awaited value may only flow straight into a declaration, assignment, argument or property
// read.
function plainPath(awaited: Node, statement: Statement): boolean {
  for (let child: Node = awaited; child !== statement; child = child.parent) {
    const parent = child.parent;
    const allowed =
      ts.isParenthesizedExpression(parent) ||
      ts.isVariableDeclaration(parent) ||
      ts.isVariableDeclarationList(parent) ||
      ts.isVariableStatement(parent) ||
      ts.isExpressionStatement(parent) ||
      (ts.isPropertyAccessExpression(parent) && parent.expression === child) ||
      (ts.isBinaryExpression(parent) &&
        parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        parent.right === child) ||
      (ts.isCallExpression(parent) && parent.arguments.some((argument) => argument === child));
    if (!allowed) return false;
  }
  return true;
}

function forOfLoop(loop: Node): LoopVariableSite | undefined {
  if (!ts.isForOfStatement(loop) || loop.awaitModifier || !isPlainReference(loop.expression)) return;
  if (!(ts.isBlock(loop.parent) || ts.isSourceFile(loop.parent)) || !startsLine(loop)) return;
  const list = loop.initializer;
  if (!ts.isVariableDeclarationList(list) || list.declarations.length !== 1) return;
  const name = list.declarations[0].name;
  if (!ts.isIdentifier(name)) return;
  const locals = localNames(loop.statement);
  if (
    locals.has(name.text) ||
    someNode(loop.expression, (node: Node) => ts.isIdentifier(node) && locals.has(node.text))
  )
    return;
  return { loop, loopVariable: name.text, locals };
}

// A for-of whose only round trip is `call`, issued unconditionally from a top-level statement of
// the body.
export function loopSite(call: MethodCall): LoopCallSite | undefined {
  const awaited = call.parent;
  const iteration = enclosingIteration(call);
  if (!ts.isAwaitExpression(awaited) || iteration?.kind !== 'loop') return;
  const site = forOfLoop(iteration.node);
  if (!site) return;
  const body = site.loop.statement;
  if (!ts.isBlock(body)) return;
  const statement = body.statements.find((candidate) => candidate.pos <= call.pos && call.end <= candidate.end);
  if (!statement || !plainPath(awaited, statement)) return;
  const earlier = body.statements.slice(0, body.statements.indexOf(statement));
  if (earlier.some((previous) => someNode(previous, (node: Node) => exitKinds.has(node.kind)))) return;
  // The batched read runs before every iteration, so no other awaited work may change what it would
  // read.
  const otherWork = someNode(
    body,
    (node: Node) =>
      (ts.isAwaitExpression(node) && node !== awaited) ||
      ts.isYieldExpression(node) ||
      (ts.isForOfStatement(node) && !!node.awaitModifier),
  );
  const root = receiverRoot(call.expression.expression);
  const sameClient = someNode(
    body,
    (node: Node) =>
      ts.isCallExpression(node) &&
      node !== call &&
      ts.isPropertyAccessExpression(node.expression) &&
      receiverRoot(node.expression.expression) === root,
  );
  if (otherWork || !root || sameClient) return;
  return { ...site, statement, awaited };
}

const freshIteratorMethods = new Set(['entries', 'values', 'keys']);

// The loop's collection in a form that can be iterated again before the loop without draining it.
function itemSource(expression: Expression): LoopItemSource | undefined {
  const value = ts.skipParentheses(expression);
  if (isPlainReference(value)) {
    const kind = collectionKind(value);
    return kind && { text: textOf(value), kind, fixed: fixedList(value) };
  }
  if (
    ts.isCallExpression(value) &&
    ts.isPropertyAccessExpression(value.expression) &&
    !value.arguments.length &&
    freshIteratorMethods.has(value.expression.name.text) &&
    isPlainReference(value.expression.expression)
  ) {
    // Each call returns a fresh iterator, so the loop's own iterator is untouched whatever the
    // owner is.
    const owner = value.expression.expression;
    const ownerKind = collectionKind(owner);
    const method = value.expression.name.text;
    return { text: textOf(value), kind: 'iterable', method, owner: textOf(owner), ownerKind, fixed: fixedList(owner) };
  }
  const fallback =
    ts.isBinaryExpression(value) &&
    (value.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
      value.operatorToken.kind === ts.SyntaxKind.BarBarToken) &&
    isPlainReference(value.left) &&
    ts.isArrayLiteralExpression(value.right) &&
    !value.right.elements.length;
  if (fallback) return { text: textOf(value), kind: 'iterable', fixed: false };
}

// A for-of whose items can be listed again before it: its binding, collection and the names its
// body writes.
export function forOfBinding(loop: Node): ForOfLoopBinding | undefined {
  if (!ts.isForOfStatement(loop) || loop.awaitModifier) return;
  if (!(ts.isBlock(loop.parent) || ts.isSourceFile(loop.parent)) || !startsLine(loop)) return;
  const list = loop.initializer;
  if (!ts.isVariableDeclarationList(list) || list.declarations.length !== 1) return;
  const pattern = list.declarations[0].name;
  const names = bindingNames(pattern);
  const source = itemSource(loop.expression);
  const locals = localNames(loop.statement);
  if (!source || [...names].some((name) => locals.has(name))) return;
  if (someNode(loop.expression, (node: Node) => ts.isIdentifier(node) && locals.has(node.text))) return;
  return { loop, pattern, names, source, locals };
}

// Whether reaching `awaited` from the top of its statement depends on a branch.
function conditionalPath(awaited: Node, statement: Statement): boolean {
  for (let child: Node = awaited; child !== statement; child = child.parent) {
    const parent = child.parent;
    if (ts.isIfStatement(parent) && parent.expression !== child) return true;
    if (ts.isConditionalExpression(parent) && parent.condition !== child) return true;
    if (ts.isCaseClause(parent) || ts.isDefaultClause(parent)) return true;
    const shortCircuit: readonly SyntaxKind[] = [
      ts.SyntaxKind.AmpersandAmpersandToken,
      ts.SyntaxKind.BarBarToken,
      ts.SyntaxKind.QuestionQuestionToken,
    ];
    if (ts.isBinaryExpression(parent) && parent.right === child && shortCircuit.includes(parent.operatorToken.kind))
      return true;
  }
  return false;
}

// A read awaited once per item of a for-of. Other statements may surround it; the builder reports
// what to check.
export function loopLookup(call: CallExpression): LoopLookupSite | undefined {
  const awaited = outerParentheses(call).parent;
  const iteration = enclosingIteration(call);
  if (!ts.isAwaitExpression(awaited) || iteration?.kind !== 'loop') return;
  const binding = forOfBinding(iteration.node);
  if (!binding) return;
  const body = binding.loop.statement;
  if (!ts.isBlock(body)) return;
  const statement = body.statements.find((candidate) => candidate.pos <= call.pos && call.end <= candidate.end);
  if (!statement) return;
  // A per-item try would now have to catch the batched read too.
  for (let current = awaited.parent; current !== body; current = current.parent)
    if (ts.isTryStatement(current) || ts.isCatchClause(current)) return;
  const index = body.statements.indexOf(statement);
  const guarded =
    body.statements.slice(0, index).some((previous) => someNode(previous, (node: Node) => exitKinds.has(node.kind))) ||
    conditionalPath(awaited, statement);
  const otherAwaits: AwaitExpression[] = [];
  const blocked = someNode(body, (node: Node) => {
    if (ts.isYieldExpression(node) || (ts.isForOfStatement(node) && node.awaitModifier)) return true;
    if (ts.isAwaitExpression(node) && node !== awaited) otherAwaits.push(node);
    return false;
  });
  if (blocked) return;
  const start = awaited.getStart();
  return {
    ...binding,
    statement,
    awaited,
    guarded,
    earlierAwaits: otherAwaits.filter((node) => node.end <= start),
    laterAwaits: otherAwaits.filter((node) => node.end > start),
  };
}

// A `const` declared earlier in the loop body from the item alone, so the key can be computed per
// item up front.
export function inlinedLocal(identifier: Identifier, site: LoopKeySite): Expression | undefined {
  const body = site.loop?.statement;
  if (!site.statement || !body || !ts.isBlock(body)) return;
  const index = body.statements.indexOf(site.statement);
  for (const statement of body.statements.slice(0, index)) {
    if (!ts.isVariableStatement(statement) || !(statement.declarationList.flags & ts.NodeFlags.Const)) continue;
    const declaration = statement.declarationList.declarations.find(
      (candidate) => ts.isIdentifier(candidate.name) && candidate.name.text === identifier.text,
    );
    if (!declaration?.initializer) continue;
    const locals = new Set([...site.locals].filter((name) => name !== identifier.text));
    if (readsOnlyNames(declaration.initializer, site.names, locals)?.usesLoopVariable) return declaration.initializer;
  }
}

const findOperator = /^[A-Z]\w*$/;

// The one filter property that depends on the item; the others must be the same on every iteration.
export function itemKeyFilter(filter: Expression | undefined, site: LoopKeySite): ItemKeyFilter | undefined {
  const properties = plainProperties(filter);
  if (!properties?.size) return;
  let key: Omit<ItemKeyFilter, 'properties'> | undefined;
  for (const [field, property] of properties) {
    const value = propertyValue(property);
    if (textOf(property).includes('\n')) return;
    const reads = readsOnlyNames(value, site.names, site.locals);
    const local = !reads && ts.isIdentifier(value) && inlinedLocal(value, site);
    if (reads && !reads.usesLoopVariable) continue;
    if ((!reads && !local) || key || !identifierPattern.test(field)) return;
    const operator =
      ts.isCallExpression(value) && ts.isIdentifier(value.expression) && findOperator.test(value.expression.text);
    if (ts.isObjectLiteralExpression(value) || ts.isArrayLiteralExpression(value) || operator) return;
    key = { field, property, value, perItem: local || value };
  }
  return key && { ...key, properties };
}

// The key as computed for every item; under a guard it must not throw for the items the guard
// skipped.
export function itemKeys(site: LoopLookupSite, key: Pick<LoopItemKey, 'perItem'>): string | undefined {
  let perItem = textOf(key.perItem);
  if (site.guarded) {
    const unsafe = someNode(
      key.perItem,
      (node: Node) =>
        ts.isCallExpression(node) ||
        ts.isElementAccessExpression(node) ||
        ts.isNewExpression(node) ||
        ts.isTaggedTemplateExpression(node),
    );
    if (unsafe) return;
    const edits: TextEdit[] = [];
    someNode(key.perItem, (node: Node) => {
      if (
        ts.isPropertyAccessExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        !node.questionDotToken
      )
        edits.push({ start: node.expression.end, end: node.name.getStart(), text: '?.' });
      return false;
    });
    perItem = textWith(key.perItem, edits);
  }
  const keys = mapItems(site, perItem);
  return site.guarded ? `${keys}.filter((key) => key != null)` : keys;
}

const readMethodPattern = /^(?:find|count|exists|aggregate|groupBy|get|has)/;
const batchWritePattern = /Many$/;

// What the reader must check once the read moves before the loop, or undefined when awaited work
// before it could change what it reads. Whether awaited work later in the body may write rows of
// this read: the same repository or client, or a call the builder cannot see into.
function mayWriteSameRows(awaited: AwaitExpression, receiverText: string, prismaRoot: string | undefined): boolean {
  const call = ts.skipParentheses(awaited.expression);
  if (!ts.isCallExpression(call) || !ts.isPropertyAccessExpression(call.expression)) return true;
  const receiver = call.expression.expression;
  if (readMethodPattern.test(call.expression.name.text)) return false;
  if (receiver.kind === ts.SyntaxKind.ThisKeyword || textOf(receiver) === receiverText) return true;
  // Prisma writes on the same client can write this model through nested relations.
  return !!prismaRoot && receiverRoot(receiver) === prismaRoot;
}

// Keys that cannot repeat: items of a list fixed in the source, or each item's own `item.id`.
export function distinctKeys(site: LoopLookupSite, keyNode: Node): boolean {
  const value = ts.isExpression(keyNode) ? ts.skipParentheses(keyNode) : keyNode;
  const ownId =
    ts.isPropertyAccessExpression(value) &&
    value.name.text === 'id' &&
    ts.isIdentifier(value.expression) &&
    site.names.has(value.expression.text);
  return site.source.fixed || ownId;
}

// What the reader must check once the read moves before the loop, or undefined when work in the
// loop could change what it reads: awaited writes before it, or later writes to the same rows when
// two items may share a key.
export function loopWorkNote(
  site: LoopLookupSite,
  receiverText: string,
  prismaRoot: string | undefined,
  keyNode: Node,
): string[] | undefined {
  const earlierWrites: string[] = [];
  for (const awaited of site.earlierAwaits) {
    const call = ts.skipParentheses(awaited.expression);
    if (!ts.isCallExpression(call) || !ts.isPropertyAccessExpression(call.expression)) return;
    const receiver = call.expression.expression;
    const method = call.expression.name.text;
    if (receiver.kind === ts.SyntaxKind.ThisKeyword || textOf(receiver) === receiverText) return;
    if (readMethodPattern.test(method)) continue;
    if (prismaRoot && receiverRoot(receiver) === prismaRoot && !batchWritePattern.test(method)) return;
    earlierWrites.push(textOf(call.expression));
  }
  const laterWrites = site.laterAwaits.some((awaited) => mayWriteSameRows(awaited, receiverText, prismaRoot));
  if (laterWrites && !distinctKeys(site, keyNode)) return;
  if (!site.laterAwaits.length && !earlierWrites.length) return [];
  const checked = earlierWrites.length
    ? ` and that ${[...new Set(earlierWrites)].join(', ')} cannot change what it reads`
    : '';
  return [
    `The read now runs once before the loop, so rows the loop itself writes are not seen by later items: check that no two items share a key${checked}.`,
  ];
}
