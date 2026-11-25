import { ts, calleeCall, indentationAt, lineStart } from './helpers.js';
import { isPure } from './hoisting.js';
import { isMethodCall } from './method-calls.js';
import type {
  ArrayBindingElement,
  ArrowFunction,
  BindingElement,
  BindingName,
  Block,
  CallExpression,
  Declaration,
  ExpressionStatement,
  FunctionExpression,
  Identifier,
  Node,
  Statement,
  VariableDeclaration,
  VariableStatement,
} from 'typescript';
import type { MethodCall } from '../types/method-call.js';
import type { FixResult, SiteFixInput } from '../../shared/types.js';

/** The function a transaction runs its statements in. */
type TransactionCallback = ArrowFunction | FunctionExpression;

/** What the after-the-transaction move needs to decide whether the call can leave the callback. */
interface MovedCall {
  call: CallExpression;
  statement: ExpressionStatement;
  callback: TransactionCallback;
  block: Block;
}

/**
 * The first statement of a transaction callback that makes the call, and the names it declares.
 */
interface LeadingCall {
  statement: ExpressionStatement | VariableStatement;
  declared: string[];
}

const TRANSACTION_METHODS = new Set(['transaction', '$transaction']);
const MOVED_NOTE =
  'The call now runs after the transaction commits, so a failure no longer rolls back the writes, and it no longer runs when the transaction fails. If the writes must not stay without it, record it in an outbox table inside the transaction instead.';

function isTransactionCall(node: Node): node is MethodCall {
  return isMethodCall(node) && TRANSACTION_METHODS.has(node.expression.name.text);
}

function isPropertyName(identifier: Identifier): boolean {
  return ts.isPropertyAccessExpression(identifier.parent) && identifier.parent.name === identifier;
}

// Names used as values, without the member names of `a.b` chains.
function referencedNames(node: Node): Set<string> {
  const names = new Set<string>();
  (function visit(current: Node): void {
    if (ts.isIdentifier(current) && !isPropertyName(current)) names.add(current.text);
    ts.forEachChild(current, visit);
  })(node);
  return names;
}

// Every name the callback declares anywhere (parameters, variables, functions, classes,
// destructured bindings).
function declaredNames(callback: Node): Set<string> {
  const names = new Set<string>();
  const addBinding = (name: BindingName): void => {
    if (ts.isIdentifier(name)) names.add(name.text);
    else
      name.elements.forEach(
        (element: ArrayBindingElement | BindingElement) => ts.isBindingElement(element) && addBinding(element.name),
      );
  };
  (function visit(current: Node): void {
    if ((ts.isParameter(current) || ts.isVariableDeclaration(current)) && current.name) addBinding(current.name);
    else if ((ts.isFunctionDeclaration(current) || ts.isClassDeclaration(current)) && current.name)
      names.add(current.name.text);
    ts.forEachChild(current, visit);
  })(callback);
  return names;
}

function containsKind(node: Node, predicate: (node: Node) => boolean): boolean {
  let found = false;
  (function visit(current: Node): void {
    if (found || (current !== node && ts.isFunctionLike(current))) return;
    if (predicate(current)) found = true;
    else ts.forEachChild(current, visit);
  })(node);
  return found;
}

function isWriteTo(node: Node, names: ReadonlySet<string>): boolean {
  if (ts.isBinaryExpression(node))
    return (
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
      ts.isIdentifier(node.left) &&
      names.has(node.left.text)
    );
  const isIncrement = ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node);
  return isIncrement && ts.isIdentifier(node.operand) && names.has(node.operand.text);
}

// A later call that is not on the transaction client could read what the moved call produces (a
// written file).
function callsOutsideClient(statement: Statement, clientName: string | undefined): boolean {
  return containsKind(
    statement,
    (current) => ts.isCallExpression(current) && !(clientName && referencedNames(current).has(clientName)),
  );
}

function movedCallSafe({ call, statement, callback, block }: MovedCall): boolean {
  const [client] = callback.parameters;
  const clientName = client && ts.isIdentifier(client.name) ? client.name.text : undefined;
  const callNames = referencedNames(call);
  const declared = declaredNames(callback);
  if ([...callNames].some((name) => declared.has(name))) return false;
  if (call.getText().includes('\n') || containsKind(call, (current) => ts.isAwaitExpression(current))) return false;
  if (!ts.isArrowFunction(callback) && containsKind(call, (current) => current.kind === ts.SyntaxKind.ThisKeyword))
    return false;
  if (containsKind(block, (current) => isWriteTo(current, callNames))) return false;
  const statements = block.statements;
  const position = statements.indexOf(statement);
  const exits = (current: Node) => ts.isReturnStatement(current) || ts.isThrowStatement(current);
  if (statements.slice(0, position).some((earlier) => containsKind(earlier, exits))) return false;
  return statements.slice(position + 1).every((later) => {
    const mentioned = referencedNames(later);
    return ![...callNames].some((name) => mentioned.has(name)) && !callsOutsideClient(later, clientName);
  });
}

