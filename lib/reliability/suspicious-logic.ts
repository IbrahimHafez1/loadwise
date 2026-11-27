import { ts } from '../performance/compiler.js';
import { walkNodes } from './walk.js';
import {
  isAssignmentOperator,
  isEqualityOperator,
  isIgnoredSource,
  isNegatedEquality,
  withoutParentheses,
} from './source-helpers.js';
import type {
  BinaryExpression,
  CompilerOptions,
  ElementAccessExpression,
  Expression,
  ForStatement,
  Node,
  SourceFile,
  Statement,
  StringLiteral,
} from 'typescript';
import type { Finding } from '../shared/types.js';

// The compiler only reports comparison mistakes in JavaScript when checking is switched on for the file.
const javascriptFile = /\.(?:[cm]?js|jsx)$/i;
const typeCheckPragma = /(?:\/\/|\/\*)\s*@ts-check\b/;
const typeofNames = ['undefined', 'object', 'boolean', 'number', 'bigint', 'string', 'symbol', 'function'];
const maxTypoDistance = 2;

interface Hit {
  at: Node;
  ruleId: string;
  message: string;
}

interface UnreachableRun {
  exit: Statement;
  unreachable: Statement[];
}

function isUncheckedJavascript(sourceFile: SourceFile, file: string, options: CompilerOptions): boolean {
  return javascriptFile.test(file) && options.checkJs !== true && !typeCheckPragma.test(sourceFile.text);
}

// --- assignment-in-condition ---

function conditionOf(node: Node): Expression | undefined {
  if (ts.isIfStatement(node) || ts.isWhileStatement(node) || ts.isDoStatement(node)) return node.expression;
  // A ternary is not checked: its condition needs the parentheses to be written at all, so `(x = y) ? a : b`
  // is usually intentional.
  if (ts.isForStatement(node)) return node.condition;
}

function isLiteralValue(expression: Expression): boolean {
  return (
    ts.isNumericLiteral(expression) ||
    ts.isStringLiteralLike(expression) ||
    expression.kind === ts.SyntaxKind.TrueKeyword ||
    expression.kind === ts.SyntaxKind.FalseKeyword ||
    expression.kind === ts.SyntaxKind.NullKeyword ||
    (ts.isPrefixUnaryExpression(expression) && ts.isNumericLiteral(expression.operand))
  );
}

function memberRootName(expression: Expression): string | undefined {
  let current = expression;
  while (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) current = current.expression;
  return ts.isIdentifier(current) ? current.text : undefined;
}

// `while (node = node.parent)` walks a chain, which is the idiomatic use of an assignment as a condition.
function walksFromItself(left: Expression, right: Expression): boolean {
  return ts.isIdentifier(left) && memberRootName(right) === left.text;
}

// Only a right side that could just as well have been compared is reported; a call, `await` or `new` is
// the usual "assign and test" idiom.
function looksLikeComparison(left: Expression, right: Expression, inLoop: boolean): boolean {
  if (isLiteralValue(right) || ts.isIdentifier(right)) return true;
  const isMemberAccess = ts.isPropertyAccessExpression(right) || ts.isElementAccessExpression(right);
  return isMemberAccess && !inLoop && !walksFromItself(left, right);
}

function isAssignableTarget(expression: Expression): boolean {
  return (
    ts.isIdentifier(expression) || ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)
  );
}

function assignmentInCondition(node: Node): Hit | undefined {
  const condition = conditionOf(node);
  if (!condition || !ts.isBinaryExpression(condition)) return;
  if (condition.operatorToken.kind !== ts.SyntaxKind.EqualsToken || !isAssignableTarget(condition.left)) return;
  const inLoop = !ts.isIfStatement(node);
  if (!looksLikeComparison(condition.left, condition.right, inLoop)) return;
  return {
    at: condition,
    ruleId: 'assignment-in-condition',
    message:
      'This condition assigns with = instead of comparing, so it overwrites the variable and tests the assigned value. Use === to compare, or wrap the assignment in an extra pair of parentheses if it is intended.',
  };
}

// --- nan-comparison ---

function isNanReference(expression: Expression): boolean {
  const value = withoutParentheses(expression);
  if (ts.isIdentifier(value)) return value.text === 'NaN';
  return (
    ts.isPropertyAccessExpression(value) &&
    ts.isIdentifier(value.expression) &&
    value.expression.text === 'Number' &&
    value.name.text === 'NaN'
  );
}

