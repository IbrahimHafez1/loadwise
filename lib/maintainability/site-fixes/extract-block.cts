// loadwise-reviewed large-module -- one extract-block fix pipeline (data flow, naming, edit planning, measurement) over shared private types where each stage feeds the next; splitting would only export private internals across files
// Moves one statement into a named function and calls it where the statement stood:
//   processRows(rows, seen);
//   ...
//   function processRows(rows: Row[], seen: Set<string>) { ...statement }
// The function is declared after the top-level statement that holds the code, or, inside a class
// method, as a private method next to it called through `this`. Local variables the statement reads
// become parameters, in order of first use. It is offered only when the statement finishes normally
// (no return, no break or continue that leaves it, no await or yield), takes at most four
// parameters, and reassigns none of them, except one outer `let` that the function returns and the
// call assigns back: `total = sumRows(rows, total)`. When the statement only fills one empty
// collection that the line above declares and the code after it uses, the function creates and
// returns that collection instead, and the call declares it: `const seen = buildSeen(rows)`. A
// parameter is a copy taken at the call, so it is refused when a closure could see the variable
// change. In TypeScript every parameter gets the type the checker gives the variable at that spot,
// and the rewritten file must not type-check worse.
import { applyEdits } from '../../shared/fix-hunks.cjs';
import { originalProgram, typeChecksAsBefore } from './isolated-program.cjs';
import {
  ts,
  functionWithBody,
  flaggedFunction,
  lineStart,
  lineEnd,
  indentationAt,
  newlineOf,
  blank,
  nameUsed,
  ownsLines,
  hasMultilineLiteral,
} from './helpers.cjs';
import { analyzeFunctions } from '../functions.cjs';
import type {
  BinaryExpression,
  BreakOrContinueStatement,
  ClassLikeDeclaration,
  Expression,
  Identifier,
  Node,
  PostfixUnaryExpression,
  PrefixUnaryExpression,
  SourceFile,
  Statement,
  Symbol,
  Type,
  TypeChecker,
  VariableStatement,
} from 'typescript';
import type { Finding, TextEdit } from '../../shared/types.cjs';
import type { ExtractionDraft, MeasuredEdits } from '../types/extraction-drafts.cjs';
import type { FunctionWithBody } from '../types/site-fix-nodes.cjs';

// Where the new function goes: a private method after a class member, or a function after a
// top-level statement.
interface Placement {
  method: boolean;
  container: Node;
}

// A local variable the statement uses, with every reference and write of it in the enclosing
// function.
interface FreeVariable {
  symbol: Symbol;
  declaration: Node;
  first: Identifier;
  references: Identifier[];
  writes: Identifier[];
}

interface BuiltCollection {
  variable: FreeVariable;
  declarationStatement: VariableStatement;
}

// What the new function receives (`variables`) and gives back (`returned` or the collection
// `built`).
interface DataFlow {
  returned: FreeVariable | null;
  built: BuiltCollection | undefined;
  variables: FreeVariable[];
}

interface HelperSignature {
  name: string;
  parameters: string[];
  step: string;
}

interface SignatureInput {
  statement: Statement;
  sourceFile: SourceFile;
  placement: Placement;
  flow: DataFlow;
  typeScript: boolean;
  checker: TypeChecker;
}

// Everything the edits are built from, except the checker.
interface ExtractionPlan {
  statement: Statement;
  fn: FunctionWithBody;
  sourceFile: SourceFile;
  placement: Placement;
  flow: DataFlow;
  typeScript: boolean;
  signature: HelperSignature;
}

// A run of edits close enough to print as one hunk.
interface EditGroup {
  first: number;
  last: number;
  edits: TextEdit[];
}

// Mirrors site-fix: longer hunks are rejected, and edits this close print as one hunk.
const maxHunkLines = 14;
const hunkJoinDistance = 3;
// A shorter statement gains nothing from a name of its own.
const minExtractedLines = 3;
const maxParameters = 4;
const maxSignatureLength = 100;
const typeScriptFile = /\.[cm]?tsx?$/i;
// Types that cannot be written back as they are, or that hide what the code expects.
const unprintableType = /\bany\b|import\(|\.\.\./;
// A parameter typed like this would not give the block what the original site had: an empty object
// type has no members, and unknown (a caught error, or a type behind an unresolved import) cannot
// be read without the narrowing that was left behind. Comparing diagnostics alone misses this when
// the file already reports the same message elsewhere.
const uselessParameterType = /^(\{\s*\}|unknown|never|object|Object)$/;

// Calls nodes of `root` that run as part of it, skipping the bodies of nested functions and
// classes.
function forOwnNodes(root: Node, visit: (node: Node) => boolean | void): void {
  (function walk(node: Node): void {
    if (visit(node) === false) return;
    if (node !== root && (functionWithBody(node) || ts.isClassLike(node))) return;
    ts.forEachChild(node, walk);
  })(root);
}

function contains(outer: Node, inner: Node): boolean {
  return inner.pos >= outer.pos && inner.end <= outer.end;
}

// The statement a break or continue leaves, by label or as the nearest loop (or switch, for break).
function jumpTarget(jump: BreakOrContinueStatement): Node | undefined {
  for (let node: Node | undefined = jump.parent; node; node = node.parent) {
    if (functionWithBody(node)) return;
    if (jump.label) {
      if (ts.isLabeledStatement(node) && node.label.text === jump.label.text) return node;
    } else if (ts.isIterationStatement(node, false) || (ts.isBreakStatement(jump) && ts.isSwitchStatement(node)))
      return node;
  }
}

const leavingKinds = new Set([
  ts.SyntaxKind.ReturnStatement,
  ts.SyntaxKind.AwaitExpression,
  ts.SyntaxKind.YieldExpression,
  ts.SyntaxKind.FunctionDeclaration,
]);

const awaitUsing = ts.NodeFlags.Const | ts.NodeFlags.Using;

// The statement cannot run inside a function of its own unchanged.
function leavesFunction(statement: Statement): boolean {
  let blocked = false;
  forOwnNodes(statement, (node: Node) => {
    if (blocked) return false;
    if (leavingKinds.has(node.kind) || (ts.isForOfStatement(node) && node.awaitModifier)) blocked = true;
    else if (ts.isBreakOrContinueStatement(node)) blocked = !contains(statement, jumpTarget(node) ?? statement.parent);
    // var is visible to the rest of the function, and `await using` awaits when the block ends.
    else if (ts.isVariableDeclarationList(node))
      blocked = !(node.flags & ts.NodeFlags.BlockScoped) || (node.flags & awaitUsing) === awaitUsing;
    // A super() call must stay in the constructor body.
    else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.SuperKeyword) blocked = true;
    return !blocked;
  });
  return blocked;
}

