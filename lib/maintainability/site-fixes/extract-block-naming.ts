import { ts, nameUsed } from './helpers.js';
import { forOwnNodes } from './extract-block-ast.js';
import type { ClassLikeDeclaration, Expression, Node, SourceFile, Statement, TypeChecker } from 'typescript';
import type { FreeVariable } from '../types/extract-block.js';

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
export function helperName(statement: Statement, sourceFile: SourceFile): string | undefined {
  const base = describedName(statement);
  if (!base || !/^[A-Za-z_$][\w$]*$/.test(base)) return;
  if (!nameUsed(sourceFile, base)) return base;
}

// `buildSeen` for the collection `seen`, when nothing in the file uses that name.
export function builderName(variable: FreeVariable, sourceFile: SourceFile): string | undefined {
  const name = 'build' + pascal(variable.symbol.name);
  if (!nameUsed(sourceFile, name)) return name;
}

// Whether a new method `name` would clash with a member the class declares or inherits, on its
// instance or static side, or one an implemented interface declares. A base or interface the
// isolated checker cannot resolve, such as an imported one, may define any name, so it counts as a
// clash.
export function memberNameTaken(classNode: ClassLikeDeclaration, name: string, checker: TypeChecker): boolean {
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
