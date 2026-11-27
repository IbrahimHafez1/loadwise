import { ts, functionWithBody } from './helpers.js';
import { bindingList, contains, isAssignment, isIncrement, symbolOf } from './extract-block-ast.js';
import type { Expression, Identifier, Node, Statement, Symbol, TypeChecker } from 'typescript';
import type { BuiltCollection, DataFlow, FreeVariable } from '../types/extract-block.js';

const maxParameters = 4;
// Types that cannot be written back as they are, or that hide what the code expects.
const unprintableType = /\bany\b|import\(|\.\.\./;
// A parameter typed like this would not give the block what the original site had: an empty object
// type has no members, and unknown (a caught error, or a type behind an unresolved import) cannot
// be read without the narrowing that was left behind. Comparing diagnostics alone misses this when
// the file already reports the same message elsewhere.
const uselessParameterType = /^(\{\s*\}|unknown|never|object|Object)$/;
const typeFormat = ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope;

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

// `node` runs inside a function that does not hold `declaration`, so it may run at another time.
function insideClosure(node: Node, declaration: Node): boolean {
  for (let current: Node | undefined = node.parent; current; current = current.parent) {
    if (contains(current, declaration)) return false;
    if (functionWithBody(current)) return true;
  }
  return false;
}

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

// `name: Type` for each parameter, or undefined when a type cannot be written down.
export function typedParameters(
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

// What the new function receives and gives back: the variables it reads, plus either the one it
// assigns that later code uses or the collection it builds. Undefined when the statement is too
// entangled with its surroundings.
export function dataFlowOf(statement: Statement, container: Node, checker: TypeChecker): DataFlow | undefined {
  const allVariables = freeVariables(statement, container, checker);
  if (!allVariables) return;
  const returned = returnedVariable(statement, container, allVariables);
  if (returned === undefined) return;
  const built = returned ? undefined : builtCollection(statement, allVariables, checker);
  const variables = allVariables.filter((variable) => variable !== built?.variable);
  if (variables.length > maxParameters) return;
  return { returned, built, variables };
}
