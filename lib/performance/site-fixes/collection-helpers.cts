// Helpers shared by the collection site fixes: where a lookup can be built, and whether the array it
// reads is only read afterwards.
import {
  ts,
  textOf,
  ancestor,
  enclosingStatement,
  enclosingIteration,
  indentationAt,
  insertLinesBefore,
} from './helpers.cjs';
import { startsOwnLine } from './hoisting.cjs';
import type {
  ArrowFunction,
  BindingName,
  Identifier,
  ImportDeclaration,
  Node,
  SignatureDeclaration,
  SourceFile,
  Statement,
} from 'typescript';
import type { Placement } from '../types/lookup-placement.cjs';

export const typeScriptFile = /\.[cm]?tsx?$/;
export const readOnlyArrayMembers = new Set(['length', 'includes', 'indexOf', 'at', 'join']);
// Array members that never change the array they are called on.
const nonMutatingMembers = new Set([
  ...readOnlyArrayMembers,
  'lastIndexOf',
  'map',
  'filter',
  'some',
  'every',
  'find',
  'findIndex',
  'findLast',
  'findLastIndex',
  'forEach',
  'reduce',
  'reduceRight',
  'slice',
  'concat',
  'flat',
  'flatMap',
  'entries',
  'keys',
  'values',
  'toSorted',
  'toReversed',
  'toSpliced',
  'with',
]);
export const arrayCopyIndent = '  ';

export function skipParentheses(node: Node): Node {
  let current = node;
  while (ts.isParenthesizedExpression(current)) current = current.expression;
  return current;
}

export function outerParenthesized(node: Node): Node {
  let current = node;
  while (ts.isParenthesizedExpression(current.parent)) current = current.parent;
  return current;
}

export function nearestFunctionOrFile(node: Node): SignatureDeclaration | SourceFile | undefined {
  return ancestor(
    node.parent,
    (current): current is SignatureDeclaration | SourceFile => ts.isFunctionLike(current) || ts.isSourceFile(current),
  );
}

export function bindingNames(name: BindingName, names: string[] = []): string[] {
  if (ts.isIdentifier(name)) names.push(name.text);
  else for (const element of name.elements) if (!ts.isOmittedExpression(element)) bindingNames(element.name, names);
  return names;
}

export function bindsName(identifier: Identifier): boolean {
  const { parent } = identifier;
  return (
    ((ts.isVariableDeclaration(parent) ||
      ts.isParameter(parent) ||
      ts.isBindingElement(parent) ||
      ts.isFunctionLike(parent) ||
      ts.isClassLike(parent) ||
      ts.isImportSpecifier(parent)) &&
      parent.name === identifier) ||
    ts.isNamespaceImport(parent) ||
    ts.isImportClause(parent)
  );
}

export function declaresNameWithin(node: Node, name: string): boolean {
  let declared = false;
  (function visit(current: Node): void {
    if (declared) return;
    if (ts.isIdentifier(current) && current.text === name && bindsName(current)) declared = true;
    else ts.forEachChild(current, visit);
  })(node);
  return declared;
}

function importedNames(statement: ImportDeclaration): string[] {
  const clause = statement.importClause;
  if (!clause) return [];
  const names: string[] = [];
  if (clause.name) names.push(clause.name.text);
  const bindings = clause.namedBindings;
  if (bindings && ts.isNamespaceImport(bindings)) names.push(bindings.name.text);
  else if (bindings) for (const specifier of bindings.elements) names.push(specifier.name.text);
  return names;
}

// Whether `name` resolves, at `statement`, to a binding that is safe to read earlier: a parameter,
// import, function, or `const` declared before the statement. Anything else (let, var, class, loop
// variables) is refused. Undefined lets the caller continue looking in the enclosing scope.
function bindingInStatements(statements: readonly Statement[], name: string, child: Node): boolean | undefined {
  for (const candidate of statements) {
    if (ts.isVariableStatement(candidate)) {
      const declares = candidate.declarationList.declarations.some((declaration) =>
        bindingNames(declaration.name).includes(name),
      );
      if (!declares) continue;
      return Boolean(candidate.declarationList.flags & ts.NodeFlags.Const) && candidate.end <= child.getStart();
    }
    if (ts.isFunctionDeclaration(candidate) && candidate.name?.text === name) return true;
    if (ts.isClassDeclaration(candidate) && candidate.name?.text === name) return false;
    if (ts.isImportDeclaration(candidate) && importedNames(candidate).includes(name)) return true;
  }
}

