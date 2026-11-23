'use strict';

const { syntax: ts } = require('../performance/compiler.cjs');
const { analyzeFragment } = require('../performance/pg-fragments.cjs');

// A wildcard, negated class, whitespace, broad escape (\S, \x, \u, \p), quote or semicolon could let SQL syntax through.
const openAlphabet = /[.'"`;\s]|\[\^|\\[SWDsbxupP]/;
const escapedPunctuation = /\\[\\^$.*+?()[\]{}|/-]/g;

function operandsOf(query) {
  const value = ts.skipOuterExpressions(query);
  if (ts.isTemplateExpression(value)) return value.templateSpans.flatMap((span) => operandsOf(span.expression));
  if (ts.isBinaryExpression(value) && value.operatorToken.kind === ts.SyntaxKind.PlusToken)
    return [...operandsOf(value.left), ...operandsOf(value.right)];
  return [value];
}

function hasTopLevelAlternation(source) {
  let depth = 0;
  let inClass = false;
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (char === '\\') index++;
    else if (inClass) inClass = char !== ']';
    else if (char === '[') inClass = true;
    else if (char === '(') depth++;
    else if (char === ')') depth--;
    else if (char === '|' && depth === 0) return true;
  }
  return false;
}

// An expression, or the initializer of the `const` it names.
function constantValue(node, checker) {
  const value = ts.skipOuterExpressions(node);
  if (!ts.isIdentifier(value)) return value;
  const declaration = checker.getSymbolAtLocation(value)?.valueDeclaration;
  const isConstant =
    declaration && ts.isVariableDeclaration(declaration) && declaration.parent.flags & ts.NodeFlags.Const;
  return isConstant && declaration.initializer ? ts.skipOuterExpressions(declaration.initializer) : undefined;
}

// A fully anchored pattern over a closed alphabet.
function isClosedAnchoredRegex(node, checker) {
  const value = constantValue(node, checker);
  if (value?.kind !== ts.SyntaxKind.RegularExpressionLiteral) return false;
  const literal = value.text;
  const flags = literal.slice(literal.lastIndexOf('/') + 1);
  const source = literal.slice(1, literal.lastIndexOf('/'));
  if (flags.includes('m') || !source.startsWith('^') || !source.endsWith('$') || source.endsWith('\\$')) return false;
  return !hasTopLevelAlternation(source) && !openAlphabet.test(source.replace(escapedPunctuation, ''));
}

function isLiteralList(node, checker) {
  let value = constantValue(node, checker);
  if (value && ts.isNewExpression(value) && ts.isIdentifier(value.expression) && value.expression.text === 'Set')
    value = value.arguments?.[0] && ts.skipOuterExpressions(value.arguments[0]);
  return (
    !!value &&
    ts.isArrayLiteralExpression(value) &&
    value.elements.length > 0 &&
    value.elements.every((element) => ts.isStringLiteralLike(element))
  );
}

function isNamed(node, name) {
  const value = ts.skipOuterExpressions(node);
  return ts.isIdentifier(value) && value.text === name;
}

// `/^[a-z_]+$/.test(name)`, `ALLOWED.includes(name)` or `ALLOWED.has(name)` with a literal list.
function isValidation(condition, name, checker) {
  const call = ts.skipOuterExpressions(condition);
  if (!ts.isCallExpression(call) || !ts.isPropertyAccessExpression(call.expression)) return false;
  if (call.arguments.length !== 1 || !isNamed(call.arguments[0], name)) return false;
  const method = call.expression.name.text;
  const receiver = call.expression.expression;
  if (method === 'test') return isClosedAnchoredRegex(receiver, checker);
  return (method === 'includes' || method === 'has') && isLiteralList(receiver, checker);
}

// `!valid(name)` among the `||` operands: when the whole condition is false every operand is false.
function rejectsInvalid(condition, name, checker) {
  const value = ts.skipOuterExpressions(condition);
  if (ts.isBinaryExpression(value) && value.operatorToken.kind === ts.SyntaxKind.BarBarToken)
    return rejectsInvalid(value.left, name, checker) || rejectsInvalid(value.right, name, checker);
  return (
    ts.isPrefixUnaryExpression(value) &&
    value.operator === ts.SyntaxKind.ExclamationToken &&
    isValidation(value.operand, name, checker)
  );
}

// `&&` operands: when the whole condition is true every operand is true.
function confirmsValid(condition, name, checker) {
  const value = ts.skipOuterExpressions(condition);
  if (ts.isBinaryExpression(value) && value.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken)
    return confirmsValid(value.left, name, checker) || confirmsValid(value.right, name, checker);
  return isValidation(value, name, checker);
}

function exits(statement) {
  if (ts.isReturnStatement(statement) || ts.isThrowStatement(statement)) return true;
  return ts.isBlock(statement) && statement.statements.length > 0 && exits(statement.statements.at(-1));
}

function isReassigned(scope, declaration, name, checker) {
  return !!(function visit(node) {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
      ts.isIdentifier(node.left) &&
      node.left.text === name &&
      checker.getSymbolAtLocation(node.left)?.valueDeclaration === declaration
    )
      return true;
    return ts.forEachChild(node, visit);
  })(scope);
}

function precedingGuard(statements, child, name, checker) {
  return statements
    .slice(0, statements.indexOf(child))
    .some(
      (statement) =>
        ts.isIfStatement(statement) &&
        !statement.elseStatement &&
        exits(statement.thenStatement) &&
        rejectsInvalid(statement.expression, name, checker),
    );
}

// The query runs only after `name` passed a regex or allowlist check, and the name is not rewritten.
function isValidatedIdentifier(identifier, call, checker) {
  const declaration = checker.getSymbolAtLocation(identifier)?.valueDeclaration;
  if (!declaration) return false;
  const isParameter = ts.isParameter(declaration) && ts.isIdentifier(declaration.name);
  const isConstant = ts.isVariableDeclaration(declaration) && !!(declaration.parent.flags & ts.NodeFlags.Const);
  if (!isParameter && !isConstant) return false;
  const name = identifier.text;
  const fn = ts.findAncestor(call, ts.isFunctionLike);
  if (!fn?.body) return false;

  // The guard is looked for first: the rewrite check walks the whole function, and most values have no guard.
  for (let child = call, parent = call.parent; parent && child !== fn; child = parent, parent = parent.parent) {
    if (
      (ts.isIfStatement(parent) && parent.thenStatement === child && confirmsValid(parent.expression, name, checker)) ||
      (ts.isBlock(parent) && precedingGuard(parent.statements, child, name, checker))
    )
      return !isReassigned(fn.body, declaration, name, checker);
  }
  return false;
}

// True when every runtime part of the SQL text is an identifier validated before the query runs.
function allRuntimePartsValidated(query, call, checker) {
  const unknown = operandsOf(query).filter((operand) => analyzeFragment(operand, checker) === undefined);
  return (
    unknown.length > 0 &&
    unknown.every((operand) => ts.isIdentifier(operand) && isValidatedIdentifier(operand, call, checker))
  );
}

module.exports = {
  allRuntimePartsValidated,
  isValidatedIdentifier,
  isValidation,
  isClosedAnchoredRegex,
  isLiteralList,
  operandsOf,
};
