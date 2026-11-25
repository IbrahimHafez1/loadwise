import {
  bindingNames,
  ts,
  textOf,
  replaceNode,
  calleeCall,
  isPlainReference,
  freshName,
  indentationAt,
  requireReview,
  hasCommentBetween,
} from './helpers.js';
import { isMethodCall } from './method-calls.js';
import type {
  Block,
  CallExpression,
  Expression,
  ExpressionStatement,
  ForOfStatement,
  Node,
  ParameterDeclaration,
  SourceFile,
  Statement,
  VariableDeclaration,
} from 'typescript';
import type { MethodCall } from '../types/method-call.js';
import type { Finding, FixResult, SiteFixInput } from '../../shared/types.js';

/**
 * A `for (const item of items) { ...; await queue.add(...); ... }` the rewrite turns into one
 * addBulk call.
 */
interface QueueLoopSite {
  loop: ForOfStatement;
  block: Block;
  item: VariableDeclaration;
  statement: ExpressionStatement;
  call: MethodCall;
  receiver: Expression;
  job: string;
  sourceFile: SourceFile;
  text: string;
  collectionKind: string;
}

/** What the per-item mapper is built from. */
interface MapperInput {
  loop: ForOfStatement;
  block: Block;
  statement: Statement;
  parameter: string;
  job: string;
  text: string;
  trailing: boolean;
}

function mentionsAny(node: Node, names: ReadonlySet<string>): boolean {
  if (ts.isIdentifier(node)) return names.has(node.text);
  return !!ts.forEachChild(node, (child) => mentionsAny(child, names) || undefined);
}

// add(name, data, opts?) as source text, or nothing when the arguments are not that shape. A bull
// call with two arguments is add(data, opts), so a name is only trusted when it is a string
// literal.
function jobObject(call: CallExpression): string | undefined {
  const [name, data, opts] = call.arguments;
  if (!data || call.arguments.length > 3 || call.arguments.some(ts.isSpreadElement)) return;
  if (call.arguments.length === 2 && !ts.isStringLiteralLike(name)) return;
  const fields = [`name: ${textOf(name)}`, `data: ${textOf(data)}`];
  if (opts) fields.push(`opts: ${textOf(opts)}`);
  return `{ ${fields.join(', ')} }`;
}

// A receiver that is re-evaluated once instead of per item must not depend on the item.
function isStableReceiver(receiver: Expression, itemNames: ReadonlySet<string>): boolean {
  return isPlainReference(receiver) && !mentionsAny(receiver, itemNames);
}

// The jobs built from the loop's collection: `.map` only exists on arrays, so other iterables go
// through Array.from.
function mappedCollection(loop: ForOfStatement, collectionKind: string, mapper: string): string {
  const collection = textOf(loop.expression);
  if (collectionKind !== 'array') return `Array.from(${collection}, ${mapper})`;
  const receiver = ts.isLeftHandSideExpression(loop.expression) ? collection : `(${collection})`;
  return `${receiver}.map(${mapper})`;
}

// The per-item mapper: the code and comments before the add, and comments after it, stay in its
// body.
function mapper({ loop, block, statement, parameter, job, text, trailing }: MapperInput): string {
  const indentation = indentationAt(text, loop.getStart());
  const leading = text
    .slice(block.getStart() + 1, statement.getStart())
    .replace(/^[ \t]*\r?\n/, '')
    .trimEnd();
  const after = trailing ? text.slice(statement.end, block.end - 1).trimEnd() : '';
  if (!leading && !after) return `(${parameter}) => (${job})`;
  const lines = [...(leading ? [leading] : []), `${indentation}  return ${job};${after}`, `${indentation}}`];
  return `(${parameter}) => {\n${lines.join('\n')}`;
}

