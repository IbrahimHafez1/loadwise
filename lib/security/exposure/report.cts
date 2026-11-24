import type { Node } from 'typescript';
import type { SecurityRuleContext, Trace } from '../../shared/types.cjs';
const secondHopReason = 'Reached through two calls; confirm the intermediate functions do not validate the value.';

// Reports a finding that rests on a traced request value; a second hop is contextual, as the design
// requires.
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
