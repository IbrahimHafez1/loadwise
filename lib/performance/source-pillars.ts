// The checkers that report from the shared TypeScript pass, and how one pass's findings split into their reports.
import { pillarOfRule } from '../shared/rule-registry.js';
import type { Finding } from '../shared/types.js';
import type { PillarName } from '../shared/types/pillar-name.js';
import type { SourceCommand } from './types/source-command.js';

/** A checker the perf engine prints itself: `loadwise perf`, `loadwise rel` or `loadwise a11y`. */
interface EngineCommand {
  command: 'perf' | 'rel' | 'a11y';
  jsonKey: 'performance' | 'reliability' | 'accessibility';
}

const performanceCommand: EngineCommand = { command: 'perf', jsonKey: 'performance' };
const reliabilityCommand: EngineCommand = { command: 'rel', jsonKey: 'reliability' };
const accessibilityCommand: EngineCommand = { command: 'a11y', jsonKey: 'accessibility' };

const jsonKeyByCommand: Readonly<Record<SourceCommand, PillarName>> = {
  perf: 'performance',
  rel: 'reliability',
  sec: 'security',
  a11y: 'accessibility',
};

// Findings added after the pass, such as schema and file findings, carry no stamp; their rule decides.
function pillarOfFinding(finding: Finding): PillarName {
  return finding.pillar ?? pillarOfRule(finding.ruleId) ?? 'performance';
}

/** The findings of one pillar, without the stamp that only served the split. */
function takePillar(findings: readonly Finding[], pillar: PillarName): Finding[] {
  const taken = findings.filter((finding) => pillarOfFinding(finding) === pillar);
  for (const finding of taken) delete finding.pillar;
  return taken;
}

export { performanceCommand, reliabilityCommand, accessibilityCommand, jsonKeyByCommand, pillarOfFinding, takePillar };
export type { EngineCommand };
