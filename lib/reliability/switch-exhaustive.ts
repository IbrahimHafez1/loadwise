// A `switch` over a union of string or number literals, or over an enum, that names only some members and has no
// `default`. The rule fires only where the gap shows: the function falls off its end after returning a value in other
// branches, or a variable declared without a value is read after the switch. Elsewhere a missing case may be meant.
import { ts } from '../performance/compiler.js';
import { walkNodes } from './walk.js';
import { isIgnoredSource } from './source-helpers.js';
import type {
  BinaryExpression,
  Block,
  CaseOrDefaultClause,
  Expression,
  Identifier,
  Node,
  SourceFile,
  SwitchStatement,
  TryStatement,
} from 'typescript';
import type { CheckerAdapter, Finding, TypeAdapter } from '../shared/types.js';

const minimumLiteralMembers = 2;
const emptinessFlags = ts.TypeFlags.Undefined | ts.TypeFlags.Null;
const literalFlags = ts.TypeFlags.StringLiteral | ts.TypeFlags.NumberLiteral;
const emptyValueFlags = ts.TypeFlags.Void | ts.TypeFlags.Undefined | ts.TypeFlags.Never;

interface LiteralMember {
  key: string;
  label: string;
}

function literalMember(type: TypeAdapter): LiteralMember | undefined {
  if (!(type.flags & literalFlags) || (typeof type.value !== 'string' && typeof type.value !== 'number')) return;
  return { key: `${typeof type.value}:${type.value}`, label: JSON.stringify(type.value) };
}

// The members of the switched value, or undefined when the type is not a plain union of string or number literals
// (so booleans, bigints and mixed object unions are left alone).
function literalMembers(type: TypeAdapter): LiteralMember[] | undefined {
  if (!type.isUnion() || !type.types) return;
  const members: LiteralMember[] = [];
  for (const member of type.types) {
    if (member.flags & emptinessFlags) continue;
    const literal = literalMember(member);
    if (!literal) return;
    members.push(literal);
  }
  return members.length >= minimumLiteralMembers ? members : undefined;
}

function coveredKeys(statement: SwitchStatement, checker: CheckerAdapter): Set<string> | undefined {
  const covered = new Set<string>();
  for (const clause of statement.caseBlock.clauses) {
    if (!ts.isCaseClause(clause)) return;
    const caseType = checker.getTypeAtLocation(clause.expression);
    // `case null` and `case undefined` name no string or number member, so they cover none of them.
    if (caseType.flags & emptinessFlags) continue;
    const literal = literalMember(caseType);
    // A case that is not a literal (a variable, a call) could cover anything.
    if (!literal) return;
    covered.add(literal.key);
  }
  return covered;
}

function statementsOf(clauses: readonly CaseOrDefaultClause[]): Node[] {
  return clauses.flatMap((clause) => [...clause.statements]);
}

// A returned value that is itself void, undefined or never (a call to a `Promise<void>` helper or one that always throws)
// makes the fall-off harmless. `null` is a real value, so falling off the end instead of returning it is a gap.
function returnsValueWithin(root: Node, checker: CheckerAdapter): boolean {
  let found = false;
  const visit = (node: Node): void => {
    if (found || ts.isFunctionLike(node) || ts.isClassLike(node)) return;
    if (ts.isReturnStatement(node) && node.expression) found = !isEmptyValue(node.expression, checker);
    else ts.forEachChild(node, visit);
  };
  ts.forEachChild(root, visit);
  return found;
}

const undefinedAdmittingFlags = ts.TypeFlags.Undefined | ts.TypeFlags.Unknown;

function unionAdmitsUndefined(type: TypeAdapter): boolean {
  return type.isUnion() && (type.types ?? []).some((member) => (member.flags & ts.TypeFlags.Undefined) !== 0);
}

// Only an async function unwraps a returned promise; a plain function hands the promise itself to its caller.
function isInsideAsyncFunction(node: Node): boolean {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isFunctionLike(current)) {
      return (
        ts.canHaveModifiers(current) &&
        !!ts.getModifiers(current)?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)
      );
    }
  }
  return false;
}

function isEmptyValue(expression: Expression, checker: CheckerAdapter): boolean {
  const type = checker.getTypeAtLocation(expression);
  const awaited = isInsideAsyncFunction(expression) ? (checker.getAwaitedType(type) ?? type) : type;
  return (awaited.flags & emptyValueFlags) !== 0;
}

function enclosingFunctionBody(node: Node): Block | undefined {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isFunctionLike(current))
      return 'body' in current && current.body && ts.isBlock(current.body) ? current.body : undefined;
  }
}