function boundBefore(statement: Statement, name: string): boolean {
  let child: Node = statement;
  for (let scope = statement.parent; scope; child = scope, scope = scope.parent) {
    if (ts.isBlock(scope) || ts.isSourceFile(scope) || ts.isModuleBlock(scope)) {
      const available = bindingInStatements(scope.statements, name, child);
      if (available !== undefined) return available;
    } else if (ts.isFunctionLike(scope)) {
      if (scope.parameters.some((parameter) => bindingNames(parameter.name).includes(name))) return true;
    } else if (
      (ts.isForStatement(scope) || ts.isForOfStatement(scope) || ts.isForInStatement(scope)) &&
      scope.initializer &&
      ts.isVariableDeclarationList(scope.initializer) &&
      scope.initializer.declarations.some((declaration) => bindingNames(declaration.name).includes(name))
    ) {
      return false;
    } else if (ts.isCatchClause(scope) && scope.variableDeclaration) {
      if (bindingNames(scope.variableDeclaration.name).includes(name)) return false;
    }
  }
  return false;
}

// A callback of map/filter/some/... runs synchronously inside the statement that iterates.
function isIterationCallback(fn: SignatureDeclaration): boolean {
  const body = 'body' in fn ? fn.body : undefined;
  if (!body) return false;
  const iteration = enclosingIteration(body);
  return iteration?.kind === 'callback' && iteration.callback === fn;
}

export function statementPlacement(statement: Statement, name: string): Placement | undefined {
  if (!startsOwnLine(statement) || declaresNameWithin(statement, name) || !boundBefore(statement, name)) return;
  return {
    region: statement,
    indentation: indentationAt(statement.getSourceFile().text, statement.getStart()),
    edits: (...lines: string[]) => [insertLinesBefore(statement, lines)],
  };
}

// An expression-bodied arrow function gets a block body that builds the lookup first and returns
// the expression.
function arrowPlacement(arrow: ArrowFunction, name: string): Placement | undefined {
  const { body } = arrow;
  const sourceFile = arrow.getSourceFile();
  const text = sourceFile.text;
  if (declaresNameWithin(body, name)) return;
  if (!arrow.parameters.some((parameter) => bindingNames(parameter.name).includes(name))) {
    const statement = enclosingStatement(arrow);
    if (!statement || declaresNameWithin(statement, name) || !boundBefore(statement, name)) return;
  }
  const arrowToken = arrow.equalsGreaterThanToken;
  const bodyStart = body.getStart(sourceFile);
  const gap = text.slice(arrowToken.end, bodyStart);
  if (gap.trim()) return;
  // A multi-line body that starts after `=>` would sit under-indented behind `return`.
  const bodyOnOwnLine = gap.includes('\n');
  if (!bodyOnOwnLine && text.slice(bodyStart, body.end).includes('\n')) return;
  const outer = indentationAt(text, arrowToken.getStart(sourceFile));
  const inner = bodyOnOwnLine ? indentationAt(text, bodyStart) : outer + arrayCopyIndent;
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  return {
    region: body,
    indentation: inner,
    edits: (...lines: string[]) => [
      {
        start: arrowToken.end,
        end: bodyStart,
        text: ` {${eol}${inner}${lines.join(eol + inner)}${eol}${inner}return `,
      },
      { start: body.end, end: body.end, text: `;${eol}${outer}}` },
    ],
  };
}

// Where a lookup of `name` can be built once for the iteration holding `node`: before the statement
// running the iteration, crossing only synchronous iteration callbacks, or at the top of an
// expression-bodied arrow function. Returns { region, indentation, edits(...lines) } where `region`
// is the code that now runs after the lookup is built.
export function hoistPlacement(node: Node, name: string): Placement | undefined {
  const iteration = enclosingIteration(node);
  if (!iteration) return;
  const iterationNode = iteration.node;
  if (
    (ts.isForOfStatement(iterationNode) || ts.isForInStatement(iterationNode)) &&
    !ancestor(node, (current) => current === iterationNode.statement)
  )
    return;
  for (let current: Node = iterationNode; current; current = current.parent) {
    if (ts.isClassLike(current)) return;
    if (ts.isStatement(current) && (ts.isBlock(current.parent) || ts.isSourceFile(current.parent)))
      return statementPlacement(current, name);
    if (ts.isFunctionLike(current) && !isIterationCallback(current))
      return ts.isArrowFunction(current) && !ts.isBlock(current.body) ? arrowPlacement(current, name) : undefined;
  }
}

// Like hoistPlacement, then keeps moving out through enclosing iterations that never reassign or
// mutate `source` (rooted at `rootName`), so a nested loop builds the lookup once instead of once
// per outer item.
export function outermostPlacement(node: Node, rootName: string, source: string): Placement | undefined {
  let placement = hoistPlacement(node, rootName);
  while (placement) {
    const outer = hoistPlacement(placement.region, rootName);
    if (!outer || !onlyReadOnlyMembers(outer.region, rootName, source)) return placement;
    placement = outer;
  }
}

