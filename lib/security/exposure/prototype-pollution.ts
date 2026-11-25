// prototype-pollution: request-controlled keys written into an object without filtering.
import { ts } from '../../performance/compiler.js';
import { unwrap } from './literals.js';
import { reportTraced } from './report.js';
import type { BinaryExpression, CallExpression, Expression, ForInStatement, ForOfStatement, Node } from 'typescript';
import type { CheckerAdapter, LibraryCall, SecurityRuleContext, Trace } from '../../shared/types.js';

const ruleId = 'prototype-pollution';
const message =
  'Keys from `<source>` are written into an object without filtering, so `__proto__` or `constructor` can change the prototype of every object. Reject those keys, or copy only known fields.';
const singleKeyReason = 'Sets one own key; pollution needs a nested write.';
const deepMergeFunctions = new Set(['merge', 'mergeWith', 'defaultsDeep']);
const pathWriteFunctions = new Set(['set', 'setWith', 'update', 'updateWith', 'setProperty']);
const pathLibraries = /^(?:lodash(?:-es)?(?:\/.*)?|object-path|dot-prop)$/;
const parameterPathReason =
  'Contextual: the key path is a function parameter; confirm callers never pass request-controlled keys.';
const prototypeWords = /__proto__|prototype|constructor/;

function reportMessage(traced: Pick<Trace, 'label'>) {
  return message.replace('<source>', traced.label);
}

