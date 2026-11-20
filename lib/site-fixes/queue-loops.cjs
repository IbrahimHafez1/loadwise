'use strict';

const { ts, textOf, replaceNode, calleeCall, isPlainReference } = require('./helpers.cjs');

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
function loopFix(call) {
  const awaited = call.parent;
  const statement = awaited.parent;
  if (!ts.isAwaitExpression(awaited) || !ts.isExpressionStatement(statement)) return;
  const block = statement.parent;
  const loop = block.parent;
  if (!ts.isBlock(block) || block.statements.length !== 1 || !ts.isForOfStatement(loop) || loop.awaitModifier) return;
  const declarations = ts.isVariableDeclarationList(loop.initializer) && loop.initializer.declarations;
  if (!declarations || declarations.length !== 1) return;
  const [item] = declarations;
  const receiver = call.expression.expression;
  const job = jobObject(call);
  if (!job || !isStableReceiver(receiver, bindingNames(item.name))) return;
  const bulk = `await ${textOf(receiver)}.addBulk(${textOf(loop.expression)}.map((${textOf(item.name)}) => (${job})));`;
  return { edits: [replaceNode(loop, bulk)] };
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

function queueAddFix({ node }) {
  const call = calleeCall(node);
  if (!call || !ts.isPropertyAccessExpression(call.expression) || call.expression.name !== node) return;
  return loopFix(call) ?? mapFix(call);
}

module.exports = { 'queue-add-in-loop': queueAddFix };
