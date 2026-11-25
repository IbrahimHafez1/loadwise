import { knownRules as performanceRules } from '../performance/rule-ids.js';
import { knownRules as maintainabilityRules } from '../maintainability/rule-ids.js';
import { securityRules } from '../security/rule-ids.js';

const pillarNames: readonly string[] = ['perf', 'maint', 'sec'];

function registeredRuleIds(): Set<string> {
  return new Set([...performanceRules, ...maintainabilityRules, ...securityRules]);
}

export { pillarNames, registeredRuleIds };
