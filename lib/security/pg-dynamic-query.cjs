'use strict';

// `pg-dynamic-query-text`: node-postgres query text assembled from a runtime value that is neither a constant
// fragment nor an identifier validated against an allowlist or a closed regex. Needs resolved pg types.
const { syntax: ts } = require('../performance/compiler.cjs');
const { analyzeFragment } = require('../performance/pg-fragments.cjs');
const { queryMethod, textArgument, usesDriverQuery, queryTypes } = require('../performance/pg-integrity.cjs');
const { allRuntimePartsValidated } = require('./pg-identifier-guards.cjs');

function check(call, context) {
  if (!queryMethod(call)) return;
  const query = textArgument(call.arguments[0]);
  if (!query) return;
  const concatenation = ts.isBinaryExpression(query) && query.operatorToken.kind === ts.SyntaxKind.PlusToken;
  if (!ts.isTemplateExpression(query) && !concatenation) return;
  if (!usesDriverQuery(call, call.expression.expression, queryTypes, context)) return;
  if (concatenation && !(context.checker.getTypeAtLocation(query).flags & ts.TypeFlags.StringLike)) return;
  if (analyzeFragment(query, context.checker) !== undefined) return;
  if (allRuntimePartsValidated(query, call, context.checker)) return;
  context.report(
    query,
    'pg-dynamic-query-text',
    'A runtime value is concatenated into SQL text, which defeats parameter binding and the plan cache and allows injection. Pass data as `$1` placeholders with a values array; pick dynamic identifiers from a fixed allowlist.',
  );
}

module.exports = { checks: { CallExpression: [check] } };