// Which sides of an equality comparison are NaN, or undefined when it is no comparison with NaN.
function nanSides(binary: BinaryExpression): { leftIsNan: boolean; rightIsNan: boolean } | undefined {
  if (!isEqualityOperator(binary.operatorToken.kind)) return;
  const leftIsNan = isNanReference(binary.left);
  const rightIsNan = isNanReference(binary.right);
  return leftIsNan || rightIsNan ? { leftIsNan, rightIsNan } : undefined;
}

// The operand compared against NaN, or undefined when neither side is NaN or both are.
function nanComparedOperand(binary: BinaryExpression): Expression | undefined {
  const sides = nanSides(binary);
  if (!sides || sides.leftIsNan === sides.rightIsNan) return;
  return sides.leftIsNan ? binary.right : binary.left;
}

function nanComparison(node: Node): Hit | undefined {
  if (!ts.isBinaryExpression(node) || !nanSides(node)) return;
  return {
    at: node,
    ruleId: 'nan-comparison',
    message: `This comparison with NaN is always ${isNegatedEquality(node.operatorToken.kind) ? 'true' : 'false'}, because NaN is not equal to anything, itself included. Use Number.isNaN(value) to test for it.`,
  };
}

// --- invalid-typeof-comparison ---

function editDistance(first: string, second: string): number {
  let previousRow = Array.from({ length: second.length + 1 }, (_, index) => index);
  for (let row = 1; row <= first.length; row++) {
    const currentRow = [row];
    for (let column = 1; column <= second.length; column++) {
      const substitution = previousRow[column - 1] + (first[row - 1] === second[column - 1] ? 0 : 1);
      currentRow.push(Math.min(substitution, previousRow[column] + 1, currentRow[column - 1] + 1));
    }
    previousRow = currentRow;
  }
  return previousRow[second.length];
}

// The single valid typeof result the literal is a typo of; ties and distant strings have no clear answer.
function closestTypeofName(literal: string): string | undefined {
  const lowered = literal.toLowerCase();
  const near = typeofNames.filter((name) => editDistance(lowered, name) <= maxTypoDistance);
  return near.length === 1 ? near[0] : undefined;
}

function literalComparedToTypeof(typeofSide: Expression, literalSide: Expression): StringLiteral | undefined {
  if (!ts.isTypeOfExpression(typeofSide) || !ts.isStringLiteral(literalSide)) return;
  return typeofNames.includes(literalSide.text) ? undefined : literalSide;
}

function invalidTypeofLiteral(binary: BinaryExpression): StringLiteral | undefined {
  if (!isEqualityOperator(binary.operatorToken.kind)) return;
  return literalComparedToTypeof(binary.left, binary.right) ?? literalComparedToTypeof(binary.right, binary.left);
}

function invalidTypeofComparison(node: Node): Hit | undefined {
  if (!ts.isBinaryExpression(node)) return;
  const literal = invalidTypeofLiteral(node);
  if (!literal) return;
  return {
    at: literal,
    ruleId: 'invalid-typeof-comparison',
    message: `typeof never returns '${literal.text}', so this comparison can never match. Compare with one of ${typeofNames.join(', ')}.`,
  };
}

// --- unreachable-code ---

function containerStatements(node: Node): readonly Statement[] | undefined {
  if (
    ts.isBlock(node) ||
    ts.isModuleBlock(node) ||
    ts.isCaseClause(node) ||
    ts.isDefaultClause(node) ||
    ts.isSourceFile(node)
  )
    return node.statements;
}

function isExit(statement: Statement): boolean {
  return (
    ts.isReturnStatement(statement) ||
    ts.isThrowStatement(statement) ||
    ts.isBreakStatement(statement) ||
    ts.isContinueStatement(statement)
  );
}

function exitWord(statement: Statement): string {
  if (ts.isReturnStatement(statement)) return 'return';
  if (ts.isThrowStatement(statement)) return 'throw';
  return ts.isBreakStatement(statement) ? 'break' : 'continue';
}

function isHoistedOrTypeOnly(statement: Statement): boolean {
  if (ts.isFunctionDeclaration(statement) || ts.isInterfaceDeclaration(statement)) return true;
  if (ts.isTypeAliasDeclaration(statement) || ts.isEmptyStatement(statement)) return true;
  if (!ts.isVariableStatement(statement)) return false;
  const isVar = (statement.declarationList.flags & ts.NodeFlags.BlockScoped) === 0;
  return isVar && statement.declarationList.declarations.every((declaration) => !declaration.initializer);
}

