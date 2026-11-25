// Rewrites of queries that load every row only to count, pick, filter or rank them, for Prisma
// findMany results and pg result rows.
import { ts, textOf, replaceNode, calleeCall } from './helpers.js';
import { isMethodCall } from './method-calls.js';
import type {
  CallExpression,
  Expression,
  Identifier,
  Node,
  NoSubstitutionTemplateLiteral,
  PropertyAccessExpression,
  StringLiteral,
  VariableDeclaration,
} from 'typescript';
import {
  someNode,
  outerParentheses,
  textWith,
  inSlot,
  isReference,
  plainProperties,
  propertyValue,
  singleLineLiteral,
} from './query-loop-nodes.js';
import type { MethodCall } from '../types/method-call.js';
import type { PlainProperty } from '../types/plain-property.js';
import type { FixResult, SiteFixInput, TextEdit } from '../../shared/types.js';

/** `(await db.model.findMany(args)).method(...)`. */
interface ChainedFindMany {
  call: MethodCall;
  chained: CallExpression;
}

/** A one-expression callback: its parameter names and the expression it returns. */
interface SingleResult {
  parameters: string[];
  result: Expression;
}

/** Rebuilds one option property of a call, given the existing property when there is one. */
type OptionChange = (existing?: PlainProperty) => string;

const selectListSql = /^(\s*select\s+)(.+?)(\s+from\s)/is;

const trailingSql = /\s*;?\s*$/;

// `(await db.model.findMany(args))` around `call`, or undefined when anything else sits between
// them.
function awaitedFindMany(call: MethodCall): Expression | undefined {
  if (call.expression.name.text !== 'findMany') return;
  const awaited = outerParentheses(call).parent;
  if (ts.isAwaitExpression(awaited)) return outerParentheses(awaited);
}

function renamedCall(call: MethodCall, method: string): string {
  const name = call.expression.name;
  return textWith(call, [{ start: name.getStart(), end: name.end, text: method }]);
}

export function prismaCountMaterialization({ node }: SiteFixInput): FixResult | undefined {
  const call = node && calleeCall(node);
  if (!call || !isMethodCall(call)) return;
  const result = awaitedFindMany(call);
  const access = result?.parent;
  if (
    !access ||
    !ts.isPropertyAccessExpression(access) ||
    access.expression !== result ||
    access.name.text !== 'length'
  )
    return;
  return { edits: [replaceNode(access, inSlot(access, `await ${renamedCall(call, 'count')}`))] };
}

function booleanContext(expression: Expression): boolean {
  const value = outerParentheses(expression);
  const parent = value.parent;
  if (
    ((ts.isIfStatement(parent) || ts.isWhileStatement(parent) || ts.isDoStatement(parent)) &&
      parent.expression === value) ||
    (ts.isConditionalExpression(parent) && parent.condition === value) ||
    (ts.isPrefixUnaryExpression(parent) && parent.operator === ts.SyntaxKind.ExclamationToken)
  )
    return true;
  return (
    ts.isBinaryExpression(parent) &&
    (parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
      parent.operatorToken.kind === ts.SyntaxKind.BarBarToken) &&
    booleanContext(parent)
  );
}

// A use that behaves the same for null (findFirst) as for undefined (an empty array's [0]).
function nullSafeUse(identifier: Identifier): boolean {
  const value = outerParentheses(identifier);
  const parent = value.parent;
  if ((ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) && parent.expression === value)
    return true;
  if (booleanContext(value)) return true;
  if (!ts.isBinaryExpression(parent) || parent.left !== value) return false;
  const operator = parent.operatorToken.kind;
  if (operator === ts.SyntaxKind.QuestionQuestionToken || operator === ts.SyntaxKind.BarBarToken) return true;
  return (
    (operator === ts.SyntaxKind.EqualsEqualsToken || operator === ts.SyntaxKind.ExclamationEqualsToken) &&
    (parent.right.kind === ts.SyntaxKind.NullKeyword || textOf(parent.right) === 'undefined')
  );
}

function onlyNullSafeUses(declaration: VariableDeclaration): boolean {
  if (!ts.isIdentifier(declaration.name) || !(declaration.parent.flags & ts.NodeFlags.Const)) return false;
  const scope = ts.findAncestor(declaration, (node: Node) => ts.isFunctionLike(node) || ts.isSourceFile(node));
  if (!scope) return false;
  const name = declaration.name;
  return !someNode(
    scope,
    (node: Node) =>
      ts.isIdentifier(node) && node !== name && node.text === name.text && isReference(node) && !nullSafeUse(node),
  );
}

