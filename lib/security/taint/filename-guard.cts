import { loadSyntax } from '../../performance/compiler.cjs';
import type { Expression, Node, VariableDeclaration } from 'typescript';
import type { CheckerAdapter } from '../../shared/types.cjs';
import type { SubjectTest } from '../types/condition-guards.cjs';
const ts = loadSyntax();

// Each accepted range stays within ASCII digits or one case of letters. A hyphen at the edge is
// literal.
const PATH_SEPARATOR = '/';
const safeClass = /\[-?(?:[a-z]-[a-z]|[A-Z]-[A-Z]|\d-\d|\\[dw]|[A-Za-z0-9_])+-?\]/g;
const extension = /\\\.(?:[A-Za-z0-9]+|\([A-Za-z0-9]+(?:\|[A-Za-z0-9]+)+\))$/;

function isFilenamePattern(expression: Expression) {
  if (!ts.isRegularExpressionLiteral(expression)) return false;
  const anchored = /^\/\^(.+)\$\/i?$/.exec(expression.text);
  if (!anchored) return false;
  // A stem can contain only filename characters, captures and quantifiers. The optional extension
  // is fixed, or a group of fixed alternatives. No application regex is evaluated by the scanner.
  const stem = anchored[1]
    .replace(extension, '')
    .replaceAll(safeClass, 'x')
    .replaceAll(/\\[dw]|\{\d+(?:,\d*)?\}/g, 'x');
  return /^[A-Za-z0-9_()+*?-]+$/.test(stem);
}

function constantOf(node: Node, checker: CheckerAdapter): VariableDeclaration | undefined {
  const declaration = checker.getSymbolAtLocation(node)?.valueDeclaration;
  return declaration && ts.isVariableDeclaration(declaration) && declaration.parent.flags & ts.NodeFlags.Const
    ? declaration
    : undefined;
}

function onlyRegexCalls(declaration: VariableDeclaration) {
  const statement = declaration.parent.parent;
  if (
    ts.isVariableStatement(statement) &&
    statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
  )
    return false;
  const declaredName = ts.isIdentifier(declaration.name) ? declaration.name.text : undefined;
  // A const regex is still an object. Decline aliases, exported names and mutations of its methods.
  function escapes(node: Node): boolean | undefined {
    if (node !== declaration.name && ts.isIdentifier(node) && node.text === declaredName) {
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
function filenameValidation(condition: Expression, isSubject: SubjectTest, checker: CheckerAdapter) {
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

// `value.includes('/')`: a name holding a separator is turned away, so the rest stays in one
// directory.
function containsSeparator(condition: Expression, isSubject: SubjectTest) {
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

export { filenameValidation, containsSeparator };