// How the statement uses its function's own `this`, looking through arrows, which share it: 'this'
// for this or super, 'blocked' for arguments or new.target, which a new function would answer
// differently.
function receiverUse(statement: Statement): 'blocked' | 'this' | undefined {
  let use: 'blocked' | 'this' | undefined;
  (function walk(node: Node): void {
    if (use === 'blocked') return;
    if (node !== statement && ((functionWithBody(node) && !ts.isArrowFunction(node)) || ts.isClassLike(node))) return;
    if (ts.isMetaProperty(node) || (ts.isIdentifier(node) && node.text === 'arguments' && !isMemberName(node)))
      use = 'blocked';
    else if (node.kind === ts.SyntaxKind.ThisKeyword || node.kind === ts.SyntaxKind.SuperKeyword) use = 'this';
    ts.forEachChild(node, walk);
  })(statement);
  return use;
}

function isMemberName(identifier: Identifier): boolean {
  const parent = identifier.parent;
  if (ts.isQualifiedName(parent)) return parent.right === identifier;
  return (
    (ts.isPropertyAccessExpression(parent) ||
      ts.isPropertyAssignment(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isPropertyDeclaration(parent)) &&
    parent.name === identifier
  );
}

// Where the function goes. Inside a non-static class member it becomes a private method after that
// member, so it keeps `this`; anywhere else a function declared after the top-level statement,
// which needs no `this`.
function placementOf(statement: Statement, receiver: boolean): Placement | undefined {
  for (let node: Node | undefined = statement.parent; node; node = node.parent) {
    if (ts.isArrowFunction(node)) continue;
    const memberNode = functionWithBody(node) || ts.isPropertyDeclaration(node) ? node : undefined;
    if (
      memberNode &&
      memberNode.parent &&
      ts.isClassLike(memberNode.parent) &&
      !ts.isClassStaticBlockDeclaration(memberNode)
    ) {
      const isStatic = memberNode.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword);
      if (!isStatic) return { method: true, container: memberNode };
    }
    if (functionWithBody(node) || ts.isClassLike(node) || ts.isClassStaticBlockDeclaration(node)) break;
  }
  if (receiver) return;
  let top: Node = statement;
  while (top.parent && !ts.isSourceFile(top.parent)) top = top.parent;
  if (top.parent) return { method: false, container: top };
}

// --- Narrowing the function relies on ---

// `a.b?.c!` and `a["b"]` as the path TypeScript narrows: `a.b.c`, `a.b`. Undefined for anything
// else.
function referencePath(node: Node): string | undefined {
  if (ts.isIdentifier(node)) return node.text;
  if (node.kind === ts.SyntaxKind.ThisKeyword) return 'this';
  if (ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node)) return referencePath(node.expression);
  if (!ts.isPropertyAccessExpression(node) && !ts.isElementAccessExpression(node)) return;
  const owner = referencePath(node.expression);
  if (!owner) return;
  if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.name)) return owner + '.' + node.name.text;
  if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression))
    return owner + '.' + node.argumentExpression.text;
  // TypeScript also narrows `a[key]` for a constant key.
  if (ts.isElementAccessExpression(node) && ts.isIdentifier(node.argumentExpression))
    return owner + '[' + node.argumentExpression.text + ']';
}

function isPathNode(node: Node): boolean {
  return (
    ts.isIdentifier(node) ||
    node.kind === ts.SyntaxKind.ThisKeyword ||
    ts.isPropertyAccessExpression(node) ||
    ts.isElementAccessExpression(node)
  );
}

// Paths under `root`. A called function is not narrowed by the call, so callees are left out.
function addPaths(root: Node, paths: Set<string>): void {
  (function walk(node: Node): void {
    const callee = ts.isCallExpression(node.parent) && node.parent.expression === node;
    if (isPathNode(node) && !callee) {
      const found = referencePath(node);
      if (found) paths.add(found);
    }
    ts.forEachChild(node, walk);
  })(root);
}

function isAssignment(node: Node): node is BinaryExpression {
  return ts.isBinaryExpression(node) && ts.isAssignmentOperator(node.operatorToken.kind);
}