// `for (const x of xs) { await q.add(...) }`
function loopFix(call: MethodCall, finding: Finding, sourceFile: SourceFile, text: string): FixResult | undefined {
  const awaited = call.parent;
  const statement = awaited.parent;
  if (!ts.isAwaitExpression(awaited) || !ts.isExpressionStatement(statement)) return;
  const block = statement.parent;
  const loop = block.parent;
  const { collectionKind } = finding;
  if (!ts.isBlock(block) || !ts.isForOfStatement(loop) || loop.awaitModifier) return;
  if (typeof collectionKind !== 'string' || !collectionKind) return;
  const declarations = ts.isVariableDeclarationList(loop.initializer) && loop.initializer.declarations;
  if (!declarations || declarations.length !== 1) return;
  const [item] = declarations;
  const receiver = call.expression.expression;
  const job = jobObject(call);
  if (!job) return;
  // Comments in the loop header have no place in the rewrite, and ones inside the add go with its
  // arguments.
  if (hasCommentBetween(text, loop.getStart(), block.getStart())) return;
  if (hasCommentBetween(text, statement.getStart(), statement.end)) return;
  const site: QueueLoopSite = { loop, block, item, statement, call, receiver, job, sourceFile, text, collectionKind };
  if (block.statements.length === 1) {
    if (!isStableReceiver(receiver, bindingNames(item.name))) return;
    const jobs = mappedCollection(
      loop,
      site.collectionKind,
      mapper({ ...site, parameter: textOf(item.name), trailing: true }),
    );
    return { edits: [replaceNode(loop, `await ${textOf(receiver)}.addBulk(${jobs});`)] };
  }
  return sideStatementsFix(site);
}

const addOne = (node: Node) => ts.isNumericLiteral(node) && node.text === '1';

// `counter++`, `++counter` or `counter += 1`: the counter reference, or nothing for any other
// statement.
function counterOf(statement: Statement): Expression | undefined {
  if (!ts.isExpressionStatement(statement)) return;
  const expression = statement.expression;
  const increments =
    (ts.isPostfixUnaryExpression(expression) || ts.isPrefixUnaryExpression(expression)) &&
    expression.operator === ts.SyntaxKind.PlusPlusToken;
  if (increments && isPlainReference(expression.operand)) return expression.operand;
  const addsOne =
    ts.isBinaryExpression(expression) &&
    expression.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken &&
    addOne(expression.right);
  if (addsOne && isPlainReference(expression.left)) return expression.left;
}

function declaredNames(statements: readonly Statement[]): Set<string> {
  const names = new Set<string>();
  const visit = (node: Node) => {
    if (ts.isVariableDeclaration(node)) bindingNames(node.name, names);
    ts.forEachChild(node, visit);
  };
  statements.forEach(visit);
  return names;
}

// True when running `node` per item inside a callback could change control flow or touch state
// outside the item.
function escapesItem(node: Node, locals: ReadonlySet<string>): boolean {
  let escapes = false;
  (function visit(child: Node): void {
    if (escapes) return;
    if (ts.isFunctionLike(child)) return;
    if (
      ts.isAwaitExpression(child) ||
      ts.isYieldExpression(child) ||
      ts.isReturnStatement(child) ||
      ts.isBreakStatement(child) ||
      ts.isContinueStatement(child)
    ) {
      escapes = true;
    }
    const written = writtenTarget(child);
    const writtenRoot = written && rootName(written);
    if (written && (writtenRoot === undefined || !locals.has(writtenRoot))) escapes = true;
    ts.forEachChild(child, visit);
  })(node);
  return escapes;
}

function writtenTarget(node: Node): Expression | undefined {
  if (ts.isBinaryExpression(node)) {
    const operator = node.operatorToken.kind;
    return operator >= ts.SyntaxKind.FirstAssignment && operator <= ts.SyntaxKind.LastAssignment
      ? node.left
      : undefined;
  }
  const increments = ts.isPostfixUnaryExpression(node) || ts.isPrefixUnaryExpression(node);
  if (increments && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator))
    return node.operand;
}

function rootName(node: Node): string | undefined {
  let current: Node = node;
  while (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) current = current.expression;
  return ts.isIdentifier(current) ? current.text : undefined;
}

