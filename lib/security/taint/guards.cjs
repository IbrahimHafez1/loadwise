'use strict';

// Guards that leave a value no room for injected text before it is used: an anchored closed regex, a literal
// allowlist, equality with a literal, `typeof value === 'number'`, `Number.isInteger(value)`, or a `switch` case
// over literals. Every guard is recognised from project syntax, so it applies the same with or without types.
const { syntax: ts } = require('../../performance/compiler.cjs');
const { isValidation } = require('../pg-identifier-guards.cjs');
const { filenameValidation, containsSeparator } = require('./filename-guard.cjs');

const scalarTypeofResults = new Set(['number', 'boolean', 'bigint']);
const numberChecks = new Set(['isInteger', 'isSafeInteger', 'isFinite']);

function stripParentheses(node) {
  return ts.skipOuterExpressions(node);
}

function isLiteral(node) {
  const value = stripParentheses(node);
  return (
    ts.isStringLiteralLike(value) ||
    ts.isNumericLiteral(value) ||
    value.kind === ts.SyntaxKind.TrueKeyword ||
    value.kind === ts.SyntaxKind.FalseKeyword ||
    (ts.isPrefixUnaryExpression(value) &&
      value.operator === ts.SyntaxKind.MinusToken &&
      ts.isNumericLiteral(value.operand))
  );
}

function equalityKind(operator) {
  if (operator === ts.SyntaxKind.EqualsEqualsEqualsToken || operator === ts.SyntaxKind.EqualsEqualsToken)
    return 'equal';
  if (operator === ts.SyntaxKind.ExclamationEqualsEqualsToken || operator === ts.SyntaxKind.ExclamationEqualsToken)
    return 'unequal';
}

// The guarded value is `name` and nothing else.
function createSubject(symbol, checker) {
  return (node) => {
    const value = stripParentheses(node);
    return ts.isIdentifier(value) && checker.getSymbolAtLocation(value) === symbol;
  };
}

// `value === 'asc'` or `typeof value === 'number'` (either operand order): 'equal' or 'unequal' when the comparison
// pins the value to a scalar, otherwise undefined.
function pinningComparison(condition, isSubject) {
  if (!ts.isBinaryExpression(condition)) return;
  const kind = equalityKind(condition.operatorToken.kind);
  if (!kind) return;
  for (const [operand, other] of [
    [condition.left, condition.right],
    [condition.right, condition.left],
  ]) {
    if (isSubject(operand) && isLiteral(other)) return kind;
    const typeOf = stripParentheses(operand);
    const result = stripParentheses(other);
    if (
      ts.isTypeOfExpression(typeOf) &&
      isSubject(typeOf.expression) &&
      ts.isStringLiteralLike(result) &&
      scalarTypeofResults.has(result.text)
    )
      return kind;
  }
}

function isNumberCheck(condition, isSubject) {
  if (!ts.isCallExpression(condition) || condition.arguments.length !== 1 || !isSubject(condition.arguments[0]))
    return false;
  const callee = stripParentheses(condition.expression);
  return (
    ts.isPropertyAccessExpression(callee) &&
    ts.isIdentifier(callee.expression) &&
    callee.expression.text === 'Number' &&
    numberChecks.has(callee.name.text)
  );
}

// When `condition` is true, the value is safe.
function confirms(node, guard) {
  const condition = stripParentheses(node);
  if (ts.isBinaryExpression(condition)) {
    const operator = condition.operatorToken.kind;
    if (operator === ts.SyntaxKind.AmpersandAmpersandToken)
      return confirms(condition.left, guard) || confirms(condition.right, guard);
    if (operator === ts.SyntaxKind.BarBarToken)
      return confirms(condition.left, guard) && confirms(condition.right, guard);
    return pinningComparison(condition, guard.isSubject) === 'equal';
  }
  if (ts.isPrefixUnaryExpression(condition) && condition.operator === ts.SyntaxKind.ExclamationToken)
    return rejects(condition.operand, guard);
  if (guard.filename) {
    const filename = filenameValidation(condition, guard.isSubject, guard.checker);
    if (filename !== undefined) return filename;
  }
  return isNumberCheck(condition, guard.isSubject) || isValidation(condition, guard.name, guard.checker);
}

