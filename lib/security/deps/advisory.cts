// Turns an OSV vulnerability record into the facts a finding needs: a severity level and the lowest
// fixed version.
import type { ImpactLevel } from '../../shared/types.cjs';
import type { OsvVulnerability } from '../types/osv-vulnerability.cjs';

/** Scores of one CVSS metric group by metric letter, such as `N` for a network attack vector. */
type MetricWeights = Record<string, number>;

/** A release split into its numeric parts and its pre-release tag. */
interface ParsedVersion {
  numbers: number[];
  prerelease: string | undefined;
}

const databaseSeverityLevels: Record<string, ImpactLevel> = {
  CRITICAL: 'critical',
  HIGH: 'high',
  MODERATE: 'medium',
  MEDIUM: 'medium',
  LOW: 'low',
};
// Severity bands of the CVSS specification: 9.0 critical, 7.0 high, 4.0 medium, anything above 0
// low.
const cvssBands: readonly (readonly [minimum: number, level: ImpactLevel])[] = [
  [9, 'critical'],
  [7, 'high'],
  [4, 'medium'],
  [0.1, 'low'],
];
const unknownSeverity = 'medium';

const attackVector: MetricWeights = { N: 0.85, A: 0.62, L: 0.55, P: 0.2 };
const attackComplexity: MetricWeights = { L: 0.77, H: 0.44 };
const userInteraction: MetricWeights = { N: 0.85, R: 0.62 };
const impactMetric: MetricWeights = { H: 0.56, L: 0.22, N: 0 };
const privilegesUnchanged: MetricWeights = { N: 0.85, L: 0.62, H: 0.27 };
const privilegesChanged: MetricWeights = { N: 0.85, L: 0.68, H: 0.5 };

// The weight of a metric letter, or undefined when the vector lacks the metric or uses an unknown
// letter.
function weightOf(weights: MetricWeights, letter: string | undefined): number | undefined {
  return letter === undefined ? undefined : weights[letter];
}

function isComplete(weights: (number | undefined)[]): weights is number[] {
  return weights.every((weight) => weight !== undefined);
}

function roundUp(value: number) {
  const scaled = Math.round(value * 100000);
  return scaled % 10000 === 0 ? scaled / 100000 : (Math.floor(scaled / 10000) + 1) / 10;
}

// CVSS v3.x base score from a vector such as 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H'.
function cvssV3BaseScore(vector: string): number | undefined {
  const metrics = Object.fromEntries(
    vector
      .split('/')
      .slice(1)
      .map((part): [string, string | undefined] => {
        const [metric, value] = part.split(':');
        return [metric, value];
      }),
  );
  const scopeChanged = metrics.S === 'C';
  const privileges = weightOf(scopeChanged ? privilegesChanged : privilegesUnchanged, metrics.PR);
  const parts = [
    weightOf(attackVector, metrics.AV),
    weightOf(attackComplexity, metrics.AC),
    privileges,
    weightOf(userInteraction, metrics.UI),
  ];
  const impacts = [
    weightOf(impactMetric, metrics.C),
    weightOf(impactMetric, metrics.I),
    weightOf(impactMetric, metrics.A),
  ];
  if (!isComplete(parts) || !isComplete(impacts)) return undefined;
  const impactSubScore = 1 - impacts.reduce((product, value) => product * (1 - value), 1);
  const impact = scopeChanged
    ? 7.52 * (impactSubScore - 0.029) - 3.25 * (impactSubScore - 0.02) ** 15
    : 6.42 * impactSubScore;
  if (impact <= 0) return 0;
  const exploitability = 8.22 * parts.reduce((product, value) => product * value, 1);
  return roundUp(Math.min(scopeChanged ? 1.08 * (impact + exploitability) : impact + exploitability, 10));
}

function levelForScore(score: number): ImpactLevel | undefined {
  return cvssBands.find(([minimum]) => score >= minimum)?.[1];
}

function severityLevel(vulnerability: OsvVulnerability): ImpactLevel {
  const fromDatabase = databaseSeverityLevels[String(vulnerability.databaseSeverity).toUpperCase()];
  if (fromDatabase) return fromDatabase;
  for (const { type, score } of vulnerability.severity) {
    if (!type.startsWith('CVSS_V3')) continue;
    const base = cvssV3BaseScore(String(score));
    if (base !== undefined) return levelForScore(base) ?? 'low';
  }
  return unknownSeverity;
}

const severityRank: Record<ImpactLevel, number> = { critical: 3, high: 2, medium: 1, low: 0 };

function highestSeverity(levels: ImpactLevel[]): ImpactLevel {
  return levels.reduce((highest, level) => (severityRank[level] > severityRank[highest] ? level : highest));
}

function parseVersion(version: string): ParsedVersion {
  const [core, prerelease] = version.replace(/^v/, '').split(/-(.*)/s);
  return { numbers: core.split('.').map((part) => Number.parseInt(part, 10) || 0), prerelease };
}

function compareVersions(left: string, right: string): number {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (let index = 0; index < Math.max(a.numbers.length, b.numbers.length); index++) {
    const difference = (a.numbers[index] ?? 0) - (b.numbers[index] ?? 0);
    if (difference) return Math.sign(difference);
  }
  if (a.prerelease === b.prerelease) return 0;
  if (a.prerelease === undefined) return 1;
  if (b.prerelease === undefined) return -1;
  return a.prerelease < b.prerelease ? -1 : 1;
}

function lowestFixedVersionOf(vulnerability: OsvVulnerability, name: string, version: string): string | undefined {
  const candidates = vulnerability.affected
    .filter((entry) => entry.name === name)
    .flatMap(({ ranges }) => ranges.flatMap(({ events }) => (events ?? []).map(({ fixed }) => fixed)))
    .filter((fixed): fixed is string => typeof fixed === 'string' && compareVersions(fixed, version) > 0);
  return candidates.reduce<string | undefined>(
    (lowest, fixed) => (!lowest || compareVersions(fixed, lowest) < 0 ? fixed : lowest),
    undefined,
  );
}

// The version that clears every advisory: the highest of each advisory's lowest fix. Undefined when
// any advisory has no published fix, since upgrading would then not make the package clean.
function fixedVersion(vulnerabilities: OsvVulnerability[], name: string, version: string): string | undefined {
  const fixes = vulnerabilities.map((vulnerability) => lowestFixedVersionOf(vulnerability, name, version));
  const known = fixes.filter((fix): fix is string => fix !== undefined);
  if (known.length < fixes.length) return undefined;
  return known.reduce((highest, fix) => (compareVersions(fix, highest) > 0 ? fix : highest));
}

// When one advisory lists another's id as an alias (a GHSA and its CVE), only one is reported.
function withoutAliasDuplicates(vulnerabilities: OsvVulnerability[]): OsvVulnerability[] {
  const ids = new Set(vulnerabilities.map(({ id }) => id));
  const sorted = [...vulnerabilities].sort(
    (left, right) => Number(right.id.startsWith('GHSA-')) - Number(left.id.startsWith('GHSA-')),
  );
  const kept: OsvVulnerability[] = [];
  const covered = new Set<string>();
  for (const vulnerability of sorted) {
    if (covered.has(vulnerability.id)) continue;
    kept.push(vulnerability);
    for (const alias of vulnerability.aliases) if (ids.has(alias)) covered.add(alias);
  }
  return kept.sort((left, right) => left.id.localeCompare(right.id));
}

export { severityLevel, highestSeverity, fixedVersion, withoutAliasDuplicates, compareVersions, cvssV3BaseScore };
