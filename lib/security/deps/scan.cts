// Scans a project's lockfile for packages with known vulnerabilities and reports one finding per
// package@version.
import { findLockfile, readLockfilePackages, manifestLocation } from './lockfiles.cjs';
import { findVulnerabilities } from './osv.cjs';
import { severityLevel, highestSeverity, fixedVersion, withoutAliasDuplicates } from './advisory.cjs';
import type { Finding } from '../../shared/types.cjs';
import type { Lockfile, LockfilePackage } from '../types/lockfile.cjs';
import type { OsvVulnerability, VulnerabilityLookupOptions } from '../types/osv-vulnerability.cjs';

const ruleId = 'dependency-known-vulnerability';
const devOnlyReason = 'development-only dependency';
const advisoryUrl = 'https://osv.dev/vulnerability/';

const installCommands: Record<string, string> = { npm: 'npm install', pnpm: 'pnpm add', yarn: 'yarn add' };
const overrideHints: Record<string, (name: string, fixed: string) => string> = {
  npm: (name, fixed) => `add "overrides": { "${name}": "${fixed}" } to package.json, then run npm install`,
  pnpm: (name, fixed) =>
    `add "pnpm": { "overrides": { "${name}": "${fixed}" } } to package.json, then run pnpm install`,
  yarn: (name, fixed) => `add "resolutions": { "${name}": "${fixed}" } to package.json, then run yarn install`,
};

function fixAdvice({ name, direct }: LockfilePackage, fixed: string | undefined, manager: string) {
  if (!fixed) return 'No fixed version is published yet; review the advisories, or replace or remove the package.';
  return direct
    ? `Fix: ${installCommands[manager]} ${name}@${fixed}`
    : `Fix: transitive dependency; ${overrideHints[manager](name, fixed)}`;
}

// A finding of the dependency scan: positioned in the lockfile or the manifest that declares the
// package.
interface DependencyFinding extends Finding {
  file: string;
  line: number;
}

function buildFinding(
  entry: LockfilePackage,
  vulnerabilities: OsvVulnerability[],
  lockfile: Lockfile,
): DependencyFinding {
  const advisories = withoutAliasDuplicates(vulnerabilities);
  const severity = highestSeverity(advisories.map(severityLevel));
  const fixed = fixedVersion(advisories, entry.name, entry.version);
  const location = (entry.direct && manifestLocation(entry.manifestDirectories, entry.name)) || {
    file: lockfile.filename,
    line: entry.line,
  };
  const ids = advisories.map(({ id }) => id).join(', ');
  const finding: DependencyFinding = {
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
async function scanDependencies(directory: string, options?: VulnerabilityLookupOptions) {
  const lockfile = findLockfile(directory);
  if (!lockfile)
    throw new Error(`No package-lock.json, pnpm-lock.yaml or yarn.lock found in ${directory} or above it.`);
  const packages: LockfilePackage[] = readLockfilePackages(lockfile);
  const vulnerable = await findVulnerabilities(packages, options);
  const findings = packages
    .flatMap((entry) => {
      const vulnerabilities = vulnerable.get(`${entry.name}@${entry.version}`);
      return vulnerabilities ? [buildFinding(entry, vulnerabilities, lockfile)] : [];
    })
    .sort((left, right) => left.file.localeCompare(right.file) || left.line - right.line);
  return { scannedFiles: 1, scannedPackages: packages.length, findings };
}

export const hasLockfile = (directory: string) => Boolean(findLockfile(directory));
export { scanDependencies, ruleId };
