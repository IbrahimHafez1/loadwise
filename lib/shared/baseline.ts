// Baselines let a team adopt loadwise on existing code: --write-baseline records today's findings, --baseline hides
// them so only new ones are reported. One file holds a section per pillar, so `loadwise check` and the single-pillar
// commands share it. (The migrations baseline is a different, per-file hash format and stays in perf/migrations.)
import fs from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from './atomic-write.js';
import { impactRank } from './impact-levels.js';
import { errorCode } from './error-code.js';
import type { Finding } from './types.js';
import type {
  BaselineCount,
  BaselineDocument,
  BaselineEntry,
  BaselineFiltered,
  BaselineFlagOptions,
  BaselineOption,
  BaselineRunOptions,
  BaselineScope,
  BaselineWritten,
  FindingKey,
} from './types/baseline.js';
import type { PillarName } from './types/pillar-name.js';
import { impactByRule as impactByRuleRuleIds } from '../performance/rule-ids.js';
import { impactByRule as impactByRuleRuleIds2 } from '../maintainability/rule-ids.js';
import { impactByRule as impactByRuleRuleIds22 } from '../security/rule-ids.js';
import { extractBaselineFlags } from './baseline-flags.js';
import { assignFindingIds } from '../performance/finding-ids.js';
import { discoverWorkspaces, selectWorkspaces } from './workspaces.js';

type FindingKeys = (findings: Finding[]) => FindingKey[];
type OutsideScan = (entry: { ruleId: string; file: string }) => boolean;

interface ApplyBaselineInput {
  options: BaselineRunOptions;
  pillar: PillarName;
  findings: Finding[];
  projectRoot: string;
  absoluteFileOf: (finding: Finding) => string;
  /** The folder the finding ids were computed against. */
  idRoot?: string;
}

/** The command-line values that decide whether a scan is partial. */
interface BaselineScanValues {
  staged?: boolean;
  'changed-since'?: string;
  workspace?: readonly string[];
  ignore?: readonly string[];
  'min-impact'?: string;
  graph?: unknown;
}

const DEFAULT_BASELINE_NAME = 'loadwise-baseline.json';
const BASELINE_VERSION = 1;
const BOM_PATTERN = new RegExp('^' + String.fromCharCode(0xfeff));
const impactTableByPillar: Record<PillarName, () => Readonly<Record<string, string>>> = {
  performance: () => impactByRuleRuleIds,
  maintainability: () => impactByRuleRuleIds2,
  security: () => impactByRuleRuleIds22,
};

// An explicit file is relative to the working directory; the default sits in the project root.
function resolveBaselineFile(option: BaselineOption, projectRoot: string): string {
  return option.file === undefined
    ? path.join(path.resolve(projectRoot), DEFAULT_BASELINE_NAME)
    : path.resolve(option.file);
}

function isBaselineDocument(value: unknown): value is BaselineDocument {
  return (
    typeof value === 'object' &&
    value !== null &&
    'version' in value &&
    value.version === BASELINE_VERSION &&
    'pillars' in value &&
    typeof value.pillars === 'object' &&
    value.pillars !== null
  );
}

function readDocument(baselineFile: string): BaselineDocument | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(baselineFile, 'utf8').replace(BOM_PATTERN, '');
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return undefined;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('Baseline file contains invalid JSON: ' + baselineFile);
  }
  if (!isBaselineDocument(parsed)) {
    throw new Error(`Baseline must be { "version": ${BASELINE_VERSION}, "pillars": { ... } }: ${baselineFile}`);
  }
  return parsed;
}

const withoutSuffix = (id: string | undefined): string => (id ?? '').replace(/-\d+$/, '');

