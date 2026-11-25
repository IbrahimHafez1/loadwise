// Values that cannot carry injectable text (design section 2.4).
import { ts } from '../../performance/compiler.js';
import { isGuardedUse } from './guards.js';
import type { CallExpression, Identifier, Node } from 'typescript';
import type { CheckerAdapter, SinkKind, TypeAdapter } from '../../shared/types.js';

// Functions whose result is a number or boolean for every input.
const numericFunctions = new Set(['Number', 'parseInt', 'parseFloat', 'BigInt', 'Boolean']);
const regexMetacharacters = /[.*+?^${}()|[\]\\]/g;

function isNumericCall(call: CallExpression) {
  const callee = ts.skipOuterExpressions(call.expression);
  if (ts.isIdentifier(callee)) return numericFunctions.has(callee.text);
  return (
    ts.isPropertyAccessExpression(callee) &&
    ts.isIdentifier(callee.expression) &&
    (callee.expression.text === 'Math' ||
      (callee.expression.text === 'Number' && ['parseInt', 'parseFloat'].includes(callee.name.text)))
  );
}

function isDate(type: TypeAdapter) {
  return type.getSymbol()?.name === 'Date';
}

function scalarOnly(type: TypeAdapter): boolean {
  const flags = ts.TypeFlags;
  if (type.isUnion()) return (type.types ?? []).every(scalarOnly);
  if (
    type.flags &
    (flags.NumberLike | flags.BigIntLike | flags.BooleanLike | flags.EnumLike | flags.Null | flags.Undefined)
  )
    return true;
  return !!(type.flags & flags.StringLiteral) || isDate(type);
}

// A resolved number, bigint, boolean, enum, Date or string-literal union. any, unknown and
// unresolved types never prune, so missing packages can only remove pruning, never add it.
function isPrunedType(node: Node, checker: CheckerAdapter) {
  const type = checker.getTypeAtLocation(node);
  if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Never)) return false;
  if (
    type.isUnion() &&
    (type.types ?? []).every((member) => member.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined))
  )
    return false;
  return scalarOnly(type);
}

// The identifier passed a guard that pins its value before `use` (see guards.cjs), and is not
// reassigned.
function isGuarded(identifier: Identifier, use: Node, checker: CheckerAdapter, filename?: boolean) {
  return isGuardedUse(identifier, use, checker, filename);
}

// Sink kinds where a string can do no harm, only an object (`{ "$ne": null }`).
function stringIsSafe(sinkKind: SinkKind) {
  return sinkKind === 'nosql';
}

function couldBeString(node: Node, checker: CheckerAdapter) {
  const type = checker.getTypeAtLocation(node);
  const stringFlags = ts.TypeFlags.StringLike | ts.TypeFlags.Any | ts.TypeFlags.Unknown;
  return (type.isUnion() ? (type.types ?? []) : [type]).some((member) => member.flags & stringFlags);
}

// Recognize the full metacharacter escape without evaluating a regex from source under review.
function isRegexEscape(call: CallExpression, checker: CheckerAdapter) {
  const callee = ts.skipOuterExpressions(call.expression);
  if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== 'replace') return false;
  const [pattern, replacement] = call.arguments;
  return (
    pattern &&
    ts.isRegularExpressionLiteral(pattern) &&
    pattern.text === regexMetacharacters.toString() &&
    replacement &&
    ts.isStringLiteralLike(replacement) &&
    replacement.text === '\\$&' &&
    couldBeString(callee.expression, checker)
  );
}

export { isNumericCall, isPrunedType, isGuarded, stringIsSafe, couldBeString, isRegexEscape };