export function prismaFirstMaterialization({ node }: SiteFixInput): FixResult | undefined {
  const call = node && calleeCall(node);
  if (!call || !isMethodCall(call)) return;
  const result = awaitedFindMany(call);
  const access = result?.parent;
  if (!access || !ts.isElementAccessExpression(access) || access.expression !== result) return;
  const first = `await ${renamedCall(call, 'findFirst')}`;
  const outer = outerParentheses(access);
  const read = outer.parent;
  if ((ts.isPropertyAccessExpression(read) || ts.isElementAccessExpression(read)) && read.expression === outer)
    return { edits: [replaceNode(access, `(${first})`)] };
  if (ts.isVariableDeclaration(read) && read.initializer === access && onlyNullSafeUses(read))
    return { edits: [replaceNode(access, first)] };
}

// The findMany call text with option properties replaced or appended.
function withOptions(call: CallExpression, changes: ReadonlyMap<string, OptionChange>): string | undefined {
  const [options] = call.arguments;
  if (!options) {
    const added = [...changes.values()].map((change) => change()).join(', ');
    return textOf(call).replace(/\(\s*\)$/, `({ ${added} })`);
  }
  const properties = plainProperties(options);
  if (!properties || !ts.isObjectLiteralExpression(options)) return;
  const edits: TextEdit[] = [];
  const appended: string[] = [];
  for (const [name, change] of changes) {
    const existing = properties.get(name);
    if (existing) edits.push(replaceNode(existing, change(existing)));
    else appended.push(change());
  }
  if (appended.length) {
    const last = options.properties.at(-1);
    edits.push(
      last
        ? { start: last.end, end: last.end, text: `, ${appended.join(', ')}` }
        : replaceNode(options, `{ ${appended.join(', ')} }`),
    );
  }
  return textWith(call, edits);
}

function fieldOf(expression: Expression, parameter: string): string | undefined {
  if (
    ts.isPropertyAccessExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    expression.expression.text === parameter
  )
    return expression.name.text;
}

function singleResult(callback: Expression | undefined, arity: number): SingleResult | undefined {
  if (
    !callback ||
    (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback)) ||
    callback.parameters.length !== arity
  )
    return;
  const parameters: string[] = [];
  for (const parameter of callback.parameters) {
    if (!ts.isIdentifier(parameter.name)) return;
    parameters.push(parameter.name.text);
  }
  let result: Node | undefined = callback.body;
  if (ts.isBlock(result)) {
    const [only] = result.statements;
    if (result.statements.length !== 1 || !ts.isReturnStatement(only)) return;
    result = only.expression;
  }
  return result && ts.isExpression(result) ? { parameters, result: ts.skipParentheses(result) } : undefined;
}

// `(await db.model.findMany(args)).method(...)` from the reported method name.
function chainedFindMany(node: Node): ChainedFindMany | undefined {
  const access = node.parent;
  const chained = access?.parent;
  if (!access || !chained) return;
  if (!ts.isPropertyAccessExpression(access) || !ts.isCallExpression(chained) || chained.expression !== access) return;
  const awaited = ts.skipParentheses(access.expression);
  const call = ts.isAwaitExpression(awaited) ? ts.skipParentheses(awaited.expression) : undefined;
  if (call && ts.isCallExpression(call) && isMethodCall(call) && awaitedFindMany(call)) return { call, chained };
}

const filterNote =
  'The database now compares the value: check case-insensitive collations, and Decimal, BigInt or DateTime fields that JavaScript `===` never matched.';

export function prismaFilterMaterialization({ node }: SiteFixInput): FixResult | undefined {
  const query = node && chainedFindMany(node);
  if (!query) return;
  const single = singleResult(query.chained.arguments[0], 1);
  const predicate = single?.result;
  if (
    !single ||
    !predicate ||
    query.chained.arguments.length !== 1 ||
    !ts.isBinaryExpression(predicate) ||
    predicate.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken
  )
    return;
  const parameter = single.parameters[0];
  const [fieldSide, valueSide] = fieldOf(predicate.left, parameter)
    ? [predicate.left, predicate.right]
    : [predicate.right, predicate.left];
  const field = fieldOf(fieldSide, parameter);
  const value = ts.skipParentheses(valueSide);
  const literal =
    ts.isStringLiteral(value) ||
    ts.isNumericLiteral(value) ||
    value.kind === ts.SyntaxKind.TrueKeyword ||
    value.kind === ts.SyntaxKind.FalseKeyword ||
    (ts.isPrefixUnaryExpression(value) &&
      value.operator === ts.SyntaxKind.MinusToken &&
      ts.isNumericLiteral(value.operand));
  if (!field || !literal) return;
  const condition = `{ ${field}: ${textOf(value)} }`;
  const where: OptionChange = (existing) => {
    if (!existing) return `where: ${condition}`;
    const current = propertyValue(existing);
    return `where: { AND: [${textOf(current)}, ${condition}] }`;
  };
  const rewritten = withOptions(query.call, new Map<string, OptionChange>([['where', where]]));
  if (!rewritten) return;
  return { edits: [replaceNode(query.chained, inSlot(query.chained, `await ${rewritten}`))], note: filterNote };
}