// The loop body holds work around the add: statements before it run per item, counters after it
// count the adds.
function sideStatementsFix(site: QueueLoopSite): FixResult | undefined {
  const { loop, block, item, statement, call, receiver, sourceFile, text } = site;
  const statements = [...block.statements];
  const addIndex = statements.indexOf(statement);
  const before = statements.slice(0, addIndex);
  const counters: Expression[] = [];
  for (const later of statements.slice(addIndex + 1)) {
    const counter = counterOf(later);
    if (!counter) return;
    counters.push(counter);
  }
  const locals = new Set([...bindingNames(item.name), ...declaredNames(before)]);
  if (before.some((beforeStatement) => escapesItem(beforeStatement, locals))) return;
  if (!isStableReceiver(receiver, locals)) return;
  const counterNames = new Set(counters.flatMap((counter) => rootName(counter) ?? []));
  if ([...before, call].some((node) => mentionsAny(node, counterNames))) return;
  const lastStatement = statements[statements.length - 1];
  const afterText = text.slice(statement.end, lastStatement.end);
  if (afterText.includes('//') || afterText.includes('/*')) return;
  if (hasCommentBetween(text, lastStatement.end, loop.end)) return;
  const jobs = freshName(sourceFile, 'jobs');
  if (!jobs) return;
  const indentation = indentationAt(text, loop.getStart());
  const mapped = mapper({ ...site, parameter: textOf(item.name), trailing: false });
  const lines = [
    `const ${jobs} = ${mappedCollection(loop, site.collectionKind, mapped)};`,
    `await ${textOf(receiver)}.addBulk(${jobs});`,
    ...counters.map((counter) => `${textOf(counter)} += ${jobs}.length;`),
  ];
  const note =
    'The jobs are now built for every item first and queued in one addBulk call, so a failure queues none of them instead of the ones before it.' +
    (before.length ? ' The statements that ran before the add now run for every item before anything is queued.' : '');
  return {
    edits: [replaceNode(loop, lines.join(`\n${indentation}`))],
    note,
  };
}

// `await Promise.all(xs.map((x) => q.add(...)))`
function mapFix(call: MethodCall): FixResult | undefined {
  const body = ts.isParenthesizedExpression(call.parent) ? call.parent : call;
  const arrow = body.parent;
  if (!ts.isArrowFunction(arrow) || arrow.body !== body) return;
  const mapCall = arrow.parent;
  if (!ts.isCallExpression(mapCall) || mapCall.arguments.length !== 1 || mapCall.arguments[0] !== arrow) return;
  if (!ts.isPropertyAccessExpression(mapCall.expression) || mapCall.expression.name.text !== 'map') return;
  const all = mapCall.parent;
  if (!ts.isCallExpression(all) || all.arguments.length !== 1 || textOf(all.expression) !== 'Promise.all') return;
  const receiver = call.expression.expression;
  const parameterNames = new Set(
    arrow.parameters.flatMap((parameter: ParameterDeclaration) => [...bindingNames(parameter.name)]),
  );
  const job = jobObject(call);
  if (!job || !isStableReceiver(receiver, parameterNames)) return;
  const parameters = arrow.parameters.map(textOf).join(', ');
  const mapped = `${textOf(mapCall.expression)}((${parameters}) => (${job}))`;
  return { edits: [replaceNode(all, `${textOf(receiver)}.addBulk(${mapped})`)] };
}

function queueAddFix({ finding, node, sourceFile, text }: SiteFixInput): FixResult | undefined {
  if (!node || !sourceFile || text === undefined) return;
  const call = calleeCall(node);
  if (!call || !isMethodCall(call) || call.expression.name !== node) return;
  return loopFix(call, finding, sourceFile, text) ?? mapFix(call);
}

export default {
  'queue-add-in-loop': requireReview(
    'Jobs are added concurrently or in one bulk call, so their ordering and a partial failure differ from the serial loop.',
    queueAddFix,
  ),
};
