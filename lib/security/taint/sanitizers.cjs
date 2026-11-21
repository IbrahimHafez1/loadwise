'use strict';

// Values that cannot carry injectable text (design section 2.4).
const { syntax: ts } = require('../../performance/compiler.cjs');
const { isGuardedUse } = require('./guards.cjs');

// Functions whose result is a number or boolean for every input.
const numericFunctions = new Set(['Number', 'parseInt', 'parseFloat', 'BigInt', 'Boolean']);
const regexMetacharacters = /[.*+?^${}()|[\]\\]/g;

function isNumericCall(call) {
  const callee = ts.skipOuterExpressions(call.expression);
  if (ts.isIdentifier(callee)) return numericFunctions.has(callee.text);
  return (
    ts.isPropertyAccessExpression(callee) &&
    ts.isIdentifier(callee.expression) &&
    (callee.expression.text === 'Math' ||
      (callee.expression.text === 'Number' && ['parseInt', 'parseFloat'].includes(callee.name.text)))
  );
}

function isDate(type) {
  return type.getSymbol()?.name === 'Date';
}

function scalarOnly(type) {
  const flags = ts.TypeFlags;
  if (type.isUnion()) return type.types.every(scalarOnly);
  if (
    type.flags &
    (flags.NumberLike | flags.BigIntLike | flags.BooleanLike | flags.EnumLike | flags.Null | flags.Undefined)
  )
    return true;
  return type.isStringLiteral() || isDate(type);
}

// A resolved number, bigint, boolean, enum, Date or string-literal union. any, unknown and unresolved types never
// prune, so missing packages can only remove pruning, never add it.
function isPrunedType(node, checker) {
  const type = checker.getTypeAtLocation(node);
  if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Never)) return false;
  if (type.isUnion() && type.types.every((member) => member.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined)))
    return false;
  return scalarOnly(type);
}

// The identifier passed a guard that pins its value before `use` (see guards.cjs), and is not reassigned.
function isGuarded(identifier, use, checker) {
  return isGuardedUse(identifier, use, checker);
}

// Sink kinds where a string can do no harm, only an object (`{ "$ne": null }`).
function stringIsSafe(sinkKind) {
  return sinkKind === 'nosql';
}

function couldBeString(node, checker) {
  const type = checker.getTypeAtLocation(node);
  const stringFlags = ts.TypeFlags.StringLike | ts.TypeFlags.Any | ts.TypeFlags.Unknown;
  return (type.isUnion() ? type.types : [type]).some((member) => member.flags & stringFlags);
}

// Recognize the full metacharacter escape without evaluating a regex from source under review.
function isRegexEscape(call, checker) {
  const callee = ts.skipOuterExpressions(call.expression);
  if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== 'replace') return false;
  const [pattern, replacement] = call.arguments;
  return (
    pattern?.kind === ts.SyntaxKind.RegularExpressionLiteral &&
    pattern.text === regexMetacharacters.toString() &&
    replacement &&
    ts.isStringLiteralLike(replacement) &&
    replacement.text === '\\$&' &&
    couldBeString(callee.expression, checker)
  );
}

module.exports = { isNumericCall, isPrunedType, isGuarded, stringIsSafe, couldBeString, isRegexEscape };
