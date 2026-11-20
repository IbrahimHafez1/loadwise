'use strict';

// `prisma-scope-unverified`: a Prisma delegate call on a model that backend-perf.policy.json protects must prove
// its scope with the configured field and trusted authorization function. Needs resolved Prisma client types.
const { syntax: ts } = require('../../performance/compiler.cjs');
const { prismaModelName, prismaModelNameFromReceiver } = require('../../performance/prisma.cjs');
const { fields, plain, scopedData, trustedValue } = require('../../performance/query-policy.cjs').scopeEvidence();

const READS = new Set([
  'findMany',
  'findUnique',
  'findUniqueOrThrow',
  'findFirst',
  'findFirstOrThrow',
  'count',
  'aggregate',
  'groupBy',
  'delete',
  'deleteMany',
]);
const UPDATES = new Set(['update', 'updateMany', 'updateManyAndReturn']);
const CREATES = new Set(['create', 'createMany', 'createManyAndReturn']);
const KNOWN = new Set([...READS, ...UPDATES, ...CREATES, 'upsert', 'findRaw', 'aggregateRaw']);
function scopedWhere(expression, scope, checker) {
  const condition = fields(expression);
  if (!condition) return false;
  const direct = condition.get(scope.field);
  if (direct) {
    const equality = fields(direct);
    if (
      trustedValue(direct, scope, checker) ||
      (equality?.size === 1 && equality.has('equals') && trustedValue(equality.get('equals'), scope, checker))
    )
      return true;
  }
  // Any verified conjunct narrows every result. Every alternative of a disjunction must narrow it.
  const conjunction = plain(condition.get('AND'));
  if (
    conjunction &&
    (ts.isArrayLiteralExpression(conjunction)
      ? conjunction.elements.some((element) => scopedWhere(element, scope, checker))
      : scopedWhere(conjunction, scope, checker))
  )
    return true;
  const alternatives = plain(condition.get('OR'));
  return Boolean(
    alternatives &&
    ts.isArrayLiteralExpression(alternatives) &&
    alternatives.elements.length &&
    alternatives.elements.every((element) => scopedWhere(element, scope, checker)),
  );
}

function booleanSelection(type) {
  if (!type) return false;
  if (type.isUnion()) return type.types.every(booleanSelection);
  return Boolean(type.flags & (ts.TypeFlags.BooleanLike | ts.TypeFlags.Undefined));
}

function scalarProjection(options, scope, checker) {
  if (options.has('include')) return false;
  if (!options.has('select')) return true;
  const selection = fields(options.get('select'));
  return (
    selection &&
    [...selection].every(
      ([key, value]) =>
        value.kind === ts.SyntaxKind.FalseKeyword ||
        (value.kind === ts.SyntaxKind.TrueKeyword &&
          (key === scope.field || booleanSelection(checker.getContextualType(value)))),
    )
  );
}

function missingEvidence(call, operation, scope, context) {
  if (!context.strictNullChecks) return 'Enable strictNullChecks to verify the scope value.';
  let result = call;
  while (ts.isParenthesizedExpression(result.parent)) result = result.parent;
  const chained = result.parent;
  if (
    (ts.isPropertyAccessExpression(chained) || ts.isElementAccessExpression(chained)) &&
    chained.expression === result &&
    ts.isCallExpression(chained.parent) &&
    chained.parent.expression === chained
  ) {
    const name = ts.isPropertyAccessExpression(chained) ? chained.name : chained.argumentExpression;
    if (!['then', 'catch', 'finally'].includes(name.text))
      return 'A chained relation lookup needs a separate scope review.';
  }
  const options = fields(call.arguments[0]);
  if (call.arguments.length !== 1 || !options) return 'Use explicit query options so the scope can be checked.';
  const checker = context.checker;
  if (!scalarProjection(options, scope, checker))
    return 'The projection may return related records. Verify their scope separately.';
  if (!(READS.has(operation) || UPDATES.has(operation) || CREATES.has(operation) || operation === 'upsert')) {
    return 'This delegate operation needs a separate scope review.';
  }
  if (!CREATES.has(operation) && !scopedWhere(options.get('where'), scope, checker)) {
    return 'Constrain where.' + scope.field + ' to the scalar returned by the configured authorization function.';
  }
  if (CREATES.has(operation)) {
    const data = plain(options.get('data'));
    const rows = data && operation !== 'create' && ts.isArrayLiteralExpression(data) ? data.elements : [data];
    if (!rows.length || !rows.every((row) => scopedData(row, scope, checker, true))) {
      return 'Each created row needs a proven scope and verifiable scalar write data.';
    }
  }
  if (UPDATES.has(operation) && !scopedData(options.get('data'), scope, checker, false)) {
    return 'Verify the update preserves the authorized scope, including any nested relation writes.';
  }
  if (
    operation === 'upsert' &&
    !(
      scopedData(options.get('create'), scope, checker, true) &&
      scopedData(options.get('update'), scope, checker, false)
    )
  ) {
    return 'Verify the scope of both the create and update branches.';
  }
}

function checkQueryPolicy(call, context) {
  const scopes = context.policy?.prismaScopes;
  if (!scopes) return;
  const access = call.expression;
  const dot = ts.isPropertyAccessExpression(access);
  if (!dot && !ts.isElementAccessExpression(access)) return;
  const key = dot ? access.name : access.argumentExpression;
  const operation = dot || ts.isStringLiteralLike(key) ? key.text : '';
  const receiver = access.expression;
  const spelling = ts.isPropertyAccessExpression(receiver)
    ? receiver.name.text
    : ts.isIdentifier(receiver)
      ? receiver.text
      : '';
  const configuredName =
    spelling &&
    (Object.hasOwn(scopes, spelling) || Object.hasOwn(scopes, spelling[0].toUpperCase() + spelling.slice(1)));
  const dynamicKey = !dot && !ts.isStringLiteralLike(key);
  if (!KNOWN.has(operation) && !configuredName && !dynamicKey) return;
  const model = operation && prismaModelName(key, context.checker);
  const verifiedModel =
    model || ((configuredName || dynamicKey) && prismaModelNameFromReceiver(receiver, context.checker));
  if (!verifiedModel || !Object.hasOwn(scopes, verifiedModel)) return;
  const detail =
    model || (!dot && KNOWN.has(operation))
      ? missingEvidence(call, operation, scopes[verifiedModel], context)
      : 'This delegate operation needs a separate scope review.';
  if (detail) context.report(key, 'prisma-scope-unverified', verifiedModel + ' scope policy: ' + detail);
}

module.exports = { checks: { CallExpression: [checkQueryPolicy] } };
