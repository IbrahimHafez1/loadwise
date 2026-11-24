// Rules that default to an error under --fail-on contract.
import type { FormatPillar } from '../types/report-formats.cjs';
import { contractRules as contractRulesRuleIds } from '../../security/rule-ids.cjs';

const contractRules: Record<FormatPillar, ReadonlySet<string>> = {
  performance: new Set(['pg-transaction-on-pool']),
  maintainability: new Set(['file-placement', 'folder-boundary', 'data-access-boundary', 'query-mutates-state']),
  security: contractRulesRuleIds,
};

export { contractRules };
