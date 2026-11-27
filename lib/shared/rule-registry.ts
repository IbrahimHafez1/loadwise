// Every pillar's rule tables in one place, keyed by the report name. Baselines, report formats, explain and fix
// presentation read rule impacts and descriptions from here, so a new pillar registers its tables once.
import * as performance from '../performance/rule-ids.js';
import * as reliability from '../reliability/rule-ids.js';
import * as maintainability from '../maintainability/rule-ids.js';
import * as security from '../security/rule-ids.js';
import * as accessibility from '../accessibility/rule-ids.js';
import { descriptionByRule as securityDescriptions } from '../security/rule-descriptions.js';
import type { ImpactLevel } from './types.js';
import type { PillarName } from './types/pillar-name.js';

interface PillarRules {
  /** The ids the config file and --ignore may name. */
  knownRules: ReadonlySet<string>;
  /** Every id a finding of the pillar can carry, including standalone subcommand and polyglot rules. */
  impactByRule: Readonly<Record<string, ImpactLevel>>;
  descriptionByRule: Readonly<Record<string, string>>;
  /** Rules that default to an error under --fail-on contract. */
  contractRules: ReadonlySet<string>;
}

const rulesByPillar: Readonly<Record<PillarName, PillarRules>> = {
  performance: {
    knownRules: performance.knownRules,
    impactByRule: performance.impactByRule,
    descriptionByRule: performance.descriptionByRule,
    contractRules: new Set<string>(),
  },
  reliability: {
    knownRules: reliability.knownRules,
    impactByRule: reliability.impactByRule,
    descriptionByRule: reliability.descriptionByRule,
    contractRules: new Set(['pg-transaction-on-pool']),
  },
  maintainability: {
    knownRules: maintainability.knownRules,
    impactByRule: maintainability.impactByRule,
    descriptionByRule: maintainability.descriptionByRule,
    contractRules: new Set(['file-placement', 'folder-boundary', 'data-access-boundary', 'query-mutates-state']),
  },
  security: {
    knownRules: new Set(security.securityRules),
    impactByRule: security.impactByRule,
    descriptionByRule: securityDescriptions,
    contractRules: security.contractRules,
  },
  accessibility: {
    knownRules: accessibility.knownRules,
    impactByRule: accessibility.impactByRule,
    descriptionByRule: accessibility.descriptionByRule,
    contractRules: new Set<string>(),
  },
};

const pillarOrder: readonly PillarName[] = [
  'performance',
  'reliability',
  'maintainability',
  'security',
  'accessibility',
];

/** The pillar whose tables list `ruleId`, or undefined for an id no pillar registers. */
function pillarOfRule(ruleId: string): PillarName | undefined {
  return pillarOrder.find((pillar) => Object.hasOwn(rulesByPillar[pillar].impactByRule, ruleId));
}

// The pillar a finding of the shared source pass belongs to: its analyzer's, except that reliability rules still found
// by the performance analyzer belong to reliability.
function sourcePillarOf(ruleId: string, analyzerPillar: PillarName): PillarName {
  return pillarOfRule(ruleId) === 'reliability' ? 'reliability' : analyzerPillar;
}

export { rulesByPillar, pillarOrder, pillarOfRule, sourcePillarOf };
