import { ts, textOf, replaceNode, calleeCall, requireReview } from './helpers.js';
import { awaitedResult, outsideWrappers } from '../query-results.js';
import type { BinaryExpression, CallExpression, Expression, Node } from 'typescript';
import type { FixResult, SiteFixInput } from '../../shared/types.js';

// --- json-roundtrip-clone ---

function isJsonCall(node: Node, methodName: string): node is CallExpression {
  if (!ts.isCallExpression(node) || ts.isOptionalChain(node)) return false;
  const callee = ts.skipOuterExpressions(node.expression);
  return (
    ts.isPropertyAccessExpression(callee) &&
    callee.name.text === methodName &&
    ts.isIdentifier(callee.expression) &&
    callee.expression.text === 'JSON'
  );
}

function jsonCloneFix({ node }: SiteFixInput): FixResult | undefined {
  if (!node) return;
  const parse = ts.findAncestor(node, (current): current is CallExpression => isJsonCall(current, 'parse'));
  if (!parse || parse.arguments.length !== 1) return;
  const stringify = ts.skipOuterExpressions(parse.arguments[0]);
  // A replacer or indentation argument changes what the round trip keeps, so structuredClone is not
  // equivalent.
  if (!isJsonCall(stringify, 'stringify') || stringify.arguments.length !== 1) return;
  const [value] = stringify.arguments;
  if (ts.isSpreadElement(value)) return;
  return {
    edits: [replaceNode(parse, `structuredClone(${textOf(value)})`)],
    note: 'structuredClone keeps Dates, Maps, Sets and undefined values where the JSON round trip turned Dates into strings and dropped undefined; class instances lose their prototype in both. It throws on functions and symbols, which the round trip silently dropped.',
    requiresReview: true,
  };
}

// --- return-newline ---

function returnNewlineFix({ node, text }: SiteFixInput): FixResult | undefined {
  if (!node || text === undefined) return;
  const statement = ts.findAncestor(node, ts.isReturnStatement);
  if (!statement || statement.expression || !ts.isBlock(statement.parent)) return;
  const siblings = statement.parent.statements;
  const next = siblings[siblings.indexOf(statement) + 1];
  if (!next || (!ts.isExpressionStatement(next) && !ts.isBlock(next))) return;
  const value = text.slice(next.getStart(), next.end);
  return {
    edits: [{ start: statement.end, end: next.end, text: ` ${value}${value.endsWith(';') ? '' : ';'}` }],
    note: 'The function used to return undefined here and now returns the value on the next line; the statements after it were unreachable before.',
    requiresReview: true,
  };
}

// --- prisma-count-for-existence ---

const EXISTS_WHEN_COUNT_ON_LEFT = new Map([
  [ts.SyntaxKind.GreaterThanToken, '0'],
  [ts.SyntaxKind.GreaterThanEqualsToken, '1'],
  [ts.SyntaxKind.ExclamationEqualsEqualsToken, '0'],
  [ts.SyntaxKind.ExclamationEqualsToken, '0'],
]);
const MISSING_WHEN_COUNT_ON_LEFT = new Map([
  [ts.SyntaxKind.LessThanEqualsToken, '0'],
  [ts.SyntaxKind.LessThanToken, '1'],
  [ts.SyntaxKind.EqualsEqualsEqualsToken, '0'],
  [ts.SyntaxKind.EqualsEqualsToken, '0'],
]);
// The same comparisons written with the count on the right-hand side.
const EXISTS_WHEN_COUNT_ON_RIGHT = new Map([
  [ts.SyntaxKind.LessThanToken, '0'],
  [ts.SyntaxKind.LessThanEqualsToken, '1'],
  [ts.SyntaxKind.ExclamationEqualsEqualsToken, '0'],
  [ts.SyntaxKind.ExclamationEqualsToken, '0'],
]);
const MISSING_WHEN_COUNT_ON_RIGHT = new Map([
  [ts.SyntaxKind.GreaterThanEqualsToken, '0'],
  [ts.SyntaxKind.GreaterThanToken, '1'],
  [ts.SyntaxKind.EqualsEqualsEqualsToken, '0'],
  [ts.SyntaxKind.EqualsEqualsToken, '0'],
]);
// Parents that already delimit the comparison, so the replacement needs no extra parentheses.
const DELIMITED_PARENTS = new Set([
  ts.SyntaxKind.IfStatement,
  ts.SyntaxKind.ReturnStatement,
  ts.SyntaxKind.VariableDeclaration,
  ts.SyntaxKind.ParenthesizedExpression,
  ts.SyntaxKind.ArrowFunction,
  ts.SyntaxKind.ExpressionStatement,
  ts.SyntaxKind.CallExpression,
  ts.SyntaxKind.ArrayLiteralExpression,
  ts.SyntaxKind.PropertyAssignment,
]);
const LOGICAL_OPERATORS = new Set([
  ts.SyntaxKind.AmpersandAmpersandToken,
  ts.SyntaxKind.BarBarToken,
  ts.SyntaxKind.QuestionQuestionToken,
]);

