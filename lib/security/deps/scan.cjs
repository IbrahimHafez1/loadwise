'use strict';

// Scans a project's lockfile for packages with known vulnerabilities and reports one finding per package@version.
const { findLockfile, readLockfilePackages, manifestLocation } = require('./lockfiles.cjs');
const { findVulnerabilities } = require('./osv.cjs');
const { severityLevel, highestSeverity, fixedVersion, withoutAliasDuplicates } = require('./advisory.cjs');

const ruleId = 'dependency-known-vulnerability';
const devOnlyReason = 'development-only dependency';
const advisoryUrl = 'https://osv.dev/vulnerability/';

const installCommands = { npm: 'npm install', pnpm: 'pnpm add', yarn: 'yarn add' };
const overrideHints = {
  npm: (name, fixed) => `add "overrides": { "${name}": "${fixed}" } to package.json, then run npm install`,
  pnpm: (name, fixed) =>
    `add "pnpm": { "overrides": { "${name}": "${fixed}" } } to package.json, then run pnpm install`,
  yarn: (name, fixed) => `add "resolutions": { "${name}": "${fixed}" } to package.json, then run yarn install`,
};

function fixAdvice({ name, direct }, fixed, manager) {
  if (!fixed) return 'No fixed version is published yet; review the advisories, or replace or remove the package.';
  return direct
    ? `Fix: ${installCommands[manager]} ${name}@${fixed}`
    : `Fix: transitive dependency; ${overrideHints[manager](name, fixed)}`;
}

function buildFinding(entry, vulnerabilities, lockfile) {
  const advisories = withoutAliasDuplicates(vulnerabilities);
  const severity = highestSeverity(advisories.map(severityLevel));
  const fixed = fixedVersion(advisories, entry.name, entry.version);
  const location = (entry.direct && manifestLocation(entry.manifestDirectories, entry.name)) || {
    file: lockfile.filename,
    line: entry.line,
  };
  const ids = advisories.map(({ id }) => id).join(', ');
  const finding = {
    file: location.file,
    line: location.line,
    column: 1,
    ruleId,
    message:
      `${entry.name}@${entry.version} has ${advisories.length} known ${advisories.length === 1 ? 'vulnerability' : 'vulnerabilities'} ` +
      `(${ids}), highest severity ${severity}. ${fixAdvice(entry, fixed, lockfile.manager)}`,
    severity,
    impactLevel: severity,
    package: { name: entry.name, version: entry.version, direct: entry.direct, dev: entry.dev },
    fixedVersion: fixed,
    advisories: advisories.map((advisory) => ({
      id: advisory.id,
      severity: severityLevel(advisory),
      summary: advisory.summary,
      url: advisoryUrl + advisory.id,
    })),
  };
  if (entry.dev) finding.contextualReason = devOnlyReason;
  return finding;
}

// `options` carries the injected fetch, cache directory and clock for tests; see osv.cjs.
async function scanDependencies(directory, options) {
  const lockfile = findLockfile(directory);
  if (!lockfile)
    throw new Error(`No package-lock.json, pnpm-lock.yaml or yarn.lock found in ${directory} or above it.`);
  const packages = readLockfilePackages(lockfile);
  const vulnerable = await findVulnerabilities(packages, options);
  const findings = packages
    .filter((entry) => vulnerable.has(`${entry.name}@${entry.version}`))
    .map((entry) => buildFinding(entry, vulnerable.get(`${entry.name}@${entry.version}`), lockfile))
    .sort((left, right) => left.file.localeCompare(right.file) || left.line - right.line);
  return { scannedFiles: 1, scannedPackages: packages.length, findings };
}

module.exports = { scanDependencies, ruleId, hasLockfile: (directory) => Boolean(findLockfile(directory)) };