// A `finally` block that always returns or throws replaces whatever the try and catch blocks did.
function finallyAlwaysExits(statement: TryStatement): boolean {
  return (statement.finallyBlock?.statements ?? []).some(
    (inner) => ts.isReturnStatement(inner) || ts.isThrowStatement(inner),
  );
}

// Whether nothing runs after the statement before the function ends: it closes its block, or the branch or try block
// that does.
function endsFunctionBody(statement: Node, body: Block): boolean {
  let current: Node = statement;
  while (current !== body) {
    const parent: Node = current.parent;
    if (ts.isBlock(parent) && parent.statements.at(-1) !== current) return false;
    if (ts.isTryStatement(parent) && (parent.finallyBlock === current || finallyAlwaysExits(parent))) return false;
    const passesThrough =
      ts.isBlock(parent) || ts.isIfStatement(parent) || ts.isTryStatement(parent) || ts.isCatchClause(parent);
    if (!passesThrough) return false;
    current = parent;
  }
  return true;
}

// The switch can be the last thing the function runs, so a value that matches no case leaves the function without a
// return value.
function fallsOffFunctionEnd(statement: SwitchStatement, checker: CheckerAdapter): boolean {
  const body = enclosingFunctionBody(statement);
  return body !== undefined && endsFunctionBody(statement, body) && returnsValueWithin(statement, checker);
}

function isPlainAssignment(node: Node): node is BinaryExpression {
  return ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken;
}

// The variable declarations an assignment target writes, including those inside destructuring patterns.
function assignedDeclarations(target: Node, checker: CheckerAdapter): Node[] {
  if (ts.isIdentifier(target)) {
    const declaration = checker.getSymbolAtLocation(target)?.valueDeclaration;
    return declaration ? [declaration] : [];
  }
  if (ts.isShorthandPropertyAssignment(target)) {
    const declaration = checker.getShorthandAssignmentValueSymbol(target)?.valueDeclaration;
    return declaration ? [declaration] : [];
  }
  if (ts.isPropertyAssignment(target)) return assignedDeclarations(target.initializer, checker);
  if (ts.isSpreadAssignment(target) || ts.isSpreadElement(target))
    return assignedDeclarations(target.expression, checker);
  if (isPlainAssignment(target)) return assignedDeclarations(target.left, checker);
  if (ts.isObjectLiteralExpression(target))
    return target.properties.flatMap((property) => assignedDeclarations(property, checker));
  if (ts.isArrayLiteralExpression(target))
    return target.elements.flatMap((element) => assignedDeclarations(element, checker));
  return [];
}

function isWithin(node: Node, container: Node): boolean {
  return node.pos >= container.pos && node.end <= container.end;
}

function assignedWithin(statement: SwitchStatement, checker: CheckerAdapter): Set<Node> {
  const declarations = new Set<Node>();
  walkNodes(statement.caseBlock, (node) => {
    if (!isPlainAssignment(node)) return;
    for (const declaration of assignedDeclarations(node.left, checker)) declarations.add(declaration);
  });
  return declarations;
}

const conditionalFlowKinds = new Set([
  ts.SyntaxKind.IfStatement,
  ts.SyntaxKind.ConditionalExpression,
  ts.SyntaxKind.ForStatement,
  ts.SyntaxKind.ForInStatement,
  ts.SyntaxKind.ForOfStatement,
  ts.SyntaxKind.WhileStatement,
  ts.SyntaxKind.DoStatement,
  ts.SyntaxKind.CaseClause,
  ts.SyntaxKind.DefaultClause,
  ts.SyntaxKind.TryStatement,
  ts.SyntaxKind.CatchClause,
]);
const shortCircuitOperators = new Set([
  ts.SyntaxKind.AmpersandAmpersandToken,
  ts.SyntaxKind.BarBarToken,
  ts.SyntaxKind.QuestionQuestionToken,
]);

// The condition of an `if` or a ternary is evaluated on every path; only its branches are conditional.
function isConditionOf(statement: Node, child: Node): boolean {
  if (ts.isIfStatement(statement)) return statement.expression === child;
  return ts.isConditionalExpression(statement) && statement.condition === child;
}

// Whether the node runs on every path through the function body: not behind a branch, a loop, a short-circuit or a nested
// function that may never be called.
function runsUnconditionally(node: Node, body: Block): boolean {
  for (let current = node; current !== body; current = current.parent) {
    const parent = current.parent;
    if (ts.isFunctionLike(parent) || ts.isClassLike(parent)) return false;
    if (conditionalFlowKinds.has(parent.kind) && !isConditionOf(parent, current)) return false;
    if (
      ts.isBinaryExpression(parent) &&
      parent.right === current &&
      shortCircuitOperators.has(parent.operatorToken.kind)
    )
      return false;
  }
  return true;
}