function isIncrement(node: Node): node is PrefixUnaryExpression | PostfixUnaryExpression {
  return (
    (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
    (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)
  );
}

// Expressions whose paths TypeScript may narrow for the code after them.
function narrowingParts(node: Node): readonly (Node | undefined)[] {
  if (ts.isIfStatement(node) || ts.isWhileStatement(node) || ts.isDoStatement(node)) return [node.expression];
  if (ts.isSwitchStatement(node)) return [node.expression];
  if (ts.isForStatement(node)) return [node.condition];
  if (ts.isConditionalExpression(node)) return [node.condition];
  if (ts.isBinaryExpression(node)) {
    const operator = node.operatorToken.kind;
    if (ts.isAssignmentOperator(operator)) return [node.left];
    if (
      operator === ts.SyntaxKind.AmpersandAmpersandToken ||
      operator === ts.SyntaxKind.BarBarToken ||
      operator === ts.SyntaxKind.QuestionQuestionToken
    )
      return [node.left];
  }
  if (ts.isCallExpression(node) && /^assert/i.test(referencePath(node.expression)?.split('.').at(-1) ?? ''))
    return node.arguments;
  if (isIncrement(node)) return [node.operand];
  // A declared union narrows to the type of its initializer.
  if ((ts.isVariableDeclaration(node) || ts.isParameter(node)) && node.initializer) return [node.name];
  return [];
}

// Paths of `fn` outside `statement` that a condition, assertion or assignment may narrow.
function narrowedPaths(fn: Node, statement: Statement): Set<string> {
  const paths = new Set<string>();
  (function walk(node: Node): void {
    if (node === statement) return;
    for (const part of narrowingParts(node)) if (part) addPaths(part, paths);
    ts.forEachChild(node, walk);
  })(fn);
  return paths;
}

// A type narrowing cannot change: known, and neither a union nor any/unknown (which unresolved
// imports become).
function plainType(type: Type): boolean {
  return !(type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Never)) && !type.isUnion();
}

function bindingList(declaration: Node) {
  let node: Node | undefined = declaration;
  while (node && (ts.isBindingElement(node) || ts.isObjectBindingPattern(node) || ts.isArrayBindingPattern(node)))
    node = node.parent;
  if (node && ts.isVariableDeclaration(node)) return node.parent;
}

function constantSymbol(symbol: Symbol): boolean {
  const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
  if (!declaration) return false;
  if (ts.isVariableDeclaration(declaration) || ts.isBindingElement(declaration)) {
    const list = bindingList(declaration);
    return Boolean(list && ts.isVariableDeclarationList(list) && list.flags & ts.NodeFlags.Const);
  }
  return (
    ts.isImportSpecifier(declaration) ||
    ts.isImportClause(declaration) ||
    ts.isNamespaceImport(declaration) ||
    ts.isClassDeclaration(declaration) ||
    ts.isEnumDeclaration(declaration)
  );
}

const mutatingMethods = new Set([
  'push',
  'pop',
  'shift',
  'unshift',
  'splice',
  'sort',
  'reverse',
  'fill',
  'copyWithin',
  'add',
  'set',
  'delete',
  'clear',
  'append',
]);

// The identifier, or `this`, at the start of an access chain such as `a.b[c].d()`. Undefined for
// anything else.
function accessRoot(expression: Expression): Expression | undefined {
  let current = expression;
  while (
    ts.isPropertyAccessExpression(current) ||
    ts.isElementAccessExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isParenthesizedExpression(current) ||
    ts.isCallExpression(current)
  )
    current = current.expression;
  return ts.isIdentifier(current) || current.kind === ts.SyntaxKind.ThisKeyword ? current : undefined;
}

// What the node changes, as expressions: assignment and increment targets, deleted members, and the
// receiver of a call that mutates it, such as `items.push(x)`.
function mutatedExpressions(node: Node): readonly Expression[] {
  if (isAssignment(node)) return [node.left];
  if (isIncrement(node)) return [node.operand];
  if (ts.isDeleteExpression(node)) return [node.expression];
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
    return mutatingMethods.has(node.expression.name.text) ? [node.expression.expression] : [];
  }
  return [];
}

// Identifiers a node writes to: assignment and increment targets, including destructuring.
function writtenIdentifiers(node: Node): Identifier[] {
  const target: Node | undefined = isAssignment(node)
    ? node.left
    : isIncrement(node)
      ? node.operand
      : (ts.isForOfStatement(node) || ts.isForInStatement(node)) && !ts.isVariableDeclarationList(node.initializer)
        ? node.initializer
        : undefined;
  if (!target) return [];
  const identifiers: Identifier[] = [];
  (function walk(part: Node): void {
    if (ts.isIdentifier(part)) identifiers.push(part);
    else if (ts.isShorthandPropertyAssignment(part)) identifiers.push(part.name);
    else if (ts.isPropertyAssignment(part)) walk(part.initializer);
    else if (
      ts.isArrayLiteralExpression(part) ||
      ts.isObjectLiteralExpression(part) ||
      ts.isParenthesizedExpression(part) ||
      ts.isSpreadElement(part) ||
      ts.isSpreadAssignment(part) ||
      (ts.isBinaryExpression(part) && part.operatorToken.kind === ts.SyntaxKind.EqualsToken)
    )
      ts.forEachChild(part, walk);
  })(target);
  return identifiers;
}

function symbolOf(checker: TypeChecker, identifier: Identifier): Symbol | undefined {
  const parent = identifier.parent;
  if (ts.isShorthandPropertyAssignment(parent) && parent.name === identifier)
    return checker.getShorthandAssignmentValueSymbol(parent);
  return checker.getSymbolAtLocation(identifier);
}

// `node` runs inside a function that does not hold `declaration`, so it may run at another time.
function insideClosure(node: Node, declaration: Node): boolean {
  for (let current: Node | undefined = node.parent; current; current = current.parent) {
    if (contains(current, declaration)) return false;
    if (functionWithBody(current)) return true;
  }
  return false;
}

// --- Parameters ---

const memberSymbols = ts.SymbolFlags.Property | ts.SymbolFlags.Method | ts.SymbolFlags.Accessor;

// A binding of `container` that the new function cannot see: declared inside it, except the binding
// a top-level statement itself declares.
function isLocal(declaration: Node, container: Node): boolean {
  if (!contains(container, declaration) || declaration === container) return false;
  return bindingList(declaration)?.parent !== container;
}

