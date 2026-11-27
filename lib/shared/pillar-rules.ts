import { pillarOrder, rulesByPillar } from './rule-registry.js';

const pillarNames: readonly string[] = ['perf', 'rel', 'maint', 'sec', 'a11y'];

function registeredRuleIds(): Set<string> {
  return new Set(pillarOrder.flatMap((pillar) => [...rulesByPillar[pillar].knownRules]));
}

export { pillarNames, registeredRuleIds };
