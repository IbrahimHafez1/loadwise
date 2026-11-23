'use strict';

// mongoose-aggregate-uncast-id: Mongoose does not auto-cast strings to ObjectId inside aggregate() $match stages.
// mongoose-hydrate-for-to-object: Hydrating a Mongoose Document only to immediately convert it via .toObject()/.toJSON().
const { syntax: ts } = require('./compiler.cjs');
const { declaredInPackage, propertyName } = require('./schema/ts-helpers.cjs');

const UNCAST_ID_RULE = 'mongoose-aggregate-uncast-id';
const HYDRATE_RULE = 'mongoose-hydrate-for-to-object';
const MONGOOSE_PACKAGES = ['mongoose'];
const FIND_METHODS = new Set(['find', 'findOne', 'findById']);
const OBJECT_ID_NAMES = new Set(['ObjectId', 'createFromHexString', 'createFromTime']);
const TO_PLAIN_METHODS = new Set(['toObject', 'toJSON']);
// Query builder calls that keep the chain a query, so a `.lean()` after them still skips hydration.
const QUERY_MODIFIERS = new Set(['select', 'sort', 'limit', 'skip', 'where', 'populate', 'session', 'exec', 'lean']);
const NULL_COMPARISONS = new Set([
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
]);
// A schema with a String `_id` (UUID keys) stores strings, so matching `_id` against a string is correct there.
const STRING_ID_SCHEMA =
  /\b_id\s*:\s*(?:\{[^{}]*\btype\s*:\s*)?(?:(?:mongoose\.)?(?:Schema\.Types\.)?String\b|['"]String['"])/;
// Schema-level toObject/toJSON options or overrides (transforms that strip secrets, virtuals) run only on hydrated
// documents, so `.lean()` would change the output.
const PLAIN_OUTPUT_CUSTOMIZATION =
  /\b(?:toJSON|toObject)\s*:|\.set\(\s*['"](?:toJSON|toObject)['"]|\bmethods\.(?:toJSON|toObject)\b/;

const programScans = new WeakMap();

function programSourceMatches(program, pattern) {
  if (!program?.getSourceFiles) return false;
  if (!programScans.has(program)) programScans.set(program, new Map());
  const scans = programScans.get(program);
  if (!scans.has(pattern)) {
    const matches = program
      .getSourceFiles()
      .some(
        (file) => !file.isDeclarationFile && !/[\\/]node_modules[\\/]/.test(file.fileName) && pattern.test(file.text),
      );
    scans.set(pattern, matches);
  }
  return scans.get(pattern);
}

// Mongoose only: Sequelize and other ORMs also name their base class `Model` and offer findOne/toJSON. Without
// mongoose types, declaredInPackage still accepts a receiver initialized from `mongoose.model(...)` / `model(...)`.
function isMongooseCall(call, checker) {
  const callee = ts.skipOuterExpressions(call.expression);
  return ts.isPropertyAccessExpression(callee) && declaredInPackage(callee, checker, MONGOOSE_PACKAGES);
}

function calledName(call) {
  const target = ts.skipOuterExpressions(call.expression);
  if (ts.isIdentifier(target)) return target.text;
  if (ts.isPropertyAccessExpression(target)) return target.name.text;
}

function isObjectIdExpression(node) {
  const value = ts.skipOuterExpressions(node);
  if (!ts.isNewExpression(value) && !ts.isCallExpression(value)) return false;
  return OBJECT_ID_NAMES.has(calledName(value));
}

// Only a plain string type: a union such as `string | ObjectId` may already hold an ObjectId.
function isStringTypedOrLiteral(node, checker) {
  const value = ts.skipOuterExpressions(node);
  if (ts.isStringLiteralLike(value) || ts.isTemplateExpression(value)) return true;
  const type = checker.getTypeAtLocation(value);
  return Boolean(type && type.flags & (ts.TypeFlags.String | ts.TypeFlags.StringLiteral));
}

function matchFilter(element) {
  const stage = ts.skipOuterExpressions(element);
  if (!ts.isObjectLiteralExpression(stage)) return;
  const matchProp = stage.properties.find((prop) => propertyName(prop) === '$match');
  if (!matchProp || !ts.isPropertyAssignment(matchProp)) return;
  const filter = ts.skipOuterExpressions(matchProp.initializer);
  return ts.isObjectLiteralExpression(filter) ? filter : undefined;
}

function idValue(prop) {
  if (propertyName(prop) !== '_id') return;
  if (ts.isShorthandPropertyAssignment(prop)) return prop.name;
  if (ts.isPropertyAssignment(prop)) return prop.initializer;
}

function isUncastStringId(value, checker) {
  if (isObjectIdExpression(value)) return false;
  if (ts.isObjectLiteralExpression(ts.skipOuterExpressions(value))) return false;
  return isStringTypedOrLiteral(value, checker);
}

function checkAggregateUncastId(call, context) {
  const pipeline = call.arguments[0] && ts.skipOuterExpressions(call.arguments[0]);
  if (!pipeline || !ts.isArrayLiteralExpression(pipeline)) return;
  if (programSourceMatches(context.program, STRING_ID_SCHEMA)) return;
  for (const element of pipeline.elements) {
    const filter = matchFilter(element);
    if (!filter) continue;
    for (const prop of filter.properties) {
      const value = idValue(prop);
      if (!value || !isUncastStringId(value, context.checker)) continue;
      context.report(
        value,
        UNCAST_ID_RULE,
        'Mongoose does not auto-cast strings to ObjectId inside `aggregate()` `$match` stages, so matching `_id` against a plain string silently returns no documents. Wrap the value in `new Types.ObjectId(id)`.',
      );
    }
  }
}

// The outermost call of `Model.findById(id).select(...)...`, or undefined when the chain already calls `.lean()`.
function queryChainEnd(call) {
  let current = call;
  for (;;) {
    const access = current.parent;
    if (!ts.isPropertyAccessExpression(access) || access.expression !== current) return current;
    const next = access.parent;
    if (!QUERY_MODIFIERS.has(access.name.text) || !ts.isCallExpression(next) || next.expression !== access) {
      return current;
    }
    if (access.name.text === 'lean') return;
    current = next;
  }
}

function awaitedResult(node) {
  let current = node;
  while (ts.isAwaitExpression(current.parent) || ts.isParenthesizedExpression(current.parent)) current = current.parent;
  return current;
}

// `value.toObject()` / `value?.toJSON()` with no options: options such as `{ virtuals: true }` need a Document.
function isPlainConversion(value) {
  const access = value.parent;
  if (!ts.isPropertyAccessExpression(access) || access.expression !== value) return false;
  if (!TO_PLAIN_METHODS.has(access.name.text)) return false;
  const call = access.parent;
  return ts.isCallExpression(call) && call.expression === access && call.arguments.length === 0;
}

// `docs.map((doc) => doc.toObject())`
function isMappedToPlain(value) {
  const access = value.parent;
  if (!ts.isPropertyAccessExpression(access) || access.expression !== value || access.name.text !== 'map') return false;
  const call = access.parent;
  if (!ts.isCallExpression(call) || call.expression !== access || call.arguments.length !== 1) return false;
  const callback = ts.skipOuterExpressions(call.arguments[0]);
  if (!ts.isArrowFunction(callback) || callback.parameters.length !== 1 || ts.isBlock(callback.body)) return false;
  const parameter = callback.parameters[0].name;
  const body = ts.skipOuterExpressions(callback.body);
  if (!ts.isCallExpression(body) || !ts.isPropertyAccessExpression(body.expression)) return false;
  const receiver = body.expression.expression;
  return (
    ts.isIdentifier(parameter) &&
    ts.isIdentifier(receiver) &&
    receiver.text === parameter.text &&
    isPlainConversion(receiver)
  );
}

function convertsToPlain(value) {
  return isPlainConversion(value) || isMappedToPlain(value);
}

function isNullLiteral(node) {
  const value = ts.skipOuterExpressions(node);
  return value.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(value) && value.text === 'undefined');
}

// `if (!doc)`, `doc ? ... : ...`, `doc === null`: a not-found check, which a lean result supports the same way.
function isPresenceCheck(reference) {
  const parent = reference.parent;
  if (ts.isPrefixUnaryExpression(parent)) return parent.operator === ts.SyntaxKind.ExclamationToken;
  if (ts.isIfStatement(parent) || ts.isConditionalExpression(parent)) return parent.expression === reference;
  if (ts.isBinaryExpression(parent) && NULL_COMPARISONS.has(parent.operatorToken.kind)) {
    return isNullLiteral(parent.left === reference ? parent.right : parent.left);
  }
  return false;
}

function referencesOf(declarationName, scope, checker) {
  const symbol = checker.getSymbolAtLocation(declarationName);
  const references = [];
  (function visit(node) {
    if (ts.isIdentifier(node) && node !== declarationName && checker.getSymbolAtLocation(node) === symbol) {
      references.push(node);
    }
    ts.forEachChild(node, visit);
  })(scope);
  return references;
}

// True when the stored result is only null-checked and converted: any other use (save, instance methods, virtuals,
// passing it on) needs the hydrated Document.
function variableOnlyConvertedToPlain(declaration, checker) {
  if (!ts.isVariableDeclaration(declaration) || !ts.isIdentifier(declaration.name)) return false;
  const scope = ts.findAncestor(declaration, ts.isBlock);
  if (!scope) return false;
  const references = referencesOf(declaration.name, scope, checker);
  return (
    references.some(convertsToPlain) &&
    references.every((reference) => convertsToPlain(reference) || isPresenceCheck(reference))
  );
}

function hydratesOnlyToConvert(call, checker) {
  const chainEnd = queryChainEnd(call);
  if (!chainEnd) return false;
  const result = awaitedResult(chainEnd);
  if (result === chainEnd) return false;
  if (convertsToPlain(result)) return true;
  const declaration = result.parent;
  return declaration.initializer === result && variableOnlyConvertedToPlain(declaration, checker);
}

function checkHydrateForToObject(call, context) {
  if (!hydratesOnlyToConvert(call, context.checker)) return;
  if (programSourceMatches(context.program, PLAIN_OUTPUT_CUSTOMIZATION)) return;
  context.report(
    call,
    HYDRATE_RULE,
    'This Mongoose query hydrates full Document instances only to convert them to plain objects with `.toObject()` / `.toJSON()`. Append `.lean()` to skip hydration overhead.',
  );
}

function check(call, context) {
  const callee = ts.skipOuterExpressions(call.expression);
  if (!ts.isPropertyAccessExpression(callee)) return;
  const method = callee.name.text;
  if (method === 'aggregate' && isMongooseCall(call, context.checker)) {
    checkAggregateUncastId(call, context);
  } else if (FIND_METHODS.has(method) && isMongooseCall(call, context.checker)) {
    checkHydrateForToObject(call, context);
  }
}

module.exports = { check };
