import { ts } from './compiler.js';
import { checkFilterExistence } from './filter-existence.js';
import { isMethodCall, syncCallback } from './collection-bindings.js';
import { checkCollectionAssignment } from './collection-copy.js';
import { checkFind, checkMembership, checkRebuiltLookup } from './collection-lookups.js';
import { checkReducer } from './collection-reduce.js';
import type { CallExpression } from 'typescript';
import type { PerformanceRuleContext } from '../shared/types.js';

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