// The identifier at the root of `a` or `a.b.c` without optional chaining, calls or element access.
export function plainChainRoot(node: Node): Identifier | undefined {
  if (ts.isIdentifier(node)) return node;
  if (ts.isPropertyAccessExpression(node) && !node.questionDotToken) return plainChainRoot(node.expression);
}

export function isAssignmentTarget(node: Node): boolean {
  const { parent } = node;
  if (ts.isBinaryExpression(parent) && parent.left === node) {
    const operator = parent.operatorToken.kind;
    return operator >= ts.SyntaxKind.FirstAssignment && operator <= ts.SyntaxKind.LastAssignment;
  }
  return (ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)) && parent.operand === node;
}

// Whether every use of `rootName` in `region` reads exactly `chainText` (such as
// `actor.permissions`), so reading that chain earlier cannot skip a guard like `existing && ...`
// written in the region.
export function onlyReadThroughChain(region: Node, rootName: string, chainText: string): boolean {
  let safe = true;
  (function visit(current: Node): void {
    if (!safe) return;
    const { parent } = current;
    const isName = ts.isPropertyAccessExpression(parent) && parent.name === current;
    if (ts.isIdentifier(current) && current.text === rootName && !isName) {
      let chain: Node = current;
      while (textOf(chain) !== chainText && ts.isPropertyAccessExpression(chain.parent)) chain = chain.parent;
      if (textOf(chain) !== chainText || isAssignmentTarget(chain)) safe = false;
    } else ts.forEachChild(current, visit);
  })(region);
  return safe;
}

// A bare read of the chain root that only tests it, such as `existing && ...`, `!existing` or `if
// (existing)`.
function isTruthinessTest(identifier: Identifier): boolean {
  const node = outerParenthesized(identifier);
  const { parent } = node;
  if (ts.isBinaryExpression(parent)) {
    const operator = parent.operatorToken.kind;
    const isLogical = operator === ts.SyntaxKind.AmpersandAmpersandToken || operator === ts.SyntaxKind.BarBarToken;
    return parent.left === node && isLogical;
  }
  if (ts.isPrefixUnaryExpression(parent)) return parent.operator === ts.SyntaxKind.ExclamationToken;
  if (ts.isConditionalExpression(parent)) return parent.condition === node;
  return (ts.isIfStatement(parent) || ts.isWhileStatement(parent)) && parent.expression === node;
}

// Whether every use of `rootName` in `region` reads `chainText` or only tests the root, as in
// `existing && existing.items.includes(x)`. The lookup then reads the chain with `?.` so a missing
// root is no error.
export function onlyGuardedChainReads(region: Node, rootName: string, chainText: string): boolean {
  let safe = true;
  (function visit(current: Node): void {
    if (!safe) return;
    const { parent } = current;
    const isName = ts.isPropertyAccessExpression(parent) && parent.name === current;
    if (ts.isIdentifier(current) && current.text === rootName && !isName) {
      if (isTruthinessTest(current)) return;
      let chain: Node = current;
      while (textOf(chain) !== chainText && ts.isPropertyAccessExpression(chain.parent)) chain = chain.parent;
      if (textOf(chain) !== chainText || isAssignmentTarget(chain)) safe = false;
    } else ts.forEachChild(current, visit);
  })(region);
  return safe;
}

// Whether every use of `rootName` in `region` reads `chainText` through a non-mutating array member
// such as
// `.includes()` or `.filter()`, or spreads it into a new array, so the array cannot change between
// the lookups.
export function onlyReadOnlyMembers(region: Node, rootName: string, chainText: string): boolean {
  let safe = true;
  (function visit(current: Node): void {
    if (!safe) return;
    const { parent } = current;
    const isName = ts.isPropertyAccessExpression(parent) && parent.name === current;
    if (ts.isIdentifier(current) && current.text === rootName && !isName) {
      let chain: Node = current;
      while (textOf(chain) !== chainText && ts.isPropertyAccessExpression(chain.parent)) chain = chain.parent;
      const member = chain.parent;
      const readsMember =
        ts.isPropertyAccessExpression(member) &&
        member.expression === chain &&
        nonMutatingMembers.has(member.name.text);
      const spreadsCopy = ts.isSpreadElement(member) && ts.isArrayLiteralExpression(member.parent);
      if (textOf(chain) !== chainText || !(readsMember || spreadsCopy)) safe = false;
    } else ts.forEachChild(current, visit);
  })(region);
  return safe;
}

export function mentionsName(node: Node, name: string): boolean {
  let found = false;
  (function visit(current: Node): void {
    if (found) return;
    if (ts.isIdentifier(current) && current.text === name) found = true;
    else ts.forEachChild(current, visit);
  })(node);
  return found;
}

export function capitalize(text: string): string {
  return text[0].toUpperCase() + text.slice(1);
}
