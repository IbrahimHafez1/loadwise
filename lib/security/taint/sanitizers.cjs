'use strict';

// Values that cannot carry injectable text (design section 2.4).
const { syntax: ts } = require('../../performance/compiler.cjs');
const { isValidatedIdentifier } = require('../pg-identifier-guards.cjs');

// Functions whose result is a number or boolean for every input.
const numericFunctions = new Set(['Number', 'parseInt', 'parseFloat', 'BigInt', 'Boolean']);

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

// The identifier passed a regex or literal-allowlist guard that dominates `use`, and is not reassigned.
function isGuarded(identifier, use, checker) {
  return isValidatedIdentifier(identifier, use, checker);
}

// Sink kinds where a string can do no harm, only an object (`{ "$ne": null }`).
function stringIsSafe(sinkKind) {
  return sinkKind === 'nosql';
}

module.exports = { isNumericCall, isPrunedType, isGuarded, stringIsSafe };
