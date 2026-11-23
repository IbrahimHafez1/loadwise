'use strict';

// Baselines let a team adopt loadwise on existing code: --write-baseline records today's findings, --baseline hides
// them so only new ones are reported. One file holds a section per pillar, so `loadwise check` and the single-pillar
// commands share it. (The migrations baseline is a different, per-file hash format and stays in perf/migrations.)
const fs = require('node:fs');
const path = require('node:path');
const { writeFileAtomic } = require('./atomic-write.cjs');
const { impactRank } = require('./impact-levels.cjs');

const DEFAULT_BASELINE_NAME = 'loadwise-baseline.json';
const BASELINE_VERSION = 1;
const baselineFlags = ['--baseline', '--write-baseline'];
const BOM_PATTERN = new RegExp('^' + String.fromCharCode(0xfeff));
const impactTableByPillar = {
  performance: '../performance/rule-ids.cjs',
  maintainability: '../maintainability/rule-ids.cjs',
  security: '../security/rule-ids.cjs',
};

// Both flags take an optional file. A following argument counts as that file only when it names a .json file, so
// `loadwise maint --baseline src` still reads `src` as the directory.
function extractBaselineFlags(args) {
  const rest = [];
  const options = {};
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    const flag = baselineFlags.find((name) => argument === name || argument.startsWith(name + '='));
    const afterTerminator = args.includes('--') && args.indexOf('--') < index;
    if (!flag || afterTerminator) {
      rest.push(argument);
      continue;
    }
    const key = flag === '--baseline' ? 'baseline' : 'writeBaseline';
    const next = args[index + 1];
    if (argument.startsWith(flag + '=')) {
      const file = argument.slice(flag.length + 1);
      if (!file) throw new Error(`${flag} requires a file path.`);
      options[key] = { file };
    }
    else if (next !== undefined && /\.json$/i.test(next) && !next.startsWith('-')) {
      options[key] = { file: next };
      index++;
    } else options[key] = {};
  }
  return { args: rest, ...options };
}

// An explicit file is relative to the working directory; the default sits in the project root.
function resolveBaselineFile(option, projectRoot) {
  return option.file === undefined
    ? path.join(path.resolve(projectRoot), DEFAULT_BASELINE_NAME)
    : path.resolve(option.file);
}

function readDocument(baselineFile) {
  let raw;
  try {
    raw = fs.readFileSync(baselineFile, 'utf8').replace(BOM_PATTERN, '');
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('Baseline file contains invalid JSON: ' + baselineFile);
  }
  if (parsed?.version !== BASELINE_VERSION || typeof parsed.pillars !== 'object' || parsed.pillars === null) {
    throw new Error(`Baseline must be { "version": ${BASELINE_VERSION}, "pillars": { ... } }: ${baselineFile}`);
  }
  return parsed;
}

const withoutSuffix = (id) => id.replace(/-\d+$/, '');