// `case 1: return x; break;` is a common defensive habit that does no harm.
function isCaseClauseBreak(statement: Statement): boolean {
  return (
    ts.isBreakStatement(statement) &&
    !statement.label &&
    (ts.isCaseClause(statement.parent) || ts.isDefaultClause(statement.parent))
  );
}

function unreachableRun(statements: readonly Statement[]): UnreachableRun | undefined {
  const exitIndex = statements.findIndex(isExit);
  if (exitIndex === -1) return;
  const unreachable = statements
    .slice(exitIndex + 1)
    .filter((statement) => !isHoistedOrTypeOnly(statement) && !isCaseClauseBreak(statement));
  return unreachable.length ? { exit: statements[exitIndex], unreachable } : undefined;
}

function unreachableCode(node: Node): Hit | undefined {
  const statements = containerStatements(node);
  const run = statements && unreachableRun(statements);
  if (!run) return;
  return {
    at: run.unreachable[0],
    ruleId: 'unreachable-code',
    message: `This code follows a ${exitWord(run.exit)} in the same block, so it never runs. Delete it, or move it before the ${exitWord(run.exit)}.`,
  };
}

// --- loop-index-past-length ---

// Plain names and property chains only: a call could return a different array each time it is evaluated.
function plainReceiverText(expression: Expression): string | undefined {
  if (ts.isIdentifier(expression) || expression.kind === ts.SyntaxKind.ThisKeyword) return expression.getText();
  if (!ts.isPropertyAccessExpression(expression)) return;
  return plainReceiverText(expression.expression) && expression.getText();
}

function loopIndexName(loop: ForStatement): string | undefined {
  const initializer = loop.initializer;
  if (!initializer || !ts.isVariableDeclarationList(initializer) || initializer.declarations.length !== 1) return;
  const [declaration] = initializer.declarations;
  const start = declaration.initializer;
  if (!ts.isIdentifier(declaration.name) || !start) return;
  // Only a loop that starts at 0 can run one pass past the end; a 1-based `i <= length` loop is valid.
  return ts.isNumericLiteral(start) && start.text === '0' ? declaration.name.text : undefined;
}

function stepsByOne(incrementor: Expression | undefined, index: string): boolean {
  if (!incrementor) return false;
  if (ts.isPostfixUnaryExpression(incrementor) || ts.isPrefixUnaryExpression(incrementor)) {
    return (
      incrementor.operator === ts.SyntaxKind.PlusPlusToken &&
      ts.isIdentifier(incrementor.operand) &&
      incrementor.operand.text === index
    );
  }
  return (
    ts.isBinaryExpression(incrementor) &&
    incrementor.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken &&
    ts.isIdentifier(incrementor.left) &&
    incrementor.left.text === index &&
    ts.isNumericLiteral(incrementor.right) &&
    incrementor.right.text === '1'
  );
}

function isNamed(expression: Expression, name: string): boolean {
  return ts.isIdentifier(expression) && expression.text === name;
}

function isWriteTarget(node: Node): boolean {
  const parent = node.parent;
  if (ts.isBinaryExpression(parent)) return isAssignmentOperator(parent.operatorToken.kind) && parent.left === node;
  return (
    (ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)) &&
    (parent.operator === ts.SyntaxKind.PlusPlusToken || parent.operator === ts.SyntaxKind.MinusMinusToken)
  );
}

function changesIndex(node: Node, index: string): boolean {
  if (ts.isBinaryExpression(node)) return isAssignmentOperator(node.operatorToken.kind) && isNamed(node.left, index);
  if (!ts.isPrefixUnaryExpression(node) && !ts.isPostfixUnaryExpression(node)) return false;
  return isWriteTarget(node.operand) && isNamed(node.operand, index);
}

// `if (i < arr.length)` inside the body means the author already guards the last pass.
function comparesIndexToLength(node: Node, index: string, receiver: string): boolean {
  if (!ts.isBinaryExpression(node)) return false;
  const isLength = (side: Expression) =>
    ts.isPropertyAccessExpression(side) && side.name.text === 'length' && side.expression.getText() === receiver;
  return (isNamed(node.left, index) && isLength(node.right)) || (isNamed(node.right, index) && isLength(node.left));
}

function isElementRead(node: Node, receiver: string, index: string): node is ElementAccessExpression {
  return (
    ts.isElementAccessExpression(node) &&
    isNamed(node.argumentExpression, index) &&
    plainReceiverText(node.expression) === receiver &&
    !isWriteTarget(node)
  );
}

function isNullishLiteral(expression: Expression): boolean {
  const value = withoutParentheses(expression);
  return value.kind === ts.SyntaxKind.NullKeyword || isNamed(value, 'undefined');
}

