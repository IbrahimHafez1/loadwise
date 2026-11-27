import type { Node } from 'typescript';
import type { SecurityRuleContext, Trace } from '../../shared/types.js';
const secondHopReason = 'Reached through two calls; confirm the intermediate functions do not validate the value.';

// Reports a finding that rests on a traced request value; a second hop is contextual, as the design
// requires.
// loadwise-reviewed long-parameter-list -- mirrors the positional shape of context.report (node, ruleId, message, reason) plus the trace; every security rule calls it positionally and the optional reason is the only trailing argument
function reportTraced(
  context: SecurityRuleContext,
  node: Node,
  ruleId: string,
  message: string,
  traced: Trace,
  contextualReason?: string,
) {
  context.report(node, ruleId, message, contextualReason ?? (traced.hops >= 2 ? secondHopReason : undefined), {
    taint: traced,
  });
}

export { reportTraced };