// The fingerprint is the finding id without its collision suffix: the id hashes rule, file and flagged text, never the
// line number. Ids hash the file relative to the folder they were computed against (idRoot); when that is not the
// baseline's folder the fingerprint is recomputed against the baseline's folder, so a baseline matches whichever folder
// is scanned. `legacyKey` is the key older versions wrote, when it differs. Counts per key make N existing copies allow
// N findings.
function createFindingKeys(baselineFile, absoluteFileOf, idRoot) {
  const baseDirectory = path.dirname(baselineFile);
  const rehash = idRoot !== undefined && path.resolve(idRoot) !== baseDirectory;
  const fingerprintsOf = (findings) => {
    if (!rehash) return findings.map(({ id }) => withoutSuffix(id));
    const located = findings.map((finding) => ({
      ...finding,
      file: typeof finding.file === 'string' ? absoluteFileOf(finding) : finding.file,
    }));
    const { assignFindingIds } = require('../performance/finding-ids.cjs');
    return assignFindingIds(located, baseDirectory).map(({ id }) => withoutSuffix(id));
  };
  return (findings) => {
    const fingerprints = fingerprintsOf(findings);
    return findings.map((finding, index) => {
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

const keyText = ({ ruleId, file, fingerprint }) => [ruleId, file, fingerprint].join('\0');

function compareEntries(left, right) {
  return (
    left.ruleId.localeCompare(right.ruleId) ||
    left.file.localeCompare(right.file) ||
    left.fingerprint.localeCompare(right.fingerprint)
  );
}

// Folders of the --workspace packages, or undefined when the scan was not limited to some of them.
function selectedWorkspaceDirectories(projectRoot, selectors) {
  if (!selectors?.length) return undefined;
  const { discoverWorkspaces, selectWorkspaces } = require('./workspaces.cjs');
  const { packages, withoutConfig } = discoverWorkspaces(projectRoot);
  return selectWorkspaces([...packages, ...withoutConfig], projectRoot, selectors).map(({ directory }) => directory);
}

function isWithin(directory, target) {
  const relative = path.relative(directory, target);
  return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

// Scanned files or folders limit the scan only when none of them holds the baseline's folder.
function limitedToPaths(baselineFile, scope) {
  const paths = scope?.paths ?? [];
  return paths.length > 0 && !paths.some((scanned) => isWithin(scanned, path.dirname(baselineFile)));
}

// Whether a recorded entry lies outside what this scan could report: a workspace it skipped, files or folders it was
// not given, a rule its --ignore dropped, or a rule below its --min-impact. Such entries survive --write-baseline.
function createOutsideScan(baselineFile, pillar, scope, projectRoot) {
  if (!scope) return () => false;
  const workspaces = selectedWorkspaceDirectories(projectRoot, scope.workspaces);
  const scannedPaths = limitedToPaths(baselineFile, scope) ? scope.paths : undefined;
  const ignored = new Set(scope.ignoredRules);
  const impactByRule = scope.minImpact === undefined ? undefined : require(impactTableByPillar[pillar]).impactByRule;
  const baseDirectory = path.dirname(baselineFile);
  const inAny = (directories, file) =>
    directories.some((directory) => isWithin(directory, path.resolve(baseDirectory, file)));
  return ({ ruleId, file }) =>
    ignored.has(ruleId) ||
    (impactByRule !== undefined && impactRank(impactByRule[ruleId]) < impactRank(scope.minImpact)) ||
    (workspaces !== undefined && !inAny(workspaces, file)) ||
    (scannedPaths !== undefined && !inAny(scannedPaths, file));
}

// Replaces one pillar's section and keeps the others, so pillars can be baselined one at a time. Entries outside a
// partial scan's scope are kept, so baselining one workspace or rule set leaves the rest recorded.
function writePillarBaseline(baselineFile, pillar, findings, findingKeys, isOutsideScan) {
  const counts = new Map();
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

// Removes findings the baseline accounts for. `stale` counts recorded findings that no longer occur; they leave the
// file only on the next --write-baseline.
function filterPillarBaseline(baselineFile, pillar, findings, findingKeys, partialScan) {
  const document = readDocument(baselineFile);
  if (!document) throw new Error(`Baseline not found: ${baselineFile}. Create it with --write-baseline.`);
  const remaining = new Map();
  for (const entry of document.pillars[pillar]?.findings ?? []) {
    const key = keyText(entry);
    remaining.set(key, (remaining.get(key) ?? 0) + entry.count);
  }
  const fresh = [];
  const keys = findingKeys(findings);
  findings.forEach((finding, index) => {
    const { key, legacyKey } = keys[index];
    const matched = [key, legacyKey]
      .filter(Boolean)
      .map(keyText)
      .find((text) => remaining.get(text) > 0);
    if (matched) remaining.set(matched, remaining.get(matched) - 1);
    else fresh.push(finding);
  });
  const stale = partialScan ? null : [...remaining.values()].reduce((total, count) => total + count, 0);
  return { findings: fresh, hidden: findings.length - fresh.length, stale };
}

// Returns undefined without baseline flags, { written, file } after --write-baseline, or the filtered result.
// `idRoot` is the folder the finding ids were computed against.
function applyBaselineOptions({ options, pillar, findings, projectRoot, absoluteFileOf, idRoot }) {
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
function baselineForScan(options, values, scannedPaths = []) {
  const partialScan = Boolean(
    values.staged ||
    values['changed-since'] !== undefined ||
    values.workspace?.length ||
    values.ignore?.length ||
    values['min-impact'] ||
    values.graph,
  );
  // A maint --graph scan reads an import graph whose scope is not a set of paths; a baseline written from it still
  // replaces the whole section.
  const scope = {
    paths: scannedPaths,
    workspaces: values.workspace ?? [],
    ignoredRules: values.ignore ?? [],
    minImpact: values['min-impact'],
  };
  return { ...options, partialScan, scope };
}

function baselineNoteLines({ hidden, stale }) {
  const lines = [`${hidden} baseline findings hidden.`];
  if (stale === null)
    lines.push('Checking for stale baseline entries requires a full scan with the original settings.');
  else if (stale)
    lines.push(
      `${stale} stale baseline entries were absent from this scan. Check the original scan settings before refreshing the baseline.`,
    );
  return lines;
}

module.exports = {
  DEFAULT_BASELINE_NAME,
  applyBaselineOptions,
  baselineForScan,
  baselineNoteLines,
  extractBaselineFlags,
  resolveBaselineFile,
};