// The fingerprint is the finding id without its collision suffix: the id hashes rule, file and
// flagged text, never the line number. Ids hash the file relative to the folder they were computed
// against (idRoot); when that is not the baseline's folder the fingerprint is recomputed against
// the baseline's folder, so a baseline matches whichever folder is scanned. `legacyKey` is the key
// older versions wrote, when it differs. Counts per key make N existing copies allow N findings.
function createFindingKeys(
  baselineFile: string,
  absoluteFileOf: (finding: Finding) => string,
  idRoot: string | undefined,
): FindingKeys {
  const baseDirectory = path.dirname(baselineFile);
  const rehash = idRoot !== undefined && path.resolve(idRoot) !== baseDirectory;
  const fingerprintsOf = (findings: Finding[]): string[] => {
    if (!rehash) return findings.map(({ id }) => withoutSuffix(id));
    const located = findings.map((finding: Finding) => ({
      ...finding,
      file: typeof finding.file === 'string' ? absoluteFileOf(finding) : finding.file,
    }));
    return assignFindingIds(located, baseDirectory).map(({ id }) => withoutSuffix(id));
  };
  return (findings: Finding[]) => {
    const fingerprints = fingerprintsOf(findings);
    return findings.map((finding: Finding, index: number) => {
      const key = {
        ruleId: finding.ruleId,
        file: path.relative(baseDirectory, absoluteFileOf(finding)).split(path.sep).join('/'),
        fingerprint: fingerprints[index],
      };
      const legacyFingerprint = withoutSuffix(finding.id);
      const legacyKey = legacyFingerprint === key.fingerprint ? undefined : { ...key, fingerprint: legacyFingerprint };
      return { key, legacyKey };
    });
  };
}

const keyText = ({ ruleId, file, fingerprint }: BaselineEntry): string => [ruleId, file, fingerprint].join('\0');

function compareEntries(left: BaselineEntry, right: BaselineEntry): number {
  return (
    left.ruleId.localeCompare(right.ruleId) ||
    left.file.localeCompare(right.file) ||
    left.fingerprint.localeCompare(right.fingerprint)
  );
}

// Folders of the --workspace packages, or undefined when the scan was not limited to some of them.
function selectedWorkspaceDirectories(
  projectRoot: string,
  selectors: readonly string[] | undefined,
): string[] | undefined {
  if (!selectors?.length) return undefined;
  const { packages, withoutConfig } = discoverWorkspaces(projectRoot);
  return selectWorkspaces([...packages, ...withoutConfig], projectRoot, selectors).map(({ directory }) => directory);
}

