// `pg-dynamic-query-text`: node-postgres query text assembled from a runtime value that is neither
// a constant fragment nor an identifier validated against an allowlist or a closed regex. Needs
// resolved pg types.
import { loadSyntax } from '../performance/compiler.cjs';
import { analyzeFragment } from '../performance/pg-fragments.cjs';
import { queryMethod, textArgument, usesDriverQuery, queryTypes } from '../performance/pg-integrity.cjs';
import { allRuntimePartsValidated } from './pg-identifier-guards.cjs';
import type { CallExpression } from 'typescript';
import type { RuleContext } from '../shared/types.cjs';
const ts = loadSyntax();

function check(call: CallExpression, context: RuleContext) {
  if (!queryMethod(call)) return;
  const query = textArgument(call.arguments[0]);
  if (!query) return;
  const concatenation = ts.isBinaryExpression(query) && query.operatorToken.kind === ts.SyntaxKind.PlusToken;
  if (!ts.isTemplateExpression(query) && !concatenation) return;
  const callee = call.expression;
  if (!ts.isPropertyAccessExpression(callee) && !ts.isElementAccessExpression(callee)) return;
  if (!usesDriverQuery(call, callee.expression, queryTypes, context)) return;
  if (concatenation && !(context.checker.getTypeAtLocation(query).flags & ts.TypeFlags.StringLike)) return;
  if (analyzeFragment(query, context.checker) !== undefined) return;
  if (allRuntimePartsValidated(query, call, context.checker)) return;
  context.report(
    query,
    'pg-dynamic-query-text',
    'A runtime value is concatenated into SQL text, which defeats parameter binding and the plan cache and allows injection. Pass data as `$1` placeholders with a values array; pick dynamic identifiers from a fixed allowlist.',
  );
}

export const checks = { CallExpression: [check] };
