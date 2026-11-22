'use strict';

const {
  bindingNames,
  ts,
  textOf,
  replaceNode,
  calleeCall,
  isPlainReference,
  freshName,
  indentationAt,
  requireReview,
} = require('./helpers.cjs');

function mentionsAny(node, names) {
  if (ts.isIdentifier(node)) return names.has(node.text);
  return !!ts.forEachChild(node, (child) => mentionsAny(child, names) || undefined);
}

// True when `text` between the offsets holds a comment, which a whole-loop rewrite would silently drop.
function hasCommentBetween(text, from, to) {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, text.slice(from, to));
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan())
    if (token === ts.SyntaxKind.SingleLineCommentTrivia || token === ts.SyntaxKind.MultiLineCommentTrivia) return true;
  return false;
}

// add(name, data, opts?) as source text, or nothing when the arguments are not that shape. A bull call with two
// arguments is add(data, opts), so a name is only trusted when it is a string literal.
function jobObject(call) {
  const [name, data, opts] = call.arguments;
  if (!data || call.arguments.length > 3 || call.arguments.some(ts.isSpreadElement)) return;
  if (call.arguments.length === 2 && !ts.isStringLiteralLike(name)) return;
  const fields = [`name: ${textOf(name)}`, `data: ${textOf(data)}`];
  if (opts) fields.push(`opts: ${textOf(opts)}`);
  return `{ ${fields.join(', ')} }`;
}

// A receiver that is re-evaluated once instead of per item must not depend on the item.
function isStableReceiver(receiver, itemNames) {
  return isPlainReference(receiver) && !mentionsAny(receiver, itemNames);
}

// The jobs built from the loop's collection: `.map` only exists on arrays, so other iterables go through Array.from.
function mappedCollection(loop, collectionKind, mapper) {
  const collection = textOf(loop.expression);
  if (collectionKind !== 'array') return `Array.from(${collection}, ${mapper})`;
  const receiver = ts.isLeftHandSideExpression(loop.expression) ? collection : `(${collection})`;
  return `${receiver}.map(${mapper})`;
}

// The per-item mapper: the code and comments before the add, and comments after it, stay in its body.
function mapper({ loop, statement, parameter, job, text, trailing }) {
  const block = loop.statement;
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
function loopFix(call, finding, sourceFile, text) {
  const awaited = call.parent;
  const statement = awaited.parent;
  if (!ts.isAwaitExpression(awaited) || !ts.isExpressionStatement(statement)) return;
  const block = statement.parent;
  const loop = block.parent;
  if (!ts.isBlock(block) || !ts.isForOfStatement(loop) || loop.awaitModifier || !finding.collectionKind) return;
  const declarations = ts.isVariableDeclarationList(loop.initializer) && loop.initializer.declarations;
  if (!declarations || declarations.length !== 1) return;
  const [item] = declarations;
  const receiver = call.expression.expression;
  const job = jobObject(call);
  if (!job) return;
  // Comments in the loop header have no place in the rewrite, and ones inside the add go with its arguments.
  if (hasCommentBetween(text, loop.getStart(), block.getStart())) return;
  if (hasCommentBetween(text, statement.getStart(), statement.end)) return;
  const site = { loop, item, statement, receiver, job, sourceFile, text, collectionKind: finding.collectionKind };
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

const addOne = (node) => ts.isNumericLiteral(node) && node.text === '1';

// `counter++`, `++counter` or `counter += 1`: the counter reference, or nothing for any other statement.
function counterOf(statement) {
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

function declaredNames(statements) {
  const names = new Set();
  const visit = (node) => {
    if (ts.isVariableDeclaration(node)) bindingNames(node.name, names);
    ts.forEachChild(node, visit);
  };
  statements.forEach(visit);
  return names;
}

// True when running `node` per item inside a callback could change control flow or touch state outside the item.
function escapesItem(node, locals) {
  let escapes = false;
  (function visit(child) {
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
    if (written && !locals.has(rootName(written))) escapes = true;
    ts.forEachChild(child, visit);
  })(node);
  return escapes;
}

function writtenTarget(node) {
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

function rootName(node) {
  let current = node;
  while (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) current = current.expression;
  return ts.isIdentifier(current) ? current.text : undefined;
}

// The loop body holds work around the add: statements before it run per item, counters after it count the adds.
function sideStatementsFix(site) {
  const { loop, item, statement, receiver, sourceFile, text } = site;
  const statements = [...loop.statement.statements];
  const addIndex = statements.indexOf(statement);
  const before = statements.slice(0, addIndex);
  const counters = statements.slice(addIndex + 1).map(counterOf);
  if (counters.some((counter) => !counter)) return;
  const locals = new Set([...bindingNames(item.name), ...declaredNames(before)]);
  if (before.some((beforeStatement) => escapesItem(beforeStatement, locals))) return;
  if (!isStableReceiver(receiver, locals)) return;
  const counterNames = new Set(counters.map(rootName));
  if ([...before, statement.expression.expression].some((node) => mentionsAny(node, counterNames))) return;
  const afterText = text.slice(statement.end, statements.at(-1).end);
  if (afterText.includes('//') || afterText.includes('/*')) return;
  if (hasCommentBetween(text, statements.at(-1).end, loop.end)) return;
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
function mapFix(call) {
  const body = ts.isParenthesizedExpression(call.parent) ? call.parent : call;
  const arrow = body.parent;
  if (!ts.isArrowFunction(arrow) || arrow.body !== body) return;
  const mapCall = arrow.parent;
  if (!ts.isCallExpression(mapCall) || mapCall.arguments.length !== 1 || mapCall.arguments[0] !== arrow) return;
  if (!ts.isPropertyAccessExpression(mapCall.expression) || mapCall.expression.name.text !== 'map') return;
  const all = mapCall.parent;
  if (!ts.isCallExpression(all) || all.arguments.length !== 1 || textOf(all.expression) !== 'Promise.all') return;
  const receiver = call.expression.expression;
  const parameterNames = new Set(arrow.parameters.flatMap((parameter) => [...bindingNames(parameter.name)]));
  const job = jobObject(call);
  if (!job || !isStableReceiver(receiver, parameterNames)) return;
  const parameters = arrow.parameters.map(textOf).join(', ');
  const mapped = `${textOf(mapCall.expression)}((${parameters}) => (${job}))`;
  return { edits: [replaceNode(all, `${textOf(receiver)}.addBulk(${mapped})`)] };
}

function queueAddFix({ finding, node, sourceFile, text }) {
  const call = calleeCall(node);
  if (!call || !ts.isPropertyAccessExpression(call.expression) || call.expression.name !== node) return;
  return loopFix(call, finding, sourceFile, text) ?? mapFix(call);
}

module.exports = {
  'queue-add-in-loop': requireReview(
    'Jobs are added concurrently or in one bulk call, so their ordering and a partial failure differ from the serial loop.',
    queueAddFix,
  ),
};