function isWithin(directory: string, target: string): boolean {
  const relative = path.relative(directory, target);
  return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

// Scanned files or folders limit the scan only when none of them holds the baseline's folder.
function limitedToPaths(baselineFile: string, scope: BaselineScope | undefined): boolean {
  const paths = scope?.paths ?? [];
  return paths.length > 0 && !paths.some((scanned: string) => isWithin(scanned, path.dirname(baselineFile)));
}

// Whether a recorded entry lies outside what this scan could report: a workspace it skipped, files
// or folders it was not given, a rule its --ignore dropped, or a rule below its --min-impact. Such
// entries survive --write-baseline.
function createOutsideScan(
  baselineFile: string,
  pillar: PillarName,
  scope: BaselineScope | undefined,
  projectRoot: string,
): OutsideScan {
  if (!scope) return () => false;
  const workspaces = selectedWorkspaceDirectories(projectRoot, scope.workspaces);
  const scannedPaths = limitedToPaths(baselineFile, scope) ? scope.paths : undefined;
  const ignored = new Set(scope.ignoredRules);
  const impactByRule = scope.minImpact === undefined ? undefined : impactTableByPillar[pillar]();
  const baseDirectory = path.dirname(baselineFile);
  const inAny = (directories: readonly string[], file: string): boolean =>
    directories.some((directory: string) => isWithin(directory, path.resolve(baseDirectory, file)));
  return ({ ruleId, file }) =>
    ignored.has(ruleId) ||
    (impactByRule !== undefined && impactRank(impactByRule[ruleId]) < impactRank(scope.minImpact)) ||
    (workspaces !== undefined && !inAny(workspaces, file)) ||
    (scannedPaths !== undefined && !inAny(scannedPaths, file));
}

// Replaces one pillar's section and keeps the others, so pillars can be baselined one at a time.
// Entries outside a partial scan's scope are kept, so baselining one workspace or rule set leaves
// the rest recorded.
function writePillarBaseline(
  baselineFile: string,
  pillar: PillarName,
  findings: Finding[],
  findingKeys: FindingKeys,
  isOutsideScan: OutsideScan,
): number {
  const counts = new Map<string, BaselineCount>();
  for (const { key } of findingKeys(findings)) {
    const entry = counts.get(keyText(key)) ?? { ...key, count: 0 };
    entry.count++;
    counts.set(keyText(key), entry);
  }
  const document = readDocument(baselineFile);
  for (const entry of document?.pillars[pillar]?.findings ?? []) {
    if (isOutsideScan(entry) && !counts.has(keyText(entry))) counts.set(keyText(entry), entry);
  }
  const entries = [...counts.values()].sort(compareEntries);
  const pillars = { ...document?.pillars, [pillar]: { findings: entries } };
  const sorted = Object.fromEntries(Object.entries(pillars).sort(([left], [right]) => left.localeCompare(right)));
  writeFileAtomic(baselineFile, JSON.stringify({ version: BASELINE_VERSION, pillars: sorted }, null, 2) + '\n');
  return findings.length;
}

// Removes findings the baseline accounts for. `stale` counts recorded findings that no longer
// occur; they leave the file only on the next --write-baseline.
function filterPillarBaseline(
  baselineFile: string,
  pillar: PillarName,
  findings: Finding[],
  findingKeys: FindingKeys,
  partialScan: boolean,
): BaselineFiltered {
  const document = readDocument(baselineFile);
  if (!document) throw new Error(`Baseline not found: ${baselineFile}. Create it with --write-baseline.`);
  const remaining = new Map<string, number>();
  for (const entry of document.pillars[pillar]?.findings ?? []) {
    const key = keyText(entry);
    remaining.set(key, (remaining.get(key) ?? 0) + entry.count);
  }
  const fresh: Finding[] = [];
  const keys = findingKeys(findings);
  findings.forEach((finding: Finding, index: number) => {
    const { key, legacyKey } = keys[index];
    const matched = [key, legacyKey]
      .flatMap((entry) => (entry ? [keyText(entry)] : []))
      .find((text) => (remaining.get(text) ?? 0) > 0);
    if (matched) remaining.set(matched, (remaining.get(matched) ?? 0) - 1);
    else fresh.push(finding);
  });
  const stale = partialScan ? null : [...remaining.values()].reduce((total, count) => total + count, 0);
  return { findings: fresh, hidden: findings.length - fresh.length, stale };
}

// Returns undefined without baseline flags, { written, file } after --write-baseline, or the
// filtered result.
// `idRoot` is the folder the finding ids were computed against.
function applyBaselineOptions({
  options,
  pillar,
  findings,
  projectRoot,
  absoluteFileOf,
  idRoot,
}: ApplyBaselineInput): BaselineWritten | BaselineFiltered | undefined {
  if (options.baseline && options.writeBaseline) throw new Error('Choose either --baseline or --write-baseline.');
  const option = options.writeBaseline ?? options.baseline;
  if (!option) return undefined;
  const file = resolveBaselineFile(option, projectRoot);
  const findingKeys = createFindingKeys(file, absoluteFileOf, idRoot);
  if (options.writeBaseline) {
    const isOutsideScan = createOutsideScan(file, pillar, options.scope, projectRoot);
    return { written: writePillarBaseline(file, pillar, findings, findingKeys, isOutsideScan), file };
  }
  const partialScan = options.partialScan || limitedToPaths(file, options.scope);
  return filterPillarBaseline(file, pillar, findings, findingKeys, partialScan);
}

// `scannedPaths` are the absolute files or folders the scan was limited to, if any.
function baselineForScan(
  options: BaselineFlagOptions,
  values: BaselineScanValues,
  scannedPaths: readonly string[] = [],
): BaselineRunOptions {
  const partialScan = Boolean(
    values.staged ||
    values['changed-since'] !== undefined ||
    values.workspace?.length ||
    values.ignore?.length ||
    values['min-impact'] ||
    values.graph,
  );
  // A maint --graph scan reads an import graph whose scope is not a set of paths; a baseline
  // written from it still replaces the whole section.
  const scope = {
    paths: scannedPaths,
    workspaces: values.workspace ?? [],
    ignoredRules: values.ignore ?? [],
    minImpact: values['min-impact'],
  };
  return { ...options, partialScan, scope };
}

function baselineNoteLines({ hidden, stale }: { hidden: number; stale: number | null }): string[] {
  const lines = [`${hidden} baseline findings hidden.`];
  if (stale === null)
    lines.push('Checking for stale baseline entries requires a full scan with the original settings.');
  else if (stale)
    lines.push(
      `${stale} stale baseline entries were absent from this scan. Check the original scan settings before refreshing the baseline.`,
    );
  return lines;
}

export {
  DEFAULT_BASELINE_NAME,
  applyBaselineOptions,
  baselineForScan,
  baselineNoteLines,
  extractBaselineFlags,
  resolveBaselineFile,
};