function isNullPrototypeRoot(expression: Expression, checker: CheckerAdapter) {
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

// An `if`, ternary or `&&` before the write whose condition names the key and a prototype word:
// `key === '__proto__'`,
// `['__proto__', 'constructor'].includes(key)`. Either branch may be the safe one, so the write is
// not reported.
function hasPrototypeKeyGuard(key: Expression, write: Node) {
  const keyText = unwrap(key).getText();
  const scope = ts.findAncestor(write, ts.isFunctionLike) ?? write.getSourceFile();
  let guarded = false;
  (function visit(node: Node): void {
    const condition = ts.isIfStatement(node)
      ? node.expression
      : ts.isConditionalExpression(node)
        ? node.condition
        : undefined;
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

// The `__proto__` setter ignores a primitive, and an own `constructor` key set to one reaches no
// other object.
function isPrimitiveValue(expression: Expression, checker: CheckerAdapter) {
  const type = checker.getTypeAtLocation(expression);
  const members = type.isUnion() && type.types ? type.types : [type];
  return members.every((member) => member.flags & primitiveTypes);
}

function rootExpression(node: Expression) {
  let current = unwrap(node);
  while (current && (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)))
    current = unwrap(current.expression);
  return current;
}

// `target[a][b] = value`, `target[a].x = value`: the first dynamic key may name `__proto__`.
function checkAssignment(node: BinaryExpression, context: SecurityRuleContext) {
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
  if (!traced) return checkParameterPathWrite(node, context);
  if (!hasPrototypeKeyGuard(target.argumentExpression, node))
    context.report(node, ruleId, reportMessage(traced), singleKeyReason, { taint: traced });
}

function isParameterIdentifier(node: Node, checker: CheckerAdapter) {
  if (!ts.isIdentifier(node)) return false;
  const declarations = checker.getSymbolAtLocation(node)?.declarations ?? [];
  return declarations.some((declaration) => ts.isParameter(declaration));
}

function derivesFromParameter(expression: Expression, checker: CheckerAdapter) {
  let found = false;
  (function visit(node: Node): void {
    if (found) return;
    if (isParameterIdentifier(node, checker)) found = true;
    else ts.forEachChild(node, visit);
  })(expression);
  return found;
}

// `current = current[key]` inside the function that later writes `current[...]`: a nested path
// being walked.
function isWalkedPathVariable(expression: Expression, scope: Node) {
  const name = unwrap(expression);
  if (!name || !ts.isIdentifier(name)) return false;
  let walked = false;
  (function visit(node: Node): void {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left) &&
      node.left.text === name.text
    ) {
      const walkedFrom = unwrap(node.right);
      walked ||= ts.isElementAccessExpression(walkedFrom) && unwrap(walkedFrom.expression)?.getText() === name.text;
    }
    ts.forEachChild(node, visit);
  })(scope);
  return walked;
}

// minimist's setKey: a key path handed in by the caller is walked and written with no `__proto__`
// check. Whether the path is attacker-controlled depends on the callers, so this stays contextual.
function checkParameterPathWrite(node: BinaryExpression, context: SecurityRuleContext) {
  const target = unwrap(node.left);
  if (!ts.isElementAccessExpression(target) || ts.isStringLiteralLike(target.argumentExpression)) return;
  const scope = ts.findAncestor(node, ts.isFunctionLike);
  if (!scope || prototypeWords.test(scope.getText())) return;
  if (!derivesFromParameter(target.argumentExpression, context.checker)) return;
  if (!isWalkedPathVariable(target.expression, scope)) return;
  context.report(node, ruleId, reportMessage({ label: 'the key path argument' }), parameterPathReason);
}

function functionName(info: LibraryCall): string | undefined {
  if (info.method) return info.method;
  if (info.exported !== 'default') return info.exported;
  return info.module?.split('/').at(-1);
}

function sourceArguments(call: CallExpression, name: string) {
  if (name === 'mergeWith') return call.arguments.slice(1, -1);
  return call.arguments.slice(1);
}

function wholeRequest(expression: Expression, context: SecurityRuleContext) {
  const traced = context.taint.trace(expression, 'proto-key');
  return traced?.whole ? traced : undefined;
}

function checkLibraryCall(call: CallExpression, context: SecurityRuleContext) {
  const info = context.libraryCall(call);
  if (!info?.module || !pathLibraries.test(info.module) || info.tier === 'name') return;
  const name = functionName(info);
  if (name === undefined) return;
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

interface LocalFunction {
  name: string;
  body: Node;
}

function localFunctionOf(call: CallExpression, checker: CheckerAdapter): LocalFunction | undefined {
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

function assignsLoopKey(loop: Node, keyName: string) {
  let found = false;
  (function visit(node: Node): void {
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

function loopKeyName(loop: ForInStatement | ForOfStatement) {
  const declaration = loop.initializer;
  if (!ts.isVariableDeclarationList(declaration) || declaration.declarations.length !== 1) return;
  const [variable] = declaration.declarations;
  return ts.isIdentifier(variable.name) ? variable.name.text : undefined;
}

function callsItself(body: Node, name: string) {
  let found = false;
  (function visit(node: Node): void {
    if (found) return;
    if (ts.isCallExpression(node) && node.expression.getText() === name) found = true;
    ts.forEachChild(node, visit);
  })(body);
  return found;
}

// A project-local recursive merge: a key loop that assigns `target[key]` and calls the function
// again.
function isUnguardedRecursiveMerge({ name, body }: LocalFunction) {
  if (prototypeWords.test(body.getText())) return false;
  let merges = false;
  (function visit(node: Node): void {
    if ((ts.isForInStatement(node) || ts.isForOfStatement(node)) && !merges) {
      const key = loopKeyName(node);
      merges = key !== undefined && assignsLoopKey(node, key);
    }
    ts.forEachChild(node, visit);
  })(body);
  return merges && callsItself(body, name);
}

function checkLocalMerge(call: CallExpression, context: SecurityRuleContext) {
  const local = localFunctionOf(call, context.checker);
  if (!local || !isUnguardedRecursiveMerge(local)) return;
  for (const argument of call.arguments.slice(1)) {
    const traced = wholeRequest(argument, context);
    if (traced) return reportTraced(context, argument, ruleId, reportMessage(traced), traced);
  }
}

function checkCall(call: CallExpression, context: SecurityRuleContext) {
  checkLibraryCall(call, context);
  checkLocalMerge(call, context);
}

export { checkAssignment, checkCall };
