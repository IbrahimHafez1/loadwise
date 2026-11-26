import { ts } from '../../performance/compiler.js';
import type { Expression, Node, VariableDeclaration } from 'typescript';
import type { CheckerAdapter } from '../../shared/types.js';
import type { SubjectTest } from '../types/condition-guards.js';

// Each accepted range stays within ASCII digits or one case of letters. A hyphen at the edge is
// literal.
const PATH_SEPARATOR = '/';
const BLOCKED_SEPARATORS = new Set(['/', '\\', '..']);
const safeClass = /\[-?(?:[a-z]-[a-z]|[A-Z]-[A-Z]|\d-\d|\\[dw.-]|[A-Za-z0-9_.])+-?\]/g;
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
    .replaceAll(/\\[dw.]|\{\d+(?:,\d*)?\}/g, 'x');
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

const separatorRegexPattern = /^\/(?:\[[^\]]*[/\\][^\]]*\]|\\\.\.)\/[gi]*$/;
const foundIndexComparisons = new Set(['!== -1', '!= -1', '>= 0', '> -1']);
const missingIndexComparisons = new Set(['=== -1', '== -1', '< 0']);

function isSeparatorStringCall(
  expression: Expression,
  methodName: string,
  expectedMethod: string,
  args: readonly Expression[],
  isSubject: SubjectTest,
): boolean {
  if (methodName !== expectedMethod || args.length !== 1) return false;
  const [separator] = args;
  return (
    ts.isStringLiteralLike(separator) &&
    (separator.text === PATH_SEPARATOR || BLOCKED_SEPARATORS.has(separator.text)) &&
    isSubject(expression)
  );
}

function matchesIndexOfSeparator(
  condition: Expression,
  comparisons: ReadonlySet<string>,
  isSubject: SubjectTest,
): boolean {
  if (!ts.isBinaryExpression(condition)) return false;
  const left = ts.skipOuterExpressions(condition.left);
  const comparison = `${condition.operatorToken.getText()} ${ts.skipOuterExpressions(condition.right).getText()}`;
  if (!ts.isCallExpression(left) || !ts.isPropertyAccessExpression(left.expression) || !comparisons.has(comparison)) {
    return false;
  }
  return isSeparatorStringCall(
    left.expression.expression,
    left.expression.name.text,
    'indexOf',
    left.arguments,
    isSubject,
  );
}

// `value.indexOf('/') === -1`: confirms the filename carries no path separator.
function lacksSeparator(condition: Expression, isSubject: SubjectTest): boolean {
  return matchesIndexOfSeparator(condition, missingIndexComparisons, isSubject);
}

// `value.includes('/')`, `value.indexOf('/') !== -1`, `value.match(/[/\\]/)` or `/[/\\]/.test(value)`:
// a name holding a separator is turned away.
function containsSeparator(condition: Expression, isSubject: SubjectTest) {
  if (matchesIndexOfSeparator(condition, foundIndexComparisons, isSubject)) return true;
  if (!ts.isCallExpression(condition) || !ts.isPropertyAccessExpression(condition.expression)) return false;
  const { expression, name } = condition.expression;
  if (isSeparatorStringCall(expression, name.text, 'includes', condition.arguments, isSubject)) return true;
  if (name.text === 'test' && condition.arguments.length === 1 && isSubject(condition.arguments[0])) {
    const pattern = ts.skipOuterExpressions(expression);
    return ts.isRegularExpressionLiteral(pattern) && separatorRegexPattern.test(pattern.text);
  }
  if (name.text === 'match' && condition.arguments.length === 1 && isSubject(expression)) {
    const pattern = ts.skipOuterExpressions(condition.arguments[0]);
    return ts.isRegularExpressionLiteral(pattern) && separatorRegexPattern.test(pattern.text);
  }
  return false;
}

export { filenameValidation, containsSeparator, lacksSeparator };
