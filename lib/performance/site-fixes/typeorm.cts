import { isWhereOnlyOptions } from '../typeorm-projection.cjs';
import { requireReview, ts, ancestor, calleeCall, indentationAt, replaceNode } from './helpers.cjs';
import type {
  AwaitExpression,
  BinaryExpression,
  CallExpression,
  Expression,
  Identifier,
  MemberName,
  Node,
  PrefixUnaryExpression,
  SyntaxKind,
  VariableDeclaration,
} from 'typescript';
import type { FixResult, SiteFixInput, TextEdit } from '../../shared/types.cjs';

/** A `find*` read that a count call can replace, named by the marker in the finding's message. */
interface CountRewrite {
  marker: string;
  read: string;
  replacement: string;
}

/** The identifier a guard reads, and the `!= null` comparison it sits in when there is one. */
interface TestedIdentifier {
  identifier: Identifier;
  comparison: BinaryExpression | undefined;
}

const existenceMethodByRead: Record<string, string> = { findOne: 'exists', findOneBy: 'existsBy' };
const countMethodByMessage: readonly CountRewrite[] = [
  { marker: 'Repository.count()', read: 'find', replacement: 'count' },
  { marker: 'Repository.countBy()', read: 'findBy', replacement: 'countBy' },
  { marker: 'Model.count()', read: 'findAll', replacement: 'count' },
];

// The method name of `receiver.method(...)`, when the call has that plain shape.
function calledMethod(call: CallExpression | undefined): MemberName | undefined {
  if (!call || !ts.isPropertyAccessExpression(call.expression)) return;
  return call.expression.name;
}

function skipParentheses(node: Node): Node {
  let current: Node = node;
  while (ts.isParenthesizedExpression(current.parent)) current = current.parent;
  return current;
}

const nullishComparisonTokens: readonly SyntaxKind[] = [
  ts.SyntaxKind.ExclamationEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
];

function isNegation(node: Node): node is PrefixUnaryExpression {
  return ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken;
}

// The identifier a guard reads: `x`, `!x`, `!!x`, `Boolean(x)` or `x != null` style comparisons.
// `comparison` is set for the last form, which is only true for an entity, never for a boolean.
function testedIdentifier(expression: Expression, allowBare: boolean): TestedIdentifier | undefined {
  let value = ts.skipOuterExpressions(expression);
  let comparison: BinaryExpression | undefined;
  if (isNegation(value)) {
    value = ts.skipOuterExpressions(value.operand);
    if (isNegation(value)) value = ts.skipOuterExpressions(value.operand);
  } else if (ts.isCallExpression(value) && ts.isIdentifier(value.expression) && value.expression.text === 'Boolean') {
    if (value.arguments.length !== 1) return;
    value = ts.skipOuterExpressions(value.arguments[0]);
  } else if (ts.isBinaryExpression(value) && nullishComparisonTokens.includes(value.operatorToken.kind)) {
    comparison = value;
    value = ts.skipOuterExpressions(value.left);
  } else if (!allowBare) return;
  return ts.isIdentifier(value) ? { identifier: value, comparison } : undefined;
}

// `if (x)` / `return !!x` / `return x != null` ... directly after `const x = ...`, with no other
// use of `x` in the block.
const logicalTokens: readonly SyntaxKind[] = [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken];

function nextGuardTest(declaration: VariableDeclaration): TestedIdentifier | undefined {
  const statement = declaration.parent.parent;
  const block = statement.parent;
  if (!ts.isIdentifier(declaration.name) || !ts.isVariableStatement(statement) || !ts.isBlock(block)) return;
  const guard = block.statements[block.statements.indexOf(statement) + 1];
  if (!guard || (!ts.isIfStatement(guard) && !ts.isReturnStatement(guard)) || !guard.expression) return;
  // `return x` hands the entity on, so only the boolean forms count as an existence test there.
  const test = testedIdentifier(guard.expression, ts.isIfStatement(guard));
  if (test?.identifier.text !== declaration.name.text) return;
  let mentions = 0;
  (function count(node: Node): void {
    if (ts.isIdentifier(node) && node.text === declaration.name.text) mentions++;
    ts.forEachChild(node, count);
  })(block);
  return mentions === 2 ? test : undefined;
}