function isAssignmentTarget(identifier: Node): boolean {
  const parent = identifier.parent;
  return isPlainAssignment(parent) && parent.left === identifier;
}

// The declaration a read of the identifier resolves to. A declaration's own name is not a read, and a shorthand
// `{ value }` reads the variable `value` unless it sits in a destructuring target such as `({ value } = box)`.
function readDeclaration(identifier: Identifier, checker: CheckerAdapter): Node | undefined {
  const parent = identifier.parent;
  if (ts.isVariableDeclaration(parent) && parent.name === identifier) return;
  if (ts.isShorthandPropertyAssignment(parent) && parent.name === identifier) {
    const isDestructuringTarget = ts.findAncestor(
      parent,
      (ancestor) => isPlainAssignment(ancestor) && isWithin(parent, ancestor.left),
    );
    return isDestructuringTarget ? undefined : checker.getShorthandAssignmentValueSymbol(parent)?.valueDeclaration;
  }
  return checker.getSymbolAtLocation(identifier)?.valueDeclaration;
}

// Whether the declaration has no value of its own, no assignment outside the switch can supply one, and the code after
// the switch reads it.
function leavesUnsetValueRead(
  declaration: Node,
  statement: SwitchStatement,
  body: Block,
  checker: CheckerAdapter,
): boolean {
  if (!ts.isVariableDeclaration(declaration) || !ts.isIdentifier(declaration.name) || declaration.initializer) {
    return false;
  }
  if (!isWithin(declaration, body)) return false;
  // A type that admits undefined says the code already handles the unset case.
  const declaredType = checker.getTypeAtLocation(declaration.name);
  if ((declaredType.flags & undefinedAdmittingFlags) !== 0 || unionAdmitsUndefined(declaredType)) return false;
  let assignedElsewhere = false;
  let readAfter = false;
  walkNodes(body, (node) => {
    if (isPlainAssignment(node) && !isWithin(node, statement.caseBlock) && runsUnconditionally(node, body)) {
      assignedElsewhere = assignedElsewhere || assignedDeclarations(node.left, checker).includes(declaration);
    }
    if (!ts.isIdentifier(node) || node.getStart() < statement.end || isAssignmentTarget(node)) return;
    // `typeof value` in a type position names the variable without reading it.
    if (ts.findAncestor(node, ts.isTypeQueryNode)) return;
    readAfter = readAfter || (readDeclaration(node, checker) === declaration && runsUnconditionally(node, body));
  });
  return readAfter && !assignedElsewhere;
}

function leavesVariableUnset(statement: SwitchStatement, checker: CheckerAdapter): boolean {
  const body = enclosingFunctionBody(statement);
  if (!body) return false;
  for (const declaration of assignedWithin(statement, checker)) {
    if (leavesUnsetValueRead(declaration, statement, body, checker)) return true;
  }
  return false;
}

function checkSwitch(
  statement: SwitchStatement,
  sourceFile: SourceFile,
  file: string,
  checker: CheckerAdapter,
): Finding | undefined {
  if (statement.caseBlock.clauses.some(ts.isDefaultClause)) return;
  const members = literalMembers(checker.getTypeAtLocation(statement.expression));
  const covered = members && coveredKeys(statement, checker);
  if (!members || !covered || statementsOf(statement.caseBlock.clauses).length === 0) return;
  const missing = members.filter((member) => !covered.has(member.key));
  if (missing.length === 0) return;
  if (!fallsOffFunctionEnd(statement, checker) && !leavesVariableUnset(statement, checker)) return;
  const position = sourceFile.getLineAndCharacterOfPosition(statement.getStart(sourceFile));
  return {
    file,
    line: position.line + 1,
    column: position.character + 1,
    ruleId: 'switch-not-exhaustive',
    message: `This switch has no case for ${missing.map((member) => member.label).join(', ')} and no default, so that value leaves the result undefined. Add the missing cases, or a default that throws.`,
  };
}

function checkSwitchExhaustive(sourceFile: SourceFile, file: string, checker: CheckerAdapter): Finding[] {
  if (!sourceFile.text.includes('switch') || isIgnoredSource(sourceFile, file)) return [];
  const findings: Finding[] = [];
  walkNodes(sourceFile, (node) => {
    if (!ts.isSwitchStatement(node)) return;
    const finding = checkSwitch(node, sourceFile, file, checker);
    if (finding) findings.push(finding);
  });
  return findings;
}

export { checkSwitchExhaustive };