function existenceVerdict(comparison: BinaryExpression, count: Expression): 'exists' | 'missing' | undefined {
  const countOnLeft = comparison.left === count;
  let threshold = countOnLeft ? comparison.right : comparison.left;
  while (ts.isParenthesizedExpression(threshold)) threshold = threshold.expression;
  if (!ts.isNumericLiteral(threshold)) return;
  const operator = comparison.operatorToken.kind;
  const exists =
    (countOnLeft ? EXISTS_WHEN_COUNT_ON_LEFT : EXISTS_WHEN_COUNT_ON_RIGHT).get(operator) === threshold.text;
  const missing =
    (countOnLeft ? MISSING_WHEN_COUNT_ON_LEFT : MISSING_WHEN_COUNT_ON_RIGHT).get(operator) === threshold.text;
  if (exists) return 'exists';
  return missing ? 'missing' : undefined;
}

function needsParentheses(comparison: BinaryExpression): boolean {
  const parent = comparison.parent;
  if (ts.isBinaryExpression(parent)) return !LOGICAL_OPERATORS.has(parent.operatorToken.kind);
  return !DELIMITED_PARENTS.has(parent.kind);
}

function findFirstOptions(options: Expression | undefined, idField: string): string | undefined {
  const projection = `select: { ${idField}: true }`;
  if (!options) return `{ ${projection} }`;
  if (!ts.isObjectLiteralExpression(options) || !options.properties.length) return `{ ${projection} }`;
  const optionText = textOf(options);
  // Rebuilding the literal text would drop a comment, so those stay manual.
  if (/\/[/*]/.test(optionText)) return;
  return `${optionText.slice(0, -1).replace(/[\s,]+$/, '')}, ${projection} }`;
}

function countExistenceFix({ finding, node }: SiteFixInput): FixResult | undefined {
  if (!node) return;
  const call = calleeCall(node);
  if (!call || !ts.isPropertyAccessExpression(call.expression) || call.expression.name.text !== 'count') return;
  const delegate = call.expression.expression;
  if (!ts.isPropertyAccessExpression(delegate) || call.arguments.length > 1) return;
  const awaited = awaitedResult(call);
  if (!awaited) return;
  const count = outsideWrappers(awaited);
  const comparison = count.parent;
  if (!ts.isBinaryExpression(comparison)) return;
  const verdict = existenceVerdict(comparison, count);
  const { idField } = finding;
  if (!verdict || typeof idField !== 'string' || !idField) return;
  const options = findFirstOptions(call.arguments[0], idField);
  if (!options) return;
  const lookup = `(await ${textOf(delegate)}.findFirst(${options})) ${verdict === 'exists' ? '!==' : '==='} null`;
  return { edits: [replaceNode(comparison, needsParentheses(comparison) ? `(${lookup})` : lookup)] };
}

// --- typeorm-unused-count ---

const COUNT_METHOD_REPLACEMENTS = new Map([
  ['findAndCount', 'find'],
  ['findAndCountBy', 'findBy'],
  ['getManyAndCount', 'getMany'],
]);

function unusedCountFix({ node }: SiteFixInput): FixResult | undefined {
  if (!node) return;
  const call = calleeCall(node);
  if (!call || !ts.isPropertyAccessExpression(call.expression)) return;
  const replacement = COUNT_METHOD_REPLACEMENTS.get(call.expression.name.text);
  const awaited = awaitedResult(call);
  const binding = awaited && outsideWrappers(awaited).parent;
  if (!replacement || !binding || !ts.isVariableDeclaration(binding) || binding.type) return;
  if (!ts.isArrayBindingPattern(binding.name)) return;
  const [rows] = binding.name.elements;
  if (!rows || !ts.isBindingElement(rows) || !ts.isIdentifier(rows.name) || rows.initializer || rows.dotDotDotToken)
    return;
  return {
    edits: [replaceNode(binding.name, textOf(rows.name)), replaceNode(call.expression.name, replacement)],
  };
}

// --- return-in-finally ---

// A bare `return;` that ends both the finally block and the function only discards the pending
// result or error, so removing it changes nothing else. Any other return would let later code run,
// so it is left for a manual change.
function returnInFinallyFix({ node }: SiteFixInput): FixResult | undefined {
  if (!node) return;
  const statement = ts.findAncestor(node, ts.isReturnStatement);
  const finallyBlock = statement?.parent;
  const tryStatement = finallyBlock?.parent;
  if (!statement || statement.expression || !finallyBlock || !ts.isBlock(finallyBlock)) return;
  if (!tryStatement || !ts.isTryStatement(tryStatement)) return;
  if (tryStatement.finallyBlock !== finallyBlock || finallyBlock.statements.at(-1) !== statement) return;
  const functionBody = tryStatement.parent;
  if (
    !ts.isBlock(functionBody) ||
    !ts.isFunctionLike(functionBody.parent) ||
    functionBody.statements.at(-1) !== tryStatement
  )
    return;
  return {
    edits: [{ start: statement.getFullStart(), end: statement.end, text: '' }],
    note: 'Errors thrown in try or catch now reach the caller, and a return value from try is no longer discarded.',
  };
}

export default {
  'json-roundtrip-clone': jsonCloneFix,
  'return-in-finally': requireReview(
    'Errors that the finally block used to swallow now reach the caller.',
    returnInFinallyFix,
  ),
  'return-newline': returnNewlineFix,
  'prisma-count-for-existence': countExistenceFix,
  'typeorm-unused-count': unusedCountFix,
};