function usedOnlyByNextGuard(declaration: VariableDeclaration): boolean {
  return Boolean(nextGuardTest(declaration));
}

// True when the awaited value is only ever tested for truthiness, so a boolean can replace the
// entity.
function usedOnlyAsCondition(awaited: Node): boolean {
  let value = skipParentheses(awaited);
  while (ts.isBinaryExpression(value.parent) && logicalTokens.includes(value.parent.operatorToken.kind)) {
    value = skipParentheses(value.parent);
  }
  const use = value.parent;
  if (ts.isVariableDeclaration(use)) return use.initializer === value && usedOnlyByNextGuard(use);
  return (
    (ts.isPrefixUnaryExpression(use) && use.operator === ts.SyntaxKind.ExclamationToken) ||
    (ts.isIfStatement(use) && use.expression === value) ||
    (ts.isConditionalExpression(use) && use.condition === value)
  );
}

function awaitOf(call: CallExpression): AwaitExpression | undefined {
  const awaited = skipParentheses(call).parent;
  if (ts.isAwaitExpression(awaited) && awaited.expression === skipParentheses(call)) return awaited;
}

// `department` -> `departmentExists`, `existing` -> `alreadyExists`: the variable now holds a
// boolean.
function booleanName(name: string): string | undefined {
  if (/^(?:found|exists|is|has|already)(?:[A-Z_]|$)|Exists$/.test(name)) return;
  if (name === 'existing') return 'alreadyExists';
  const existingThing = /^existing([A-Z])(.*)$/.exec(name);
  if (existingThing) return existingThing[1].toLowerCase() + existingThing[2] + 'AlreadyExists';
  return name + 'Exists';
}

function mentionsName(root: Node, name: string): boolean {
  let found = false;
  (function visit(node: Node): void {
    if (found) return;
    if (ts.isIdentifier(node) && node.text === name) found = true;
    else ts.forEachChild(node, visit);
  })(root);
  return found;
}

// Renames the variable and rewrites its guard. The rule only reports a const whose next guard is
// its only other use, so every use is a truthiness test. A name already used in the function is
// left alone.
function guardEdits(declaration: VariableDeclaration, declaredName: Identifier, test: TestedIdentifier): TextEdit[] {
  const oldName = declaredName.text;
  const block = declaration.parent.parent.parent;
  const candidate = booleanName(oldName);
  const renamedTo =
    candidate && !mentionsName(ancestor(block, ts.isFunctionLike) ?? block, candidate) ? candidate : undefined;
  const name = renamedTo ?? oldName;
  const edits: TextEdit[] = renamedTo ? [replaceNode(declaredName, name)] : [];
  // A boolean is never nullish, so `x != null` must collapse to `x` once x holds the existence
  // result.
  if (test.comparison) edits.push(replaceNode(test.comparison, '!!' + name));
  else if (renamedTo) edits.push(replaceNode(test.identifier, name));
  return edits;
}

function existenceFix({ finding, node }: SiteFixInput): FixResult | undefined {
  if (!node) return;
  const call = calleeCall(node);
  const method = calledMethod(call);
  const replacement = method && existenceMethodByRead[method.text];
  // The rule only reports when the receiver's type resolves this method to TypeORM, so it can be
  // called directly.
  if (!call || !method || !replacement || !finding.message.includes(`Repository.${replacement}()`)) return;
  if (call.arguments.length !== 1) return;
  const awaited = awaitOf(call);
  if (!awaited || awaited.expression !== call || !usedOnlyAsCondition(awaited)) return;
  const edits: TextEdit[] = [replaceNode(method, replacement)];
  const declaration = skipParentheses(awaited).parent;
  if (ts.isVariableDeclaration(declaration)) {
    if (declaration.type || !ts.isIdentifier(declaration.name)) return;
    const test = nextGuardTest(declaration);
    if (!test) return;
    const comparison = test.comparison;
    // A missing row is null in TypeORM but adapters can return undefined. Only loose comparisons
    // equate the two.
    if (
      comparison &&
      (comparison.operatorToken.kind !== ts.SyntaxKind.ExclamationEqualsToken ||
        comparison.right.kind !== ts.SyntaxKind.NullKeyword)
    )
      return;
    edits.push(...guardEdits(declaration, declaration.name, test));
  }
  return {
    edits,
    requiresReview: true,
    note: 'Confirm that entity-load hooks and subscribers are unnecessary for this check, and that test doubles of this repository implement the existence method.',
  };
}