// Local variables the statement uses, in order of first use, with every reference and write in
// `container`. Undefined when it uses a local function, class or type, which the new function could
// not reach.
function freeVariables(statement: Statement, container: Node, checker: TypeChecker): FreeVariable[] | undefined {
  const found = new Map<Symbol, FreeVariable>();
  let blocked = false;
  function capture(node: Identifier): void {
    const symbol = symbolOf(checker, node);
    const declaration = symbol && (symbol.valueDeclaration ?? symbol.declarations?.[0]);
    if (!declaration || contains(statement, declaration) || !isLocal(declaration, container)) return;
    if (!(symbol.flags & ts.SymbolFlags.Variable)) {
      if (!(symbol.flags & memberSymbols)) blocked = true;
      return;
    }
    if (!found.has(symbol)) found.set(symbol, { symbol, declaration, first: node, references: [], writes: [] });
  }
  (function walk(node: Node): void {
    if (blocked) return;
    if (ts.isIdentifier(node)) capture(node);
    ts.forEachChild(node, walk);
  })(statement);
  if (blocked) return;
  const variables = [...found.values()];
  const bySymbol = new Map(variables.map((variable) => [variable.symbol, variable]));
  const variableOf = (identifier: Identifier): FreeVariable | undefined => {
    const symbol = symbolOf(checker, identifier);
    return symbol && bySymbol.get(symbol);
  };
  (function walk(node: Node): void {
    if (ts.isIdentifier(node)) variableOf(node)?.references.push(node);
    for (const identifier of writtenIdentifiers(node)) variableOf(identifier)?.writes.push(identifier);
    ts.forEachChild(node, walk);
  })(container);
  return variables;
}

function isLetVariable(declaration: Node): boolean {
  const list = bindingList(declaration);
  return Boolean(list && list.flags & ts.NodeFlags.Let);
}

// The one variable the function hands back, null for none, or undefined when the parameters would
// not behave like the variables they copy.
function returnedVariable(
  statement: Statement,
  container: Node,
  variables: readonly FreeVariable[],
): FreeVariable | null | undefined {
  let returned: FreeVariable | null = null;
  for (const variable of variables) {
    const { declaration, references, writes } = variable;
    // Read before its declaration runs, the copy would throw where the original code did not.
    if (declaration.pos > statement.pos) return;
    // A closure that assigns the variable, or that the statement creates and that reads it later,
    // would see the copy and the variable drift apart.
    if (writes.some((write) => insideClosure(write, declaration))) return;
    const readLater = references.some(
      (reference) => contains(statement, reference) && insideClosure(reference, declaration),
    );
    if (writes.length && readLater) return;
    if (!writes.some((write) => contains(statement, write))) continue;
    if (returned || !isLetVariable(declaration)) return;
    if (references.some((reference) => insideClosure(reference, declaration))) return;
    returned = variable;
  }
  // A throw halfway through would leave the copy's changes behind, where a surrounding try could
  // still look.
  if (returned)
    for (let node = statement.parent; node && node !== container; node = node.parent)
      if (ts.isTryStatement(node)) return;
  return returned;
}

const emptyCollectionConstructors = new Set(['Map', 'Set', 'WeakMap', 'WeakSet']);

function isEmptyCollection(initializer: Expression | undefined): boolean {
  if (!initializer) return false;
  if (ts.isArrayLiteralExpression(initializer)) return initializer.elements.length === 0;
  if (ts.isObjectLiteralExpression(initializer)) return initializer.properties.length === 0;
  return (
    ts.isNewExpression(initializer) &&
    ts.isIdentifier(initializer.expression) &&
    emptyCollectionConstructors.has(initializer.expression.text) &&
    !initializer.arguments?.length
  );
}

// Whether the statement changes the variable and nothing else that outlives it: every other write
// or mutating call reaches only what the statement declares itself.
function mutatesOnly(statement: Statement, variable: FreeVariable, checker: TypeChecker): boolean {
  let mutatesVariable = false;
  let mutatesOther = false;
  (function walk(node: Node): void {
    for (const expression of mutatedExpressions(node)) {
      const root = accessRoot(expression);
      const symbol = root && ts.isIdentifier(root) ? symbolOf(checker, root) : undefined;
      const declaration = symbol && (symbol.valueDeclaration ?? symbol.declarations?.[0]);
      if (symbol === variable.symbol) mutatesVariable = true;
      else if (!declaration || !contains(statement, declaration)) mutatesOther = true;
    }
    ts.forEachChild(node, walk);
  })(statement);
  return mutatesVariable && !mutatesOther;
}

// The empty collection the statement fills for the code after it: a const declared on the line
// above, used nowhere else before the statement, so creating it inside the function changes
// nothing.
function builtCollection(
  statement: Statement,
  variables: readonly FreeVariable[],
  checker: TypeChecker,
): BuiltCollection | undefined {
  if (!ts.isBlock(statement.parent)) return;
  const siblings = statement.parent.statements;
  const declarationStatement = siblings[siblings.indexOf(statement) - 1];
  if (!declarationStatement || !ts.isVariableStatement(declarationStatement)) return;
  const { declarations, flags } = declarationStatement.declarationList;
  if (declarations.length !== 1 || !(flags & ts.NodeFlags.Const)) return;
  const [declaration] = declarations;
  if (!ts.isIdentifier(declaration.name) || !isEmptyCollection(declaration.initializer)) return;
  const variable = variables.find((candidate) => candidate.declaration === declaration);
  if (!variable) return;
  const usedAfter = variable.references.some((reference) => reference.pos >= statement.end);
  const usedElsewhereBefore = variable.references.some(
    (reference) => reference !== declaration.name && reference.end <= statement.pos,
  );
  if (!usedAfter || usedElsewhereBefore || !mutatesOnly(statement, variable, checker)) return;
  return { variable, declarationStatement };
}