// What a loop body does with the element it just read when it expects the read to come back empty: `!t`,
// `t === undefined`, `t == null`, `typeof t === 'undefined'`, `if (t)` or `t?.x`. A loop written as a
// sentinel pass (`<=` so the last pass sees undefined and flushes) is intended.
function testsForAbsence(node: Node, isElement: (expression: Expression) => boolean): boolean {
  const tracked = (expression: Expression) => isElement(withoutParentheses(expression));
  if (ts.isPrefixUnaryExpression(node))
    return node.operator === ts.SyntaxKind.ExclamationToken && tracked(node.operand);
  if (ts.isIfStatement(node) || ts.isWhileStatement(node)) return tracked(node.expression);
  if (ts.isConditionalExpression(node)) return tracked(node.condition);
  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node))
    return node.questionDotToken !== undefined && tracked(node.expression);
  if (!ts.isBinaryExpression(node)) return false;
  const kind = node.operatorToken.kind;
  if (kind === ts.SyntaxKind.QuestionQuestionToken) return tracked(node.left);
  if (!isEqualityOperator(kind)) return false;
  const typeofName = (side: Expression) => {
    const value = withoutParentheses(side);
    return ts.isTypeOfExpression(value) && tracked(value.expression);
  };
  return (
    (tracked(node.left) && isNullishLiteral(node.right)) ||
    (tracked(node.right) && isNullishLiteral(node.left)) ||
    typeofName(node.left) ||
    typeofName(node.right)
  );
}

function readsPastLength(body: Node, receiver: string, index: string): boolean {
  let reads = false;
  let disqualified = false;
  // Locals holding the element, as in `const t = tokens[i]`.
  const elementNames = new Set<string>();
  const isElement = (expression: Expression) =>
    isElementRead(expression, receiver, index) || (ts.isIdentifier(expression) && elementNames.has(expression.text));
  walkNodes(body, (node: Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      if (isElement(withoutParentheses(node.initializer))) elementNames.add(node.name.text);
    }
    if (changesIndex(node, index) || comparesIndexToLength(node, index, receiver) || testsForAbsence(node, isElement))
      disqualified = true;
    if (isElementRead(node, receiver, index)) reads = true;
  });
  return reads && !disqualified;
}

function loopIndexPastLength(node: Node): Hit | undefined {
  if (!ts.isForStatement(node)) return;
  const index = loopIndexName(node);
  const condition = node.condition;
  if (!index || !condition || !ts.isBinaryExpression(condition)) return;
  if (condition.operatorToken.kind !== ts.SyntaxKind.LessThanEqualsToken || !isNamed(condition.left, index)) return;
  const bound = condition.right;
  if (!ts.isPropertyAccessExpression(bound) || bound.name.text !== 'length') return;
  const receiver = plainReceiverText(bound.expression);
  if (!receiver || !stepsByOne(node.incrementor, index) || !readsPastLength(node.statement, receiver, index)) return;
  return {
    at: condition,
    ruleId: 'loop-index-past-length',
    message: `This loop runs while ${index} <= ${receiver}.length, so its last pass reads ${receiver}[${index}] past the end and gets undefined. Use < instead of <=.`,
  };
}

// Fixture sources hold deliberately odd code as sample input.
const fixtureFolder = /(?:^|\/)(?:__fixtures__|fixtures?)\//i;

function checkSuspiciousLogic(sourceFile: SourceFile, file: string, options: CompilerOptions): Finding[] {
  if (isIgnoredSource(sourceFile, file)) return [];
  const detectors = [assignmentInCondition, loopIndexPastLength];
  // The compiler already reports these in checked files, so only unchecked JavaScript is left to us.
  if (isUncheckedJavascript(sourceFile, file, options)) detectors.push(nanComparison, invalidTypeofComparison);
  if (options.allowUnreachableCode !== false && !fixtureFolder.test(file.replaceAll('\\', '/')))
    detectors.push(unreachableCode);
  const findings: Finding[] = [];
  walkNodes(sourceFile, (node: Node) => {
    for (const detect of detectors) {
      const hit = detect(node);
      if (!hit) continue;
      const position = sourceFile.getLineAndCharacterOfPosition(hit.at.getStart(sourceFile));
      findings.push({
        file,
        line: position.line + 1,
        column: position.character + 1,
        ruleId: hit.ruleId,
        message: hit.message,
      });
    }
  });
  return findings;
}

export { checkSuspiciousLogic, closestTypeofName, containerStatements, nanComparedOperand, unreachableRun };
