'use strict';

// prototype-pollution: request-controlled keys written into an object without filtering.
const { syntax: ts } = require('../../performance/compiler.cjs');
const { unwrap } = require('./literals.cjs');
const { reportTraced } = require('./report.cjs');

const ruleId = 'prototype-pollution';
const message =
  'Keys from `<source>` are written into an object without filtering, so `__proto__` or `constructor` can change the prototype of every object. Reject those keys, or copy only known fields.';
const singleKeyReason = 'Sets one own key; pollution needs a nested write.';
const deepMergeFunctions = new Set(['merge', 'mergeWith', 'defaultsDeep']);
const pathWriteFunctions = new Set(['set', 'setWith', 'update', 'updateWith', 'setProperty']);
const pathLibraries = /^(?:lodash(?:-es)?(?:\/.*)?|object-path|dot-prop)$/;
const prototypeWords = /__proto__|prototype|constructor/;

function reportMessage(traced) {
  return message.replace('<source>', traced.label);
}

function isNullPrototypeRoot(expression, checker) {
  const name = unwrap(expression);
  const declaration = name && ts.isIdentifier(name) ? checker.getSymbolAtLocation(name)?.valueDeclaration : undefined;
  const initializer = declaration && ts.isVariableDeclaration(declaration) && unwrap(declaration.initializer);
  if (!initializer) return false;
  if (ts.isNewExpression(initializer)) return /^(?:Map|WeakMap)$/.test(initializer.expression.getText());
  return (
    ts.isCallExpression(initializer) &&
    initializer.expression.getText() === 'Object.create' &&
    initializer.arguments.length >= 1 &&
    unwrap(initializer.arguments[0]).kind === ts.SyntaxKind.NullKeyword
  );
}

// An `if`, ternary or `&&` before the write whose condition names the key and a prototype word: `key === '__proto__'`,
// `['__proto__', 'constructor'].includes(key)`. Either branch may be the safe one, so the write is not reported.
function hasPrototypeKeyGuard(key, write) {
  const keyText = unwrap(key).getText();
  const scope = ts.findAncestor(write, ts.isFunctionLike) ?? write.getSourceFile();
  let guarded = false;
  (function visit(node) {
    const condition =
      ts.isIfStatement(node) || ts.isConditionalExpression(node) ? (node.expression ?? node.condition) : undefined;
    if (condition && condition.end <= write.getStart()) {
      const text = condition.getText();
      guarded ||= prototypeWords.test(text) && text.includes(keyText);
    }
    ts.forEachChild(node, visit);
  })(scope);
  return guarded;
}

const primitiveTypes =
  ts.TypeFlags.StringLike |
  ts.TypeFlags.NumberLike |
  ts.TypeFlags.BooleanLike |
  ts.TypeFlags.BigIntLike |
  ts.TypeFlags.Undefined |
  ts.TypeFlags.Null;

// The `__proto__` setter ignores a primitive, and an own `constructor` key set to one reaches no other object.
function isPrimitiveValue(expression, checker) {
  const type = checker.getTypeAtLocation(expression);
  const members = type.isUnion() ? type.types : [type];
  return members.every((member) => member.flags & primitiveTypes);
}

function rootExpression(node) {
  let current = unwrap(node);
  while (current && (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)))
    current = unwrap(current.expression);
  return current;
}

