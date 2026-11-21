'use strict';

const secondHopReason = 'Reached through two calls; confirm the intermediate functions do not validate the value.';

// Reports a finding that rests on a traced request value; a second hop is contextual, as the design requires.
function reportTraced(context, node, ruleId, message, traced, contextualReason) {
  context.report(node, ruleId, message, contextualReason ?? (traced.hops >= 2 ? secondHopReason : undefined), {
    taint: traced,
  });
}

module.exports = { reportTraced };