// When `condition` is false, the value is safe.
function rejects(node, guard) {
  const condition = stripParentheses(node);
  if (ts.isBinaryExpression(condition)) {
    const operator = condition.operatorToken.kind;
    if (operator === ts.SyntaxKind.BarBarToken)
      return rejects(condition.left, guard) || rejects(condition.right, guard);
    if (operator === ts.SyntaxKind.AmpersandAmpersandToken)
      return rejects(condition.left, guard) && rejects(condition.right, guard);
    return pinningComparison(condition, guard.isSubject) === 'unequal';
  }
  if (ts.isPrefixUnaryExpression(condition) && condition.operator === ts.SyntaxKind.ExclamationToken)
    return confirms(condition.operand, guard);
  return Boolean(guard.filename) && containsSeparator(condition, guard.isSubject);
}

function exits(statement) {
  if (
    ts.isReturnStatement(statement) ||
    ts.isThrowStatement(statement) ||
    ts.isBreakStatement(statement) ||
    ts.isContinueStatement(statement)
  )
    return true;
  return ts.isBlock(statement) && statement.statements.length > 0 && exits(statement.statements.at(-1));
}

function precedingGuard(statements, child, rejected) {
  return statements
    .slice(0, statements.indexOf(child))
    .some(
      (statement) =>
        ts.isIfStatement(statement) &&
        !statement.elseStatement &&
        exits(statement.thenStatement) &&
        rejected(statement.expression),
    );
}

// `case 'a': case 'b': use(value)` in `switch (value)`: every clause that can reach this one is a literal case.
function literalCase(clause, guard) {
  const switchStatement = clause.parent.parent;
  if (!guard.isSubject(switchStatement.expression)) return false;
  const clauses = clause.parent.clauses;
  for (let index = clauses.indexOf(clause); index >= 0; index--) {
    const current = clauses[index];
    if (!ts.isCaseClause(current) || !isLiteral(current.expression)) return false;
    const previous = clauses[index - 1];
    if (!previous || (previous.statements.length && exits(previous.statements.at(-1)))) return true;
  }
  return true;
}

function guardedBy(child, parent, accepted, rejected) {
  if (ts.isIfStatement(parent)) {
    if (parent.thenStatement === child) return accepted(parent.expression);
    if (parent.elseStatement === child) return rejected(parent.expression);
  }
  if (ts.isConditionalExpression(parent)) {
    if (parent.whenTrue === child) return accepted(parent.condition);
    if (parent.whenFalse === child) return rejected(parent.condition);
  }
  if (ts.isBinaryExpression(parent) && parent.right === child) {
    if (parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) return accepted(parent.left);
    if (parent.operatorToken.kind === ts.SyntaxKind.BarBarToken) return rejected(parent.left);
  }
  return ts.isBlock(parent) && precedingGuard(parent.statements, child, rejected);
}

function isReassigned(scope, symbol, checker, properties = false) {
  function isSubject(node) {
    let value = stripParentheses(node);
    while (properties && (ts.isPropertyAccessExpression(value) || ts.isElementAccessExpression(value))) {
      value = stripParentheses(value.expression);
    }
    return ts.isIdentifier(value) && checker.getSymbolAtLocation(value) === symbol;
  }
  return !!(function visit(node) {
    if (ts.isIdentifier(node) && node.text === symbol.name && ts.isAssignmentTarget(node)) {
      const assigned = ts.isShorthandPropertyAssignment(node.parent)
        ? checker.getShorthandAssignmentValueSymbol(node.parent)
        : checker.getSymbolAtLocation(node);
      if (assigned === symbol) return true;
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
      isSubject(node.left)
    )
      return true;
    if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken) &&
      isSubject(node.operand)
    )
      return true;
    return ts.forEachChild(node, visit);
  })(scope);
}

