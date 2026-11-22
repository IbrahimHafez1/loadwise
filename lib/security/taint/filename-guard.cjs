'use strict';

const { syntax: ts } = require('../../performance/compiler.cjs');

// Each accepted range stays within ASCII digits or one case of letters. A hyphen at the edge is literal.
const PATH_SEPARATOR = '/';
const safeClass = /\[-?(?:[a-z]-[a-z]|[A-Z]-[A-Z]|\d-\d|\\[dw]|[A-Za-z0-9_])+-?\]/g;
const extension = /\\\.(?:[A-Za-z0-9]+|\([A-Za-z0-9]+(?:\|[A-Za-z0-9]+)+\))$/;

function isFilenamePattern(expression) {
  if (expression.kind !== ts.SyntaxKind.RegularExpressionLiteral) return false;
  const anchored = /^\/\^(.+)\$\/i?$/.exec(expression.text);
  if (!anchored) return false;
  // A stem can contain only filename characters, captures and quantifiers. The optional extension is fixed,
  // or a group of fixed alternatives. No application regex is evaluated by the scanner.
  const stem = anchored[1]
    .replace(extension, '')
    .replace(safeClass, 'x')
    .replace(/\\[dw]|\{\d+(?:,\d*)?\}/g, 'x');
  return /^[A-Za-z0-9_()+*?-]+$/.test(stem);
}

function constantOf(node, checker) {
  const declaration = checker.getSymbolAtLocation(node)?.valueDeclaration;
  return declaration && ts.isVariableDeclaration(declaration) && declaration.parent.flags & ts.NodeFlags.Const
    ? declaration
    : undefined;
}

function onlyRegexCalls(declaration) {
  if (declaration.parent.parent.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword))
    return false;
  // A const regex is still an object. Decline aliases, exported names and mutations of its methods.
  function escapes(node) {
    if (node !== declaration.name && ts.isIdentifier(node) && node.text === declaration.name.text) {
      const access = node.parent;
      return !(
        ts.isPropertyAccessExpression(access) &&
        access.expression === node &&
        ['exec', 'test'].includes(access.name.text) &&
        ts.isCallExpression(access.parent) &&
        access.parent.expression === access
      );
    }
    return ts.forEachChild(node, escapes);
  }
  return !escapes(declaration.getSourceFile());
}

// Return undefined when a condition belongs to another guard family, such as an array allowlist.
function filenameValidation(condition, isSubject, checker) {
  const match = ts.isIdentifier(condition) ? constantOf(condition, checker) : undefined;
  const call = match?.initializer ? ts.skipOuterExpressions(match.initializer) : condition;
  if (!ts.isCallExpression(call) || !ts.isPropertyAccessExpression(call.expression)) return;
  const { expression, name } = call.expression;
  if (name.text !== 'test' && name.text !== 'exec') return;
  if (call.arguments.length !== 1 || !isSubject(call.arguments[0])) return false;
  const receiver = ts.skipOuterExpressions(expression);
  if (!ts.isIdentifier(receiver)) return isFilenamePattern(receiver);
  const pattern = constantOf(receiver, checker);
  return (
    !!pattern?.initializer && isFilenamePattern(ts.skipOuterExpressions(pattern.initializer)) && onlyRegexCalls(pattern)
  );
}

// `value.includes('/')`: a name holding a separator is turned away, so the rest stays in one directory.
function containsSeparator(condition, isSubject) {
  if (!ts.isCallExpression(condition) || !ts.isPropertyAccessExpression(condition.expression)) return false;
  const [separator] = condition.arguments;
  return (
    condition.expression.name.text === 'includes' &&
    condition.arguments.length === 1 &&
    ts.isStringLiteralLike(separator) &&
    separator.text === PATH_SEPARATOR &&
    isSubject(condition.expression.expression)
  );
}

module.exports = { filenameValidation, containsSeparator };