export function prismaTopKMaterialization({ node }: SiteFixInput): FixResult | undefined {
  const query = node && chainedFindMany(node);
  if (!query) return;
  const single = singleResult(query.chained.arguments[0], 2);
  const difference = single?.result;
  const slice = outerParentheses(query.chained).parent?.parent;
  if (
    !single ||
    !difference ||
    !slice ||
    !ts.isBinaryExpression(difference) ||
    difference.operatorToken.kind !== ts.SyntaxKind.MinusToken ||
    !ts.isCallExpression(slice) ||
    !ts.isPropertyAccessExpression(slice.expression) ||
    slice.expression.expression !== outerParentheses(query.chained) ||
    slice.expression.name.text !== 'slice' ||
    slice.arguments.length !== 2 ||
    textOf(slice.arguments[0]) !== '0'
  )
    return;
  const limit = slice.arguments[1];
  if (!ts.isNumericLiteral(limit)) return;
  const [first, second] = single.parameters;
  const ascending = fieldOf(difference.left, first);
  const field = ascending ?? fieldOf(difference.left, second);
  if (!field || fieldOf(difference.right, ascending ? second : first) !== field) return;
  const order = `{ ${field}: '${ascending ? 'asc' : 'desc'}' }`;
  const orderBy: OptionChange = (existing) => {
    if (!existing) return `orderBy: ${order}`;
    // JavaScript's stable sort kept the query order as the tie-breaker.
    const current = propertyValue(existing);
    const rest = ts.isArrayLiteralExpression(current) ? current.elements.map(textOf).join(', ') : textOf(current);
    return `orderBy: [${order}, ${rest}]`;
  };
  const changes = new Map<string, OptionChange>([
    ['orderBy', orderBy],
    ['take', () => `take: ${limit.text}`],
  ]);
  const rewritten = withOptions(query.call, changes);
  if (!rewritten) return;
  return {
    edits: [replaceNode(slice, inSlot(slice, `await ${rewritten}`))],
    note: 'Check NULL placement: the database orders NULLs itself, while the JavaScript comparator treated them as 0.',
  };
}

// The string literal of `(await client.query(SQL)).rows` holding the reported read.
function pgRowsQuery(rows: PropertyAccessExpression): StringLiteral | NoSubstitutionTemplateLiteral | undefined {
  const awaited = ts.skipParentheses(rows.expression);
  const call = ts.isAwaitExpression(awaited) ? ts.skipParentheses(awaited.expression) : undefined;
  if (!call || !ts.isCallExpression(call) || rows.name.text !== 'rows') return;
  const [query] = call.arguments;
  if (query && singleLineLiteral(query)) return query;
}

function sqlKeyword(sql: string, keyword: string): string {
  return /^\s*SELECT/.test(sql) ? keyword.toUpperCase() : keyword.toLowerCase();
}

export function pgFirstMaterialization({ node }: SiteFixInput): FixResult | undefined {
  if (!node) return;
  const access = node.parent;
  const rows = ts.isElementAccessExpression(access) ? ts.skipParentheses(access.expression) : undefined;
  const query = rows && ts.isPropertyAccessExpression(rows) ? pgRowsQuery(rows) : undefined;
  if (!query) return;
  const end = query.getStart() + 1 + query.text.replace(trailingSql, '').length;
  return { edits: [{ start: end, end, text: ` ${sqlKeyword(query.text, 'limit')} 1` }] };
}

export function pgCountMaterialization({ node }: SiteFixInput): FixResult | undefined {
  if (!node) return;
  const length = node.parent;
  const rows = ts.isPropertyAccessExpression(length) ? ts.skipParentheses(length.expression) : undefined;
  const query = rows && ts.isPropertyAccessExpression(rows) ? pgRowsQuery(rows) : undefined;
  const list = query && selectListSql.exec(query.text);
  if (!rows || !query || !list) return;
  const start = query.getStart() + 1 + list[1].length;
  const counted = `${sqlKeyword(query.text, 'count')}(*) ${sqlKeyword(query.text, 'as')} total`;
  const rowsText = textWith(rows, [{ start, end: start + list[2].length, text: counted }]);
  return { edits: [replaceNode(length, `Number(${rowsText}[0].total)`)] };
}
