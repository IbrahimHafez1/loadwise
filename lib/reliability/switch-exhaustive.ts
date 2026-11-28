// A `switch` over a union of string or number literals, or over an enum, that names only some members and has no
// `default`. The rule fires only where the gap shows: the function falls off its end after returning a value in other
// branches, or a variable declared without a value is read after the switch. Elsewhere a missing case may be meant.
import { ts } from '../performance/compiler.js';
import { walkNodes } from './walk.js';
import { isIgnoredSource } from './source-helpers.js';
import type { Block, CaseOrDefaultClause, Expression, Node, SourceFile, SwitchStatement } from 'typescript';
import type { CheckerAdapter, Finding, TypeAdapter } from '../shared/types.js';

const minimumLiteralMembers = 2;
const emptinessFlags = ts.TypeFlags.Undefined | ts.TypeFlags.Null;
const literalFlags = ts.TypeFlags.StringLiteral | ts.TypeFlags.NumberLiteral;
const emptyValueFlags = ts.TypeFlags.Void | ts.TypeFlags.Undefined | ts.TypeFlags.Null;

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
    const literal = literalMember(checker.getTypeAtLocation(clause.expression));
    // A case that is not a literal (a variable, a call) could cover anything.
    if (!literal) return;
    covered.add(literal.key);
  }
  return covered;
}

function statementsOf(clauses: readonly CaseOrDefaultClause[]): Node[] {
  return clauses.flatMap((clause) => [...clause.statements]);
}

// A returned value that is itself void or undefined (a call to a `Promise<void>` helper) makes the fall-off harmless.
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

function unionAdmitsUndefined(type: TypeAdapter): boolean {
  return type.isUnion() && (type.types ?? []).some((member) => (member.flags & ts.TypeFlags.Undefined) !== 0);
}

function isEmptyValue(expression: Expression, checker: CheckerAdapter): boolean {
  const type = checker.getTypeAtLocation(expression);
  const awaited = checker.getAwaitedType(type) ?? type;
  return (awaited.flags & emptyValueFlags) !== 0;
}

function enclosingFunctionBody(node: Node): Block | undefined {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isFunctionLike(current))
      return 'body' in current && current.body && ts.isBlock(current.body) ? current.body : undefined;
  }
}

// The switch is the last statement of its function, so a value that matches no case leaves the function without a
// return value.
function fallsOffFunctionEnd(statement: SwitchStatement, checker: CheckerAdapter): boolean {
  const body = enclosingFunctionBody(statement);
  return body !== undefined && body.statements.at(-1) === statement && returnsValueWithin(statement, checker);
}

function assignedName(node: Node): string | undefined {
  if (!ts.isBinaryExpression(node) || node.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return;
  return ts.isIdentifier(node.left) ? node.left.text : undefined;
}

function assignedWithin(statement: SwitchStatement): Set<string> {
  const names = new Set<string>();
  walkNodes(statement.caseBlock, (node) => {
    const name = assignedName(node);
    if (name) names.add(name);
  });
  return names;
}

function declaredWithoutValue(name: string, statement: SwitchStatement, checker: CheckerAdapter): boolean {
  const body = enclosingFunctionBody(statement);
  if (!body) return false;
  let declaredEmpty = false;
  walkNodes(body, (node) => {
    if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name) || node.name.text !== name) return;
    // A type that admits undefined says the code already handles the unset case.
    const declaredType = checker.getTypeAtLocation(node.name);
    const admitsUndefined = (declaredType.flags & ts.TypeFlags.Undefined) !== 0 || unionAdmitsUndefined(declaredType);
    declaredEmpty =
      declaredEmpty || (node.initializer === undefined && node.exclamationToken === undefined && !admitsUndefined);
  });
  if (!declaredEmpty) return false;
  // The variable must be read after the switch; a value only set inside it is not used.
  let readAfter = false;
  walkNodes(body, (node) => {
    if (ts.isIdentifier(node) && node.text === name && node.getStart() >= statement.end && !isAssignmentTarget(node))
      readAfter = true;
  });
  return readAfter;
}

function isAssignmentTarget(identifier: Node): boolean {
  const parent = identifier.parent;
  return (
    ts.isBinaryExpression(parent) &&
    parent.left === identifier &&
    parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
  );
}

function leavesVariableUnset(statement: SwitchStatement, checker: CheckerAdapter): boolean {
  for (const name of assignedWithin(statement)) if (declaredWithoutValue(name, statement, checker)) return true;
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