function moveCallAfterTransaction({ finding, node, text }: SiteFixInput): FixResult | undefined {
  if (!node || text === undefined) return;
  if (/\bwhich reaches\b/.test(finding.message)) return;
  const call = calleeCall(node);
  const awaited = call?.parent;
  const statement = awaited?.parent;
  if (!call || !awaited || !statement || !ts.isAwaitExpression(awaited) || awaited.expression !== call) return;
  if (!ts.isExpressionStatement(statement) || !ts.isBlock(statement.parent)) return;
  const callback = statement.parent.parent;
  if (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback)) return;
  const transaction = callback.parent;
  if (!isTransactionCall(transaction) || !transaction.arguments.includes(callback)) return;
  const transactionAwait = transaction.parent;
  if (!ts.isAwaitExpression(transactionAwait) || transactionAwait.expression !== transaction) return;
  let transactionStatement: Node = transactionAwait.parent;
  if (ts.isVariableDeclaration(transactionStatement) && transactionStatement.initializer === transactionAwait) {
    const list = transactionStatement.parent;
    if (!ts.isVariableDeclarationList(list) || list.declarations.length !== 1) return;
    transactionStatement = list.parent;
  }
  if (
    !(ts.isExpressionStatement(transactionStatement) || ts.isVariableStatement(transactionStatement)) ||
    !ts.isBlock(transactionStatement.parent) ||
    !ts.isFunctionLike(transactionStatement.parent.parent)
  )
    return;
  if (!movedCallSafe({ call, statement, callback, block: statement.parent })) return;

  const sourceFile = statement.getSourceFile();
  const removeStart = lineStart(text, statement.getStart(sourceFile));
  const removeEndLine = text.indexOf('\n', statement.end);
  const removeEnd = removeEndLine === -1 ? text.length : removeEndLine + 1;
  const isAloneOnLine =
    !text.slice(removeStart, statement.getStart(sourceFile)).trim() && !text.slice(statement.end, removeEnd).trim();
  const transactionEnd = transactionStatement.end;
  const lineRest = text.slice(
    transactionEnd,
    text.indexOf('\n', transactionEnd) === -1 ? text.length : text.indexOf('\n', transactionEnd),
  );
  if (!isAloneOnLine || lineRest.trim()) return;
  const lineBreak = text.includes('\r\n') ? '\r\n' : '\n';
  const indentation = indentationAt(text, transactionStatement.getStart(sourceFile));
  return {
    edits: [
      { start: removeStart, end: removeEnd, text: '' },
      { start: transactionEnd, end: transactionEnd, text: `${lineBreak}${indentation}await ${call.getText()};` },
    ],
    note: MOVED_NOTE,
    requiresReview: true,
  };
}

// --- Before the transaction ------------------------------------------------

const BEFORE_NOTE =
  'The call now runs just before the transaction opens. It can run even when the transaction fails to start, and a callback retry no longer repeats it. Review those failure and retry semantics before applying.';

function isAsyncFunction(node: Declaration): boolean {
  return (ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Async) !== 0;
}

// `[const x =] await call(...)` as the first statement of the callback that does anything: earlier
// statements may only declare constants from plain values.
function leadingCallStatement(call: CallExpression, block: Block): LeadingCall | undefined {
  const awaited = call.parent;
  if (!ts.isAwaitExpression(awaited) || awaited.expression !== call) return;
  let statement: Node = awaited.parent;
  let declared: string[] = [];
  if (ts.isVariableDeclaration(statement) && statement.initializer === awaited) {
    const list = statement.parent;
    if (!ts.isVariableDeclarationList(list) || list.declarations.length !== 1 || !(list.flags & ts.NodeFlags.Const))
      return;
    declared = [...declaredNames(statement)];
    statement = list.parent;
  }
  if (!(ts.isExpressionStatement(statement) || ts.isVariableStatement(statement))) return;
  if (statement.parent !== block) return;
  const earlier = block.statements.slice(0, block.statements.indexOf(statement));
  const inert = earlier.every(
    (candidate) =>
      ts.isVariableStatement(candidate) &&
      candidate.declarationList.flags & ts.NodeFlags.Const &&
      candidate.declarationList.declarations.every((declaration: VariableDeclaration) =>
        isPure(declaration.initializer),
      ),
  );
  return inert ? { statement, declared } : undefined;
}

