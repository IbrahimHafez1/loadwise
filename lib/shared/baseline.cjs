'use strict';

// Baselines let a team adopt loadwise on existing code: --write-baseline records today's findings, --baseline hides
// them so only new ones are reported. One file holds a section per pillar, so `loadwise check` and the single-pillar
// commands share it. (The migrations baseline is a different, per-file hash format and stays in perf/migrations.)
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_BASELINE_NAME = 'loadwise-baseline.json';
const BASELINE_VERSION = 1;
const baselineFlags = ['--baseline', '--write-baseline'];
const BOM_PATTERN = new RegExp('^' + String.fromCharCode(0xfeff));

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
    if (argument.startsWith(flag + '=')) options[key] = { file: argument.slice(flag.length + 1) };
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

// The fingerprint is the finding id without its collision suffix: the id hashes rule, file and flagged text, never the
// line number. Counts per key make N existing copies allow N findings.
function createFindingKey(baselineFile, absoluteFileOf) {
  const baseDirectory = path.dirname(baselineFile);
  return (finding) => ({
    ruleId: finding.ruleId,
    file: path.relative(baseDirectory, absoluteFileOf(finding)).split(path.sep).join('/'),
    fingerprint: finding.id.replace(/-\d+$/, ''),
  });
}

const keyText = ({ ruleId, file, fingerprint }) => [ruleId, file, fingerprint].join('\0');

function compareEntries(left, right) {
  return (
    left.ruleId.localeCompare(right.ruleId) ||
    left.file.localeCompare(right.file) ||
    left.fingerprint.localeCompare(right.fingerprint)
  );
}

// Replaces one pillar's section and keeps the others, so pillars can be baselined one at a time.
function writePillarBaseline(baselineFile, pillar, findings, findingKey) {
  const counts = new Map();
  for (const finding of findings) {
    const key = findingKey(finding);
    const entry = counts.get(keyText(key)) ?? { ...key, count: 0 };
    entry.count++;
    counts.set(keyText(key), entry);
  }
  const entries = [...counts.values()].sort(compareEntries);
  const pillars = { ...readDocument(baselineFile)?.pillars, [pillar]: { findings: entries } };
  const sorted = Object.fromEntries(Object.entries(pillars).sort(([left], [right]) => left.localeCompare(right)));
  fs.writeFileSync(baselineFile, JSON.stringify({ version: BASELINE_VERSION, pillars: sorted }, null, 2) + '\n');
  return findings.length;
}

// Removes findings the baseline accounts for. `stale` counts recorded findings that no longer occur; they leave the
// file only on the next --write-baseline.
function filterPillarBaseline(baselineFile, pillar, findings, findingKey, partialScan) {
  const document = readDocument(baselineFile);
  if (!document) throw new Error(`Baseline not found: ${baselineFile}. Create it with --write-baseline.`);
  const remaining = new Map();
  for (const entry of document.pillars[pillar]?.findings ?? []) remaining.set(keyText(entry), entry.count);
  const fresh = [];
  for (const finding of findings) {
    const key = keyText(findingKey(finding));
    if (remaining.get(key) > 0) remaining.set(key, remaining.get(key) - 1);
    else fresh.push(finding);
  }
  const stale = partialScan ? null : [...remaining.values()].reduce((total, count) => total + count, 0);
  return { findings: fresh, hidden: findings.length - fresh.length, stale };
}

// Returns undefined without baseline flags, { written, file } after --write-baseline, or the filtered result.
function applyBaselineOptions({ options, pillar, findings, projectRoot, absoluteFileOf }) {
  if (options.baseline && options.writeBaseline) throw new Error('Choose either --baseline or --write-baseline.');
  const option = options.writeBaseline ?? options.baseline;
  if (!option) return undefined;
  const file = resolveBaselineFile(option, projectRoot);
  const findingKey = createFindingKey(file, absoluteFileOf);
  if (options.writeBaseline) return { written: writePillarBaseline(file, pillar, findings, findingKey), file };
  return filterPillarBaseline(file, pillar, findings, findingKey, options.partialScan);
}

function baselineForScan(options, values, limitedInput = false) {
  const partialScan = Boolean(
    limitedInput ||
    values.staged ||
    values['changed-since'] !== undefined ||
    values.workspace?.length ||
    values.ignore?.length ||
    values['min-impact'] ||
    values.graph,
  );
  return { ...options, partialScan };
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