const assignmentIndexes = new WeakMap();

// The `=` and `+=` writes to `declaration` inside `scope`, in source order. The writes of a scope are indexed once
// per checker, so resolving each `let` of a long function or module does not walk the whole scope again.
function assignmentsTo(declaration, scope, checker) {
  let byScope = assignmentIndexes.get(checker);
  if (!byScope) assignmentIndexes.set(checker, (byScope = new WeakMap()));
  let byDeclaration = byScope.get(scope);
  if (!byDeclaration) {
    byDeclaration = new Map();
    (function visit(node) {
      if (
        ts.isBinaryExpression(node) &&
        (node.operatorToken.kind === ts.SyntaxKind.EqualsToken ||
          node.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken) &&
        ts.isIdentifier(node.left)
      ) {
        const written = checker.getSymbolAtLocation(node.left)?.valueDeclaration;
        if (written && !byDeclaration.has(written)) byDeclaration.set(written, []);
        if (written) byDeclaration.get(written).push(node);
      }
      ts.forEachChild(node, visit);
    })(scope);
    byScope.set(scope, byDeclaration);
  }
  return byDeclaration.get(declaration) ?? [];
}

// A parameter, a `const`, or a name destructured from either.
function isStableDeclaration(declaration) {
  let current = declaration;
  while (ts.isBindingElement(current)) current = current.parent.parent;
  if (ts.isParameter(current)) return true;
  return ts.isVariableDeclaration(current) && !!(current.parent.flags & ts.NodeFlags.Const);
}

// The use of `identifier` runs only after a guard pinned its value, and the value is not rewritten in the function.
function isGuardedUse(identifier, use, checker, filename) {
  const symbol = checker.getSymbolAtLocation(identifier);
  const declaration = symbol?.valueDeclaration;
  if (!declaration || !isStableDeclaration(declaration)) return false;
  const fn = ts.findAncestor(use, ts.isFunctionLike);
  if (!fn?.body) return false;
  const guard = { name: identifier.text, checker, isSubject: createSubject(symbol, checker), filename };
  // The guard is looked for first: the rewrite check walks the whole function, and most uses have no guard.
  for (let child = use, parent = use.parent; parent && child !== fn; child = parent, parent = parent.parent) {
    if (
      (ts.isCaseClause(parent) && literalCase(parent, guard)) ||
      guardedBy(
        child,
        parent,
        (node) => confirms(node, guard),
        (node) => rejects(node, guard),
      )
    )
      return !isReassigned(fn.body, symbol, checker);
  }
  return false;
}

function impliesEvidence(node, truth, evidence) {
  const condition = stripParentheses(node);
  if (ts.isPrefixUnaryExpression(condition) && condition.operator === ts.SyntaxKind.ExclamationToken)
    return impliesEvidence(condition.operand, !truth, evidence);
  if (ts.isBinaryExpression(condition)) {
    const operator = condition.operatorToken.kind;
    if (operator === ts.SyntaxKind.AmpersandAmpersandToken || operator === ts.SyntaxKind.BarBarToken) {
      const left = impliesEvidence(condition.left, truth, evidence);
      const right = impliesEvidence(condition.right, truth, evidence);
      return truth === (operator === ts.SyntaxKind.AmpersandAmpersandToken) ? left || right : left && right;
    }
  }
  return evidence(condition, truth);
}

// Only credit conditions whose truth follows from reaching the use in this function invocation.
function isGuardedByCondition(use, evidence) {
  const accepted = (node) => impliesEvidence(node, true, evidence);
  const rejected = (node) => impliesEvidence(node, false, evidence);
  for (
    let child = use, parent = use.parent;
    parent && !ts.isFunctionLike(child);
    child = parent, parent = parent.parent
  ) {
    if (guardedBy(child, parent, accepted, rejected)) return true;
  }
  return false;
}

module.exports = { isGuardedUse, isGuardedByCondition, isReassigned, assignmentsTo };
