// @ts-check
// How much a finding matters, shared by every pillar so one `--min-impact` flag means the same everywhere.
//
// Each pillar keeps its own table in its rule-ids.cjs: `impactByRule`, a plain object from rule id to one of
// `impactLevels`. A new pillar (security, for one) registers its ids by exporting the same shape and calling
// `annotateImpact` on its findings. The finding field is `impactLevel`; `impact` is already the before/after estimate.
import { hotPathOrder } from './hot-path.js';
import type { Finding, ImpactLevel } from './types.js';

const impactLevels: readonly ImpactLevel[] = ['low', 'medium', 'high', 'critical'];

function isImpactLevel(value: unknown): value is ImpactLevel {
  return impactLevels.some((level) => level === value);
}

function impactRank(level: string | undefined): number {
  return impactLevels.findIndex((candidate) => candidate === level);
}

// Returns the validated level, or undefined when the flag was not given.
function parseMinImpact(value: unknown): ImpactLevel | undefined {
  if (value === undefined) return undefined;
  if (!isImpactLevel(value)) throw new Error(`--min-impact must be one of ${impactLevels.join(', ')}.`);
  return value;
}

function annotateImpact(findings: Finding[], impactByRule: Readonly<Record<string, ImpactLevel>>) {
  for (const finding of findings) finding.impactLevel = impactByRule[finding.ruleId];
  return findings;
}

function filterMinImpact(findings: Finding[], minImpact?: string) {
  if (minImpact === undefined) return findings;
  return findings.filter((finding: Finding) => impactRank(finding.impactLevel) >= impactRank(minImpact));
}

// Most severe first within each run of findings from one file, then the hottest code (request
// before job before script before test); equal ranks keep their current order, and the files keep
// theirs.
function sortByImpactWithinFiles(findings: Finding[]) {
  const sorted: Finding[] = [];
  let start = 0;
  while (start < findings.length) {
    let end = start;
    while (end < findings.length && findings[end].file === findings[start].file) end++;
    const run = findings.slice(start, end);
    run.sort(
      (left, right) =>
        impactRank(right.impactLevel) - impactRank(left.impactLevel) || hotPathOrder(left) - hotPathOrder(right),
    );
    sorted.push(...run);
    start = end;
  }
  return sorted;
}

export { impactLevels, impactRank, parseMinImpact, annotateImpact, filterMinImpact, sortByImpactWithinFiles };