// TypeScript narrows outer paths for the code inside them; a separate function sees only declared
// types. The parameters carry the narrowed type of each variable, but paths through properties and
// module bindings lose it.
function narrowingLost(
  statement: Statement,
  fn: Node,
  checker: TypeChecker,
  variables: readonly FreeVariable[],
  builtDeclaration: Node | undefined,
): boolean {
  const narrowed = narrowedPaths(fn, statement);
  const parameters = new Set(variables.map((variable) => variable.symbol));
  let lost = false;
  (function walk(node: Node): void {
    if (lost) return;
    const path = isPathNode(node) && referencePath(node);
    if (path && narrowed.has(path) && !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node)) {
      if (ts.isIdentifier(node)) {
        const symbol = symbolOf(checker, node);
        const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
        if (!symbol) lost = true;
        // The parameter type is read at this spot, so it is narrowed already, unless it is unknown here.
        else if (parameters.has(symbol)) lost = Boolean(checker.getTypeAtLocation(node).flags & ts.TypeFlags.Any);
        else if (declaration && (contains(statement, declaration) || declaration === builtDeclaration)) lost = false;
        else
          lost = !(
            plainType(checker.getTypeOfSymbol(symbol)) ||
            (declaration !== undefined &&
              constantSymbol(symbol) &&
              !ts.isVariableDeclaration(declaration) &&
              !ts.isBindingElement(declaration))
          );
      } else if (path.includes('.') || path.includes('[')) {
        const property = ts.isPropertyAccessExpression(node) && checker.getSymbolAtLocation(node.name);
        if (!property || !plainType(checker.getTypeOfSymbol(property))) lost = true;
      }
    }
    ts.forEachChild(node, walk);
  })(statement);
  return lost;
}

const typeFormat = ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope;

// `name: Type` for each parameter, or undefined when a type cannot be written down.
function typedParameters(
  variables: readonly FreeVariable[],
  returned: FreeVariable | null | undefined,
  checker: TypeChecker,
  enclosing: Node,
): string[] | undefined {
  const parameters: string[] = [];
  for (const variable of variables) {
    const type =
      variable === returned ? checker.getTypeOfSymbol(variable.symbol) : checker.getTypeAtLocation(variable.first);
    // The checker ends object types with `; }`, where formatters write ` }`.
    const text = checker.typeToString(type, enclosing, typeFormat).replaceAll('; }', ' }');
    if (unprintableType.test(text) || uselessParameterType.test(text.trim())) return;
    parameters.push(`${variable.symbol.name}: ${text}`);
  }
  return parameters;
}

// --- Naming ---

// `items`, `ITEM_KEYS` or `item_keys` as a capitalized part of a camelCase name.
function pascal(word: string): string {
  const parts = /[a-z]/.test(word) && !word.includes('_') ? [word] : word.toLowerCase().split('_').filter(Boolean);
  return parts.map((part) => part[0].toUpperCase() + part.slice(1)).join('');
}

// Methods that read or reshape their receiver, so the receiver names what the code is about.
const receiverMethods = new Set([
  'get',
  'has',
  'includes',
  'some',
  'every',
  'find',
  'at',
  'indexOf',
  'filter',
  'map',
  'slice',
  'entries',
  'values',
  'keys',
  'flat',
  'flatMap',
  'sort',
  'reverse',
  'concat',
  'from',
  'toSorted',
  'toReversed',
]);

// The noun a loop or condition is about: the last name in `a.b.items`, the receiver of
// `items.filter(...)`, the argument of `Object.entries(items)`, or `items` in `getItems()`.
function subjectName(expression: Expression | undefined): string | undefined {
  if (!expression) return;
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) {
    if (expression.name.text === 'length' || expression.name.text === 'size') return subjectName(expression.expression);
    return expression.name.text;
  }
  if (ts.isCallExpression(expression)) {
    const callee = expression.expression;
    if (ts.isPropertyAccessExpression(callee)) {
      const receiver = callee.expression;
      // Static helpers such as Object.entries(items) or Array.from(items) are about their argument.
      const staticHelper = ts.isIdentifier(receiver) && /^[A-Z]/.test(receiver.text);
      if (staticHelper && expression.arguments.length) return subjectName(expression.arguments[0]);
      if (receiverMethods.has(callee.name.text)) return subjectName(receiver);
    }
    return subjectName(callee)?.replace(/^(get|find|list|load|fetch)(?=[A-Z])/, '');
  }
  if (
    ts.isParenthesizedExpression(expression) ||
    ts.isNonNullExpression(expression) ||
    ts.isAsExpression(expression) ||
    ts.isElementAccessExpression(expression)
  )
    return subjectName(expression.expression);
  if (ts.isPrefixUnaryExpression(expression)) return subjectName(expression.operand);
  if (ts.isBinaryExpression(expression)) return subjectName(expression.left) ?? subjectName(expression.right);
  if (ts.isTypeOfExpression(expression)) return subjectName(expression.expression);
}

// The first call the statement makes, as the action a try block attempts.
function firstCallName(statement: Statement): string | undefined {
  let name: string | undefined;
  forOwnNodes(statement, (node: Node) => {
    if (name) return false;
    if (ts.isCallExpression(node)) name = subjectName(node.expression);
  });
  return name;
}

function assertionCall(expression: Expression): boolean {
  if (!ts.isCallExpression(expression)) return false;
  const callee = expression.expression;
  if (ts.isIdentifier(callee)) return callee.text.startsWith('assert');
  return (
    ts.isPropertyAccessExpression(callee) &&
    ((ts.isIdentifier(callee.expression) && callee.expression.text === 'assert') ||
      callee.name.text.startsWith('assert'))
  );
}

// Code that only checks: every path ends in a throw or an assertion call, so it changes nothing
// when it passes.
function onlyValidates(statement: Statement): boolean {
  if (ts.isThrowStatement(statement)) return true;
  if (ts.isExpressionStatement(statement)) return assertionCall(statement.expression);
  if (ts.isBlock(statement)) return statement.statements.length > 0 && statement.statements.every(onlyValidates);
  if (ts.isIfStatement(statement))
    return (
      onlyValidates(statement.thenStatement) && (!statement.elseStatement || onlyValidates(statement.elseStatement))
    );
  if (ts.isIterationStatement(statement, false)) return onlyValidates(statement.statement);
  return false;
}