// `target[a][b] = value`, `target[a].x = value`: the first dynamic key may name `__proto__`.
function checkAssignment(node, context) {
  if (node.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return;
  const target = unwrap(node.left);
  if (!ts.isElementAccessExpression(target) && !ts.isPropertyAccessExpression(target)) return;
  if (isNullPrototypeRoot(rootExpression(target), context.checker)) return;
  for (let access = unwrap(target.expression); access; access = unwrap(access.expression)) {
    if (!ts.isElementAccessExpression(access) && !ts.isPropertyAccessExpression(access)) break;
    if (!ts.isElementAccessExpression(access) || ts.isStringLiteralLike(access.argumentExpression)) continue;
    const traced = context.taint.trace(access.argumentExpression, 'proto-key');
    if (traced && hasPrototypeKeyGuard(access.argumentExpression, node)) return;
    if (traced) return reportTraced(context, node, ruleId, reportMessage(traced), traced);
  }
  if (!ts.isElementAccessExpression(target) || ts.isStringLiteralLike(target.argumentExpression)) return;
  if (isPrimitiveValue(node.right, context.checker)) return;
  const traced = context.taint.trace(target.argumentExpression, 'proto-key');
  if (traced && !hasPrototypeKeyGuard(target.argumentExpression, node))
    context.report(node, ruleId, reportMessage(traced), singleKeyReason, { taint: traced });
}

function functionName(info) {
  if (info.method) return info.method;
  if (info.exported !== 'default') return info.exported;
  return info.module.split('/').at(-1);
}

function sourceArguments(call, name) {
  if (name === 'mergeWith') return call.arguments.slice(1, -1);
  return call.arguments.slice(1);
}

function wholeRequest(expression, context) {
  const traced = context.taint.trace(expression, 'proto-key');
  return traced?.whole ? traced : undefined;
}

function checkLibraryCall(call, context) {
  const info = context.libraryCall(call);
  if (!info?.module || !pathLibraries.test(info.module) || info.tier === 'name') return;
  const name = functionName(info);
  if (deepMergeFunctions.has(name)) {
    for (const argument of sourceArguments(call, name)) {
      const traced = wholeRequest(argument, context);
      if (traced) return reportTraced(context, argument, ruleId, reportMessage(traced), traced);
    }
  } else if (pathWriteFunctions.has(name) && call.arguments.length >= 3) {
    if (isNullPrototypeRoot(call.arguments[0], context.checker)) return;
    const traced = context.taint.trace(call.arguments[1], 'proto-key');
    if (traced && !hasPrototypeKeyGuard(call.arguments[1], call))
      reportTraced(context, call.arguments[1], ruleId, reportMessage(traced), traced);
  }
}

function localFunctionOf(call, checker) {
  const callee = unwrap(call.expression);
  if (!ts.isIdentifier(callee)) return;
  let symbol = checker.getSymbolAtLocation(callee);
  if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
  const declaration = symbol?.valueDeclaration;
  if (!declaration || declaration.getSourceFile().isDeclarationFile) return;
  if (ts.isFunctionDeclaration(declaration)) return { name: callee.text, body: declaration };
  const initializer = ts.isVariableDeclaration(declaration) && unwrap(declaration.initializer);
  if (initializer && (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)))
    return { name: callee.text, body: initializer };
}

function assignsLoopKey(loop, keyName) {
  let found = false;
  (function visit(node) {
    if (found) return;
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isElementAccessExpression(node.left) &&
      node.left.argumentExpression.getText() === keyName
    )
      found = true;
    ts.forEachChild(node, visit);
  })(loop);
  return found;
}

function loopKeyName(loop) {
  const declaration = loop.initializer;
  if (!ts.isVariableDeclarationList(declaration) || declaration.declarations.length !== 1) return;
  const [variable] = declaration.declarations;
  return ts.isIdentifier(variable.name) ? variable.name.text : undefined;
}

function callsItself(body, name) {
  let found = false;
  (function visit(node) {
    if (found) return;
    if (ts.isCallExpression(node) && node.expression.getText() === name) found = true;
    ts.forEachChild(node, visit);
  })(body);
  return found;
}

// A project-local recursive merge: a key loop that assigns `target[key]` and calls the function again.
function isUnguardedRecursiveMerge({ name, body }) {
  if (prototypeWords.test(body.getText())) return false;
  let merges = false;
  (function visit(node) {
    if ((ts.isForInStatement(node) || ts.isForOfStatement(node)) && !merges) {
      const key = loopKeyName(node);
      merges = Boolean(key) && assignsLoopKey(node, key);
    }
    ts.forEachChild(node, visit);
  })(body);
  return merges && callsItself(body, name);
}

function checkLocalMerge(call, context) {
  const local = localFunctionOf(call, context.checker);
  if (!local || !isUnguardedRecursiveMerge(local)) return;
  for (const argument of call.arguments.slice(1)) {
    const traced = wholeRequest(argument, context);
    if (traced) return reportTraced(context, argument, ruleId, reportMessage(traced), traced);
  }
}

function checkCall(call, context) {
  checkLibraryCall(call, context);
  checkLocalMerge(call, context);
}

module.exports = { checkAssignment, checkCall };
