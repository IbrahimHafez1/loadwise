'use strict';

const {
  ts,
  textOf,
  replaceNode,
  calleeCall,
  isPlainReference,
  freshName,
  indentationAt,
  lineStart,
} = require('./helpers.cjs');

function bindingNames(name, names = new Set()) {
  if (ts.isIdentifier(name)) names.add(name.text);
  else for (const element of name.elements) if (!ts.isOmittedExpression(element)) bindingNames(element.name, names);
  return names;
}

function mentionsAny(node, names) {
  if (ts.isIdentifier(node)) return names.has(node.text);
  return !!ts.forEachChild(node, (child) => mentionsAny(child, names) || undefined);
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

// `for (const x of xs) { await q.add(...) }`
function loopFix(call, sourceFile, text) {
  const awaited = call.parent;
  const statement = awaited.parent;
  if (!ts.isAwaitExpression(awaited) || !ts.isExpressionStatement(statement)) return;
  const block = statement.parent;
  const loop = block.parent;
  if (!ts.isBlock(block) || !ts.isForOfStatement(loop) || loop.awaitModifier) return;
  const declarations = ts.isVariableDeclarationList(loop.initializer) && loop.initializer.declarations;
  if (!declarations || declarations.length !== 1) return;
  const [item] = declarations;
  const receiver = call.expression.expression;
  const job = jobObject(call);
  if (!job) return;
  if (block.statements.length === 1) {
    if (!isStableReceiver(receiver, bindingNames(item.name))) return;
    const bulk = `await ${textOf(receiver)}.addBulk(${textOf(loop.expression)}.map((${textOf(item.name)}) => (${job})));`;
    return { edits: [replaceNode(loop, bulk)] };
  }
  return sideStatementsFix({ loop, item, statement, receiver, job, sourceFile, text });
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
function sideStatementsFix({ loop, item, statement, receiver, job, sourceFile, text }) {
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
  const jobs = freshName(sourceFile, 'jobs');
  if (!jobs) return;
  const indentation = indentationAt(text, loop.getStart());
  const parameter = textOf(item.name);
  const beforeText = before.length ? text.slice(lineStart(text, before[0].getStart()), statement.getStart()) : '';
  const mapped = before.length
    ? `{\n${beforeText.trimEnd()}\n${indentation}  return ${job};\n${indentation}}`
    : `(${job})`;
  const lines = [
    `const ${jobs} = ${textOf(loop.expression)}.map((${parameter}) => ${mapped});`,
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

function queueAddFix({ node, sourceFile, text }) {
  const call = calleeCall(node);
  if (!call || !ts.isPropertyAccessExpression(call.expression) || call.expression.name !== node) return;
  return loopFix(call, sourceFile, text) ?? mapFix(call);
}

module.exports = { 'queue-add-in-loop': queueAddFix };