// `if (file.isDeclarationFile)` is about the declaration file, so the name is
// handleDeclarationFile, not handleIsDeclarationFile.
const booleanPrefix = /^(?:is|has)(?=[A-Z])/;

function describedName(statement: Statement): string | undefined {
  const verb = onlyValidates(statement) ? 'assert' : undefined;
  if (ts.isForOfStatement(statement) || ts.isForInStatement(statement)) {
    const subject = subjectName(statement.expression);
    return subject && (verb ?? 'process') + pascal(subject);
  }
  if (ts.isForStatement(statement) || ts.isWhileStatement(statement) || ts.isDoStatement(statement)) {
    const condition = ts.isForStatement(statement) ? statement.condition : statement.expression;
    // `i < items.length` is about items, not the counter.
    const bound = condition && ts.isBinaryExpression(condition) ? subjectName(condition.right) : undefined;
    const subject = bound ?? subjectName(condition);
    return subject && (verb ?? 'process') + pascal(subject);
  }
  if (ts.isIfStatement(statement) || ts.isSwitchStatement(statement)) {
    const subject = subjectName(statement.expression)?.replace(booleanPrefix, '');
    return subject && (verb ?? 'handle') + pascal(subject);
  }
  if (ts.isTryStatement(statement)) {
    const action = firstCallName(statement.tryBlock);
    return action && 'try' + pascal(action);
  }
}

// A descriptive name that nothing in the file already uses, so the function shadows and clashes
// with nothing.
function helperName(statement: Statement, sourceFile: SourceFile): string | undefined {
  const base = describedName(statement);
  if (!base || !/^[A-Za-z_$][\w$]*$/.test(base)) return;
  if (!nameUsed(sourceFile, base)) return base;
}

// `buildSeen` for the collection `seen`, when nothing in the file uses that name.
function builderName(variable: FreeVariable, sourceFile: SourceFile): string | undefined {
  const name = 'build' + pascal(variable.symbol.name);
  if (!nameUsed(sourceFile, name)) return name;
}

// Whether a new method `name` would clash with a member the class declares or inherits, on its
// instance or static side, or one an implemented interface declares. A base or interface the
// isolated checker cannot resolve, such as an imported one, may define any name, so it counts as a
// clash.
function memberNameTaken(classNode: ClassLikeDeclaration, name: string, checker: TypeChecker): boolean {
  for (const clause of classNode.heritageClauses ?? [])
    for (const heritage of clause.types) {
      const type = checker.getTypeAtLocation(heritage);
      if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return true;
      if (checker.getPropertiesOfType(type).some((property) => property.name === name)) return true;
    }
  const symbol = classNode.name ? checker.getSymbolAtLocation(classNode.name) : classNode.symbol;
  if (!symbol) return true;
  const sides = [checker.getDeclaredTypeOfSymbol(symbol), checker.getTypeOfSymbol(symbol)];
  return sides.some((type) => checker.getPropertiesOfType(type).some((property) => property.name === name));
}

// --- Layout ---

// One indentation step, read from the statement and the line that opens its block.
function indentationStep(statement: Statement, sourceFile: SourceFile): string | undefined {
  const text = sourceFile.text;
  const own = indentationAt(text, statement.getStart(sourceFile));
  const outer = indentationAt(text, statement.parent.getStart(sourceFile));
  if (own.startsWith(outer) && own.length > outer.length) return own.slice(outer.length);
}

// The lines from `first` to the end of `statement` re-indented to `indentation`, or undefined when
// a line sits left of them.
function movedLines(
  statement: Statement,
  sourceFile: SourceFile,
  indentation: string,
  first: Statement = statement,
): string[] | undefined {
  const text = sourceFile.text;
  const own = indentationAt(text, first.getStart(sourceFile));
  const lines = text.slice(lineStart(text, first.getStart(sourceFile)), statement.end).split('\n');
  if (lines.some((line) => !blank(line) && !line.startsWith(own))) return;
  return lines.map((line) => (blank(line) ? line.replace(/^[ \t]+/, '') : indentation + line.slice(own.length)));
}

// Code written without semicolons gets none either.
function usesSemicolons(fn: FunctionWithBody, sourceFile: SourceFile): boolean {
  let withSemicolon = 0;
  let without = 0;
  forOwnNodes(fn.body, (node: Node) => {
    if (!ts.isExpressionStatement(node) && !ts.isVariableStatement(node)) return;
    if (sourceFile.text[node.end - 1] === ';') withSemicolon++;
    else without++;
  });
  return withSemicolon >= without;
}

