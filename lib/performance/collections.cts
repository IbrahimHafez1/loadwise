import { loadSyntax } from './compiler.cjs';
import { checkFilterExistence } from './filter-existence.cjs';
import { isMethodCall, syncCallback } from './collection-bindings.cjs';
import { checkCollectionAssignment } from './collection-copy.cjs';
import { checkFind, checkMembership, checkRebuiltLookup } from './collection-lookups.cjs';
import { checkReducer } from './collection-reduce.cjs';
import type { CallExpression } from 'typescript';
import type { PerformanceRuleContext } from '../shared/types.cjs';
const ts = loadSyntax();

function checkCollectionCall(call: CallExpression, context: PerformanceRuleContext): void {
  if (!isMethodCall(call) || ts.isOptionalChain(call)) return;
  switch (call.expression.name.text) {
    case 'filter':
      return checkFilterExistence(call, context, syncCallback(call.arguments[0]));
    case 'has':
    case 'get':
      return checkRebuiltLookup(call, context);
    case 'find':
    case 'findIndex':
      return checkFind(call, context);
    case 'includes':
      return checkMembership(call, context);
    case 'reduce':
      return checkReducer(call, context);
  }
}

export { checkCollectionCall, checkCollectionAssignment };