// The statement that runs the transaction: `await tx(...)`, `const x = await tx(...)` or `return
// [await] tx(...)`.
function transactionStatementOf(transaction: MethodCall): Node | undefined {
  let current: Node = transaction;
  if (ts.isAwaitExpression(current.parent) && current.parent.expression === current) current = current.parent;
  const holder = current.parent;
  if (ts.isReturnStatement(holder) || ts.isExpressionStatement(holder)) return holder;
  if (ts.isVariableDeclaration(holder) && holder.initializer === current) {
    const list = holder.parent;
    if (ts.isVariableDeclarationList(list) && list.declarations.length === 1) return list.parent;
  }
}

// The statement text one indentation level out, or undefined when a line does not carry the inner
// indentation or a multi-line template literal would change.
function outdented(statement: Statement, text: string, inner: string, outer: string): string[] | undefined {
  let multilineTemplate = false;
  (function visit(current: Node): void {
    const isTemplate = ts.isTemplateExpression(current) || ts.isNoSubstitutionTemplateLiteral(current);
    if (isTemplate && current.getText().includes('\n')) multilineTemplate = true;
    else ts.forEachChild(current, visit);
  })(statement);
  if (multilineTemplate || !inner.startsWith(outer)) return;
  const extra = inner.slice(outer.length);
  const lines = text.slice(statement.getStart(), statement.end).split(/\r?\n/);
  const rest: string[] = [];
  for (const line of lines.slice(1)) {
    if (line.trim() && !line.startsWith(extra)) return;
    rest.push(line.slice(extra.length));
  }
  return [lines[0], ...rest];
}

function moveCallBeforeTransaction({ node, text }: SiteFixInput): FixResult | undefined {
  if (!node || text === undefined) return;
  const call = calleeCall(node);
  const callback = call && ts.findAncestor(call, ts.isFunctionLike);
  if (!call || !callback || !(ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))) return;
  const block = callback.body;
  if (!ts.isBlock(block)) return;
  const transaction = callback.parent;
  if (!isTransactionCall(transaction) || !transaction.arguments.includes(callback)) return;
  const leading = leadingCallStatement(call, block);
  if (!leading) return;
  const { statement, declared } = leading;
  const inside = declaredNames(callback);
  if ([...referencedNames(call)].some((name) => inside.has(name))) return;
  if (!ts.isArrowFunction(callback) && containsKind(call, (current) => current.kind === ts.SyntaxKind.ThisKeyword))
    return;
  const transactionStatement = transactionStatementOf(transaction);
  const outerFunction = transactionStatement && ts.findAncestor(transactionStatement.parent, ts.isFunctionLike);
  if (!transactionStatement || !ts.isBlock(transactionStatement.parent) || !outerFunction) return;
  if (!isAsyncFunction(outerFunction)) return;
  // A moved `const x` must not meet another `x` in the function it moves into.
  if (declared.some((name) => countNames(outerFunction, name) > countNames(callback, name))) return;

  const sourceFile = statement.getSourceFile();
  const removeStart = lineStart(text, statement.getStart(sourceFile));
  const removeEndLine = text.indexOf('\n', statement.end);
  const removeEnd = removeEndLine === -1 ? text.length : removeEndLine + 1;
  const aloneOnLine =
    !text.slice(removeStart, statement.getStart(sourceFile)).trim() && !text.slice(statement.end, removeEnd).trim();
  const anchorStart = transactionStatement.getStart(sourceFile);
  if (!aloneOnLine || text.slice(lineStart(text, anchorStart), anchorStart).trim()) return;
  const outer = indentationAt(text, anchorStart);
  const lines = outdented(statement, text, indentationAt(text, statement.getStart(sourceFile)), outer);
  if (!lines) return;
  const lineBreak = text.includes('\r\n') ? '\r\n' : '\n';
  const anchorLine = lineStart(text, anchorStart);
  // Removing from the end of the line above keeps the hunk ending on a line that stays.
  const previousLineEnd = removeStart - (text[removeStart - 2] === '\r' ? 2 : 1);
  return {
    edits: [
      { start: anchorLine, end: anchorLine, text: outer + lines.join(lineBreak) + lineBreak },
      { start: previousLineEnd, end: statement.end, text: '' },
    ],
    note: BEFORE_NOTE,
    requiresReview: true,
  };
}

function countNames(node: Node, name: string): number {
  let count = 0;
  (function visit(current: Node): void {
    if (ts.isIdentifier(current) && current.text === name) count++;
    ts.forEachChild(current, visit);
  })(node);
  return count;
}

function moveExternalCall(context: SiteFixInput): FixResult | undefined {
  return moveCallBeforeTransaction(context) ?? moveCallAfterTransaction(context);
}

export default { 'external-call-in-transaction': moveExternalCall };