// Without semicolons, a following line that starts with one of these would continue the inserted
// call.
const continuingLine = /^\s*[([`+\-/]/;

// Whether `statement` fills whole lines and is big enough, but not too big, to be worth a function
// of its own.
function isMovableStatement(statement: Statement, sourceFile: SourceFile): boolean {
  if (!ts.isBlock(statement.parent) || !ownsLines(statement) || hasMultilineLiteral(statement)) return false;
  const lineCount = sourceFile.text.slice(statement.getStart(sourceFile), statement.end).split('\n').length;
  return lineCount >= minExtractedLines && lineCount <= maxHunkLines && !leavesFunction(statement);
}

// What the new function receives and gives back: the variables it reads, plus either the one it
// assigns that later code uses or the collection it builds. Undefined when the statement is too
// entangled with its surroundings.
function dataFlowOf(statement: Statement, container: Node, checker: TypeChecker): DataFlow | undefined {
  const allVariables = freeVariables(statement, container, checker);
  if (!allVariables) return;
  const returned = returnedVariable(statement, container, allVariables);
  if (returned === undefined) return;
  const built = returned ? undefined : builtCollection(statement, allVariables, checker);
  const variables = allVariables.filter((variable) => variable !== built?.variable);
  if (variables.length > maxParameters) return;
  return { returned, built, variables };
}

// The new function's name, parameter list and indentation step, or undefined when any of them
// cannot be chosen safely.
function helperSignatureOf({
  statement,
  sourceFile,
  placement,
  flow,
  typeScript,
  checker,
}: SignatureInput): HelperSignature | undefined {
  const { container, method } = placement;
  const { returned, built, variables } = flow;
  const parameters = typeScript
    ? typedParameters(variables, returned, checker, container.parent)
    : variables.map((variable) => variable.symbol.name);
  const step = indentationStep(statement, sourceFile);
  const name = built ? builderName(built.variable, sourceFile) : helperName(statement, sourceFile);
  if (!parameters || !step || !name) return;
  if (method && ts.isClassLike(container.parent) && memberNameTaken(container.parent, name, checker)) return;
  return { name, parameters, step };
}

// Everything the edits are built from, or undefined when the statement cannot be moved without
// changing behaviour.
function extractionPlan(
  statement: Statement,
  fn: FunctionWithBody,
  sourceFile: SourceFile,
): ExtractionPlan | undefined {
  if (!isMovableStatement(statement, sourceFile)) return;
  const receiver = receiverUse(statement);
  if (receiver === 'blocked') return;
  const placement = placementOf(statement, receiver === 'this');
  if (!placement) return;
  const { container } = placement;
  const checker = originalProgram(sourceFile).getTypeChecker();
  const flow = dataFlowOf(statement, container, checker);
  if (!flow) return;
  const typeScript = typeScriptFile.test(sourceFile.fileName);
  if (typeScript && narrowingLost(statement, fn, checker, flow.variables, flow.built?.variable.declaration)) return;
  const plan = { statement, fn, sourceFile, placement, flow, typeScript };
  const signature = helperSignatureOf({ ...plan, checker });
  if (!signature) return;
  const text = sourceFile.text;
  if (!blank(text.slice(container.end, lineEnd(text, container.end)))) return;
  return { ...plan, signature };
}

// Code written without semicolons gets none either; empty when none is wanted, undefined when
// leaving it out would let the next line continue the inserted call.
function statementEnding({ statement, fn, sourceFile }: ExtractionPlan): string | undefined {
  const ending = usesSemicolons(fn, sourceFile) ? ';' : '';
  if (!ending && continuingLine.test(sourceFile.text.slice(statement.end))) return;
  return ending;
}

function methodKeyword(method: boolean, typeScript: boolean): string {
  if (!method) return 'function ';
  return typeScript ? 'private ' : '';
}

// The text of the new function, to go after the enclosing member or top-level statement.
function helperDeclarationText(
  { statement, sourceFile, placement, flow, signature, typeScript }: ExtractionPlan,
  ending: string,
): string | undefined {
  const { method, container } = placement;
  const { returned, built } = flow;
  const { name, parameters, step } = signature;
  const text = sourceFile.text;
  const newline = newlineOf(text);
  const outerIndentation = indentationAt(text, container.getStart(sourceFile));
  const header = `${outerIndentation}${methodKeyword(method, typeScript)}${name}(${parameters.join(', ')}) {`;
  const declarationStatement = built?.declarationStatement;
  if (declarationStatement && (!ownsLines(declarationStatement) || hasMultilineLiteral(declarationStatement))) return;
  const body = movedLines(statement, sourceFile, outerIndentation + step, declarationStatement);
  if (!body || header.length > maxSignatureLength) return;
  const returnedName = built ? built.variable.symbol.name : returned?.symbol.name;
  const returnLine = returnedName ? `${newline}${outerIndentation}${step}return ${returnedName}${ending}` : '';
  return `${newline}${newline}${header}${newline}${body.join('\n')}${returnLine}${newline}${outerIndentation}}`;
}

// The line that replaces the statement with a call to the new function.
function callLineText(
  { statement, sourceFile, placement, flow, signature }: ExtractionPlan,
  ending: string,
): string | undefined {
  const { returned, built, variables } = flow;
  const indentation = indentationAt(sourceFile.text, statement.getStart(sourceFile));
  const callee = (placement.method ? 'this.' : '') + signature.name;
  const assignment = built ? `const ${built.variable.symbol.name} = ` : returned ? `${returned.symbol.name} = ` : '';
  const call = `${assignment}${callee}(${variables.map((variable) => variable.symbol.name).join(', ')})${ending}`;
  if (indentation.length + call.length > maxSignatureLength) return;
  return indentation + call;
}

function extractionEdits(plan: ExtractionPlan): TextEdit[] | undefined {
  const { statement, sourceFile, placement, flow } = plan;
  const ending = statementEnding(plan);
  if (ending === undefined) return;
  const declaration = helperDeclarationText(plan, ending);
  const callLine = callLineText(plan, ending);
  if (!declaration || !callLine) return;
  const start = lineStart(sourceFile.text, (flow.built?.declarationStatement ?? statement).getStart(sourceFile));
  return [
    { start, end: statement.end, text: callLine },
    { start: placement.container.end, end: placement.container.end, text: declaration },
  ];
}

// The edits that move `statement` out of `fn` into a named function: the call in its place and the
// declaration after the enclosing member or top-level statement, with `typeChecks()` to run once
// the edits are wanted, since it checks the whole rewritten file. Undefined when it would not run
// the same code.
function extractionDraft(
  statement: Statement,
  fn: FunctionWithBody,
  sourceFile: SourceFile,
): ExtractionDraft | undefined {
  const plan = extractionPlan(statement, fn, sourceFile);
  const edits = plan && extractionEdits(plan);
  if (!edits || !fitsHunks(sourceFile, edits)) return;
  const typeChecks = () => !plan.typeScript || typeChecksAsBefore(sourceFile, applyEdits(sourceFile.text, edits));
  return { name: plan.signature.name, edits, typeChecks };
}

// Like extractionDraft, but also undefined when the rewritten file would not type-check the same.
function extractionEdit(
  statement: Statement,
  fn: FunctionWithBody,
  sourceFile: SourceFile,
): Pick<ExtractionDraft, 'name' | 'edits'> | undefined {
  const draft = extractionDraft(statement, fn, sourceFile);
  if (draft?.typeChecks()) return { name: draft.name, edits: draft.edits };
}

// --- Measuring the rewritten file with the checker itself ---

// Whether site-fix would print every hunk of `edits` within its line limit.
function fitsHunks(sourceFile: SourceFile, edits: readonly TextEdit[]): boolean {
  const text = sourceFile.text;
  const row = (offset: number) => sourceFile.getLineAndCharacterOfPosition(offset).line;
  const groups: EditGroup[] = [];
  for (const edit of [...edits].sort((left, right) => left.start - right.start)) {
    const first = row(edit.start);
    const last = row(Math.max(edit.start, edit.end - 1));
    const group = groups.at(-1);
    if (group && first - group.last <= hunkJoinDistance) {
      group.edits.push(edit);
      group.last = Math.max(group.last, last);
    } else groups.push({ first, last, edits: [edit] });
  }
  return groups.every((group) => {
    const start = sourceFile.getPositionOfLineAndCharacter(group.first, 0);
    const before = text.slice(start, lineEnd(text, sourceFile.getPositionOfLineAndCharacter(group.last, 0)));
    const shifted = group.edits.map((edit) => ({ ...edit, start: edit.start - start, end: edit.end - start }));
    const after = applyEdits(before, shifted);
    return before.split('\n').length <= maxHunkLines && after.split('\n').length <= maxHunkLines;
  });
}

// The same node as innermostNodeAt, without visiting subtrees that end before the offset: a finding
// is looked up for every function of the file, on every candidate.
function nodeAt(sourceFile: SourceFile, offset: number): Node | undefined {
  let found: Node | undefined;
  (function descend(node: Node): void {
    if (node.getStart(sourceFile) > offset || offset >= node.end) return;
    found = node;
    ts.forEachChild(node, (child) => {
      if (child.pos > offset || offset >= child.end) return;
      descend(child);
      return true;
    });
  })(sourceFile);
  return found;
}

// The function a finding belongs to: the one it names, or the one whose body holds the reported
// statement.
function ownerOf(sourceFile: SourceFile, finding: Finding): FunctionWithBody | undefined {
  if (finding.line === undefined || finding.column === undefined) return;
  const offset = sourceFile.getPositionOfLineAndCharacter(finding.line - 1, finding.column - 1);
  const node = nodeAt(sourceFile, offset);
  if (!node) return;
  const named = flaggedFunction(node);
  if (named) return named;
  for (let current: Node | undefined = node.parent; current; current = current.parent)
    if (functionWithBody(current)) return current;
}

// Where each finding's function starts (-1 for none). The findings of one parsed file are measured
// once per candidate.
const ownerStarts = new WeakMap<Finding, number>();
function ownerStartOf(sourceFile: SourceFile, finding: Finding): number {
  let start = ownerStarts.get(finding);
  if (start === undefined) {
    start = ownerOf(sourceFile, finding)?.getStart(sourceFile) ?? -1;
    ownerStarts.set(finding, start);
  }
  return start;
}

// The value the checker reports for `ruleId` on the function starting at `functionStart` (0 when it
// is under the threshold), and how many other functions in the file the rule reports.
function measure(
  sourceFile: SourceFile,
  findings: readonly Finding[],
  functionStart: number,
  ruleId: string,
): { value: number; others: number } {
  let value = 0;
  let others = 0;
  for (const finding of findings) {
    if (finding.ruleId !== ruleId) continue;
    if (ownerStartOf(sourceFile, finding) === functionStart) value = Number(/\d+/.exec(finding.message)?.[0]);
    else others++;
  }
  return { value, others };
}

// Every candidate gets a fresh measurement. Candidates from one parsed source share its original
// findings.
const originalFindings = new WeakMap<SourceFile, readonly Finding[]>();
function measuredEdits(sourceFile: SourceFile, fn: Node, ruleId: string, edits: TextEdit[]): MeasuredEdits {
  const start = fn.getStart(sourceFile);
  let original = originalFindings.get(sourceFile);
  if (!original) {
    original = analyzeFunctions(sourceFile, sourceFile.fileName);
    originalFindings.set(sourceFile, original);
  }
  const before = measure(sourceFile, original, start, ruleId);
  const rewritten = ts.createSourceFile(
    sourceFile.fileName,
    applyEdits(sourceFile.text, edits),
    ts.ScriptTarget.Latest,
    true,
  );
  const after = measure(rewritten, analyzeFunctions(rewritten, rewritten.fileName), start, ruleId);
  return { before: before.value, after: after.value, contained: after.others <= before.others };
}

// Statements of `fn` that run as part of its own body, outermost first.
function ownStatements(fn: FunctionWithBody): Statement[] {
  const statements: Statement[] = [];
  forOwnNodes(fn.body, (node: Node) => {
    if (node !== fn.body && functionWithBody(node)) return false;
    if (ts.isStatement(node) && ts.isBlock(node.parent) && node.parent !== node) statements.push(node);
  });
  return statements;
}

// Decisions the checker counts inside `statement` for its own function.
function decisionCount(statement: Statement): number {
  let count = 0;
  forOwnNodes(statement, (node: Node) => {
    if (node !== statement && functionWithBody(node)) return false;
    if (
      ts.isIfStatement(node) ||
      ts.isIterationStatement(node, false) ||
      ts.isSwitchStatement(node) ||
      ts.isCatchClause(node) ||
      ts.isConditionalExpression(node)
    )
      count++;
  });
  return count;
}

export { extractionDraft, extractionEdit, fitsHunks, measuredEdits, ownStatements, decisionCount, originalProgram };
