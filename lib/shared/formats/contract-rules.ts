// Rules that default to an error under --fail-on contract.
import type { FormatPillar } from '../types/report-formats.js';
import { rulesByPillar } from '../rule-registry.js';

const contractRules: Record<FormatPillar, ReadonlySet<string>> = {
  performance: rulesByPillar.performance.contractRules,
  reliability: rulesByPillar.reliability.contractRules,
  maintainability: rulesByPillar.maintainability.contractRules,
  security: rulesByPillar.security.contractRules,
  accessibility: rulesByPillar.accessibility.contractRules,
};

export { contractRules };