function projectionFix({ finding, node, text }: SiteFixInput): FixResult | undefined {
  if (!node || text === undefined) return;
  const call = calleeCall(node);
  const method = calledMethod(call);
  const selection = /select: (\{ .+? \}) to avoid/.exec(finding.message)?.[1];
  if (!call || method?.text !== 'find' || !selection || !isWhereOnlyOptions(call)) return;
  const select = `select: ${selection}`;
  const [options] = call.arguments;
  if (!options) return { edits: [{ start: call.arguments.pos, end: call.arguments.pos, text: `{ ${select} }` }] };
  if (!ts.isObjectLiteralExpression(options)) return;
  const lastProperty = options.properties.at(-1);
  if (!lastProperty) return { edits: [{ start: options.getStart(), end: options.end, text: `{ ${select} }` }] };
  const startsOwnLine = text.slice(options.getStart(), lastProperty.getStart()).includes('\n');
  if (!startsOwnLine) return { edits: [{ start: lastProperty.end, end: lastProperty.end, text: `, ${select}` }] };
  // Multi-line literal: add the property on its own line, matching the last property's indentation
  // and comma style.
  const indentation = indentationAt(text, lastProperty.getStart());
  const trailingComma = options.properties.hasTrailingComma;
  const insertAt = trailingComma ? text.indexOf(',', lastProperty.end) + 1 : lastProperty.end;
  const addition = `\n${indentation}${select}${trailingComma ? ',' : ''}`;
  return { edits: [{ start: insertAt, end: insertAt, text: trailingComma ? addition : `,${addition}` }] };
}

// `(await repo.find(...)).length` -> `await repo.count(...)`; parentheses stay when the surrounding
// syntax needs them.
function countFix({ finding, node, text }: SiteFixInput): FixResult | undefined {
  if (!node || text === undefined) return;
  const access = node.parent;
  if (!ts.isPropertyAccessExpression(access) || access.name !== node || access.questionDotToken) return;
  const counting = countMethodByMessage.find((candidate) => finding.message.includes(`\`${candidate.marker}\``));
  const wrapped = access.expression;
  if (!counting || !ts.isParenthesizedExpression(wrapped) || !ts.isAwaitExpression(wrapped.expression)) return;
  const call = wrapped.expression.expression;
  if (!ts.isCallExpression(call)) return;
  const method = calledMethod(call);
  if (!method || method.text !== counting.read || (counting.read !== 'findBy' && !isWhereOnlyOptions(call))) return;
  const countCall =
    text.slice(call.getStart(), method.getStart()) + counting.replacement + text.slice(method.end, call.end);
  const needsNoParentheses = ts.isVariableDeclaration(access.parent) || ts.isReturnStatement(access.parent);
  const awaitedCount = `await ${countCall}`;
  return {
    edits: [
      {
        start: access.getStart(),
        end: access.end,
        text: needsNoParentheses ? awaitedCount : `(${awaitedCount})`,
      },
    ],
  };
}

export default {
  'typeorm-existence-materialization': existenceFix,
  'typeorm-wide-projection': requireReview(
    'Entities load only the selected columns, so code that reads another column sees undefined.',
    projectionFix,
  ),
  'orm-count-materialization': countFix,
};
