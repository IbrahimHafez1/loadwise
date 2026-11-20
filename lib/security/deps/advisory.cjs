'use strict';

// Turns an OSV vulnerability record into the facts a finding needs: a severity level and the lowest fixed version.

const databaseSeverityLevels = { CRITICAL: 'critical', HIGH: 'high', MODERATE: 'medium', MEDIUM: 'medium', LOW: 'low' };
// Severity bands of the CVSS specification: 9.0 critical, 7.0 high, 4.0 medium, anything above 0 low.
const cvssBands = [
  [9, 'critical'],
  [7, 'high'],
  [4, 'medium'],
  [0.1, 'low'],
];
const unknownSeverity = 'medium';

const attackVector = { N: 0.85, A: 0.62, L: 0.55, P: 0.2 };
const attackComplexity = { L: 0.77, H: 0.44 };
const userInteraction = { N: 0.85, R: 0.62 };
const impactMetric = { H: 0.56, L: 0.22, N: 0 };
const privilegesUnchanged = { N: 0.85, L: 0.62, H: 0.27 };
const privilegesChanged = { N: 0.85, L: 0.68, H: 0.5 };

function roundUp(value) {
  const scaled = Math.round(value * 100000);
  return scaled % 10000 === 0 ? scaled / 100000 : (Math.floor(scaled / 10000) + 1) / 10;
}

// CVSS v3.x base score from a vector such as 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H'.
function cvssV3BaseScore(vector) {
  const metrics = Object.fromEntries(
    vector
      .split('/')
      .slice(1)
      .map((part) => part.split(':')),
  );
  const scopeChanged = metrics.S === 'C';
  const privileges = (scopeChanged ? privilegesChanged : privilegesUnchanged)[metrics.PR];
  const parts = [attackVector[metrics.AV], attackComplexity[metrics.AC], privileges, userInteraction[metrics.UI]];
  const impacts = [impactMetric[metrics.C], impactMetric[metrics.I], impactMetric[metrics.A]];
  if ([...parts, ...impacts].some((part) => part === undefined)) return undefined;
  const impactSubScore = 1 - impacts.reduce((product, value) => product * (1 - value), 1);
  const impact = scopeChanged
    ? 7.52 * (impactSubScore - 0.029) - 3.25 * (impactSubScore - 0.02) ** 15
    : 6.42 * impactSubScore;
  if (impact <= 0) return 0;
  const exploitability = 8.22 * parts.reduce((product, value) => product * value, 1);
  return roundUp(Math.min(scopeChanged ? 1.08 * (impact + exploitability) : impact + exploitability, 10));
}

function levelForScore(score) {
  return cvssBands.find(([minimum]) => score >= minimum)?.[1];
}

function severityLevel(vulnerability) {
  const fromDatabase = databaseSeverityLevels[String(vulnerability.databaseSeverity).toUpperCase()];
  if (fromDatabase) return fromDatabase;
  for (const { type, score } of vulnerability.severity) {
    if (!type.startsWith('CVSS_V3')) continue;
    const base = cvssV3BaseScore(String(score));
    if (base !== undefined) return levelForScore(base) ?? 'low';
  }
  return unknownSeverity;
}

const severityRank = { critical: 3, high: 2, medium: 1, low: 0 };

function highestSeverity(levels) {
  return levels.reduce((highest, level) => (severityRank[level] > severityRank[highest] ? level : highest));
}

function parseVersion(version) {
  const [core, prerelease] = version.replace(/^v/, '').split(/-(.*)/s);
  return { numbers: core.split('.').map((part) => Number.parseInt(part, 10) || 0), prerelease };
}

function compareVersions(left, right) {
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

function lowestFixedVersionOf(vulnerability, name, version) {
  const candidates = vulnerability.affected
    .filter((entry) => entry.name === name)
    .flatMap(({ ranges }) => ranges.flatMap(({ events }) => (events ?? []).map(({ fixed }) => fixed)))
    .filter((fixed) => typeof fixed === 'string' && compareVersions(fixed, version) > 0);
  return candidates.reduce(
    (lowest, fixed) => (!lowest || compareVersions(fixed, lowest) < 0 ? fixed : lowest),
    undefined,
  );
}

// The version that clears every advisory: the highest of each advisory's lowest fix. Undefined when any advisory has
// no published fix, since upgrading would then not make the package clean.
function fixedVersion(vulnerabilities, name, version) {
  const fixes = vulnerabilities.map((vulnerability) => lowestFixedVersionOf(vulnerability, name, version));
  if (fixes.some((fix) => fix === undefined)) return undefined;
  return fixes.reduce((highest, fix) => (compareVersions(fix, highest) > 0 ? fix : highest));
}

// When one advisory lists another's id as an alias (a GHSA and its CVE), only one is reported.
function withoutAliasDuplicates(vulnerabilities) {
  const ids = new Set(vulnerabilities.map(({ id }) => id));
  const sorted = [...vulnerabilities].sort(
    (left, right) => Number(right.id.startsWith('GHSA-')) - Number(left.id.startsWith('GHSA-')),
  );
  const kept = [];
  const covered = new Set();
  for (const vulnerability of sorted) {
    if (covered.has(vulnerability.id)) continue;
    kept.push(vulnerability);
    for (const alias of vulnerability.aliases) if (ids.has(alias)) covered.add(alias);
  }
  return kept.sort((left, right) => left.id.localeCompare(right.id));
}

module.exports = {
  severityLevel,
  highestSeverity,
  fixedVersion,
  withoutAliasDuplicates,
  compareVersions,
  cvssV3BaseScore,
};
