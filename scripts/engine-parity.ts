// Runs `loadwise perf` on the JS and native engines for each project and fails when their results
// differ.
// Usage: node scripts/engine-parity.js [projectDir ...] With no arguments it scans the repos in
// bench/corpus/manifest.json under ../loadwise-corpus.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { Finding } from '../lib/shared/types.js';

const LOADWISE_DIR = path.join(import.meta.dirname, '..');
const CLI_PATH = path.join(LOADWISE_DIR, 'bin', 'loadwise.js');
const MANIFEST_PATH = path.join(LOADWISE_DIR, 'bench', 'corpus', 'manifest.json');
const DEFAULT_CORPUS_DIR = path.join(LOADWISE_DIR, '..', 'loadwise-corpus');
const ENGINES = ['js', 'native'];
const RUN_TIMEOUT_MS = 20 * 60 * 1000;
const MAX_OUTPUT_BYTES = 1024 * 1024 * 1024;
const NOT_COMPARABLE_EXIT_CODE = 2;
const MAX_EXAMPLES_PER_RULE = 5;
const FINDINGS_EXIT_CODE = 1;

type KeyedFinding = Pick<Finding, 'file' | 'line' | 'column' | 'ruleId'>;

/** A finding location read back from its key. */
interface ParsedKey {
  ruleId: string;
  file: string;
  line: string;
  column: string;
}

/** The parts of `loadwise perf --json` output the comparison reads. */
interface EngineReport {
  findings?: Finding[];
  scannedFiles?: unknown;
  skippedFiles?: unknown;
}

interface EngineRun {
  exitCode: number | null;
  stderrFirstLine: string;
  result: EngineReport | null;
}

type EngineComparison =
  | { kind: 'not-comparable'; reason: string }
  | {
      kind: 'same' | 'different';
      onlyJs: ParsedKey[];
      onlyNative: ParsedKey[];
      scannedDiffers: boolean;
      skippedDiffers: boolean;
    };

const findingKey = ({ file, line, column, ruleId }: KeyedFinding): string => `${ruleId}\0${file}\0${line}\0${column}`;

function parseKey(key: string): ParsedKey {
  const [ruleId, file, line, column] = key.split('\0');
  return { ruleId, file, line, column };
}

function keySet(findings: readonly Finding[] | undefined): Set<string> {
  return new Set((findings ?? []).map((finding) => findingKey(finding)));
}

function difference(left: ReadonlySet<string>, right: ReadonlySet<string>): ParsedKey[] {
  return [...left].filter((key) => !right.has(key)).map(parseKey);
}

const normalizeList = (value: unknown): string =>
  JSON.stringify(Array.isArray(value) ? [...value].map(String).sort() : (value ?? null));

// A run is { exitCode, stderrFirstLine, result } where result is the parsed --json output (or
// null).
function isComparable(run: EngineRun): run is EngineRun & { result: EngineReport } {
  return run.exitCode !== NOT_COMPARABLE_EXIT_CODE && Boolean(run.result);
}

function compareRuns(jsRun: EngineRun, nativeRun: EngineRun): EngineComparison {
  if (!isComparable(jsRun) || !isComparable(nativeRun)) {
    const failed = isComparable(jsRun) ? nativeRun : jsRun;
    const reason = failed.stderrFirstLine || `exit code ${failed.exitCode}`;
    return { kind: 'not-comparable', reason };
  }
  const jsKeys = keySet(jsRun.result.findings);
  const nativeKeys = keySet(nativeRun.result.findings);
  const onlyJs = difference(jsKeys, nativeKeys);
  const onlyNative = difference(nativeKeys, jsKeys);
  const scannedDiffers = normalizeList(jsRun.result.scannedFiles) !== normalizeList(nativeRun.result.scannedFiles);
  const skippedDiffers = normalizeList(jsRun.result.skippedFiles) !== normalizeList(nativeRun.result.skippedFiles);
  const same = !onlyJs.length && !onlyNative.length && !scannedDiffers && !skippedDiffers;
  return { kind: same ? 'same' : 'different', onlyJs, onlyNative, scannedDiffers, skippedDiffers };
}

function groupByRule(locations: readonly ParsedKey[]): Map<string, ParsedKey[]> {
  const groups = new Map<string, ParsedKey[]>();
  for (const location of locations) {
    const group = groups.get(location.ruleId);
    if (group) group.push(location);
    else groups.set(location.ruleId, [location]);
  }
  return groups;
}

function formatGroups(label: string, locations: readonly ParsedKey[]): string[] {
  const lines: string[] = [];
  for (const [ruleId, group] of [...groupByRule(locations)].sort()) {
    lines.push(`  ${label} ${ruleId}: ${group.length}`);
    for (const { file, line, column } of group.slice(0, MAX_EXAMPLES_PER_RULE)) {
      lines.push(`    ${file}:${line}:${column}`);
    }
  }
  return lines;
}

function formatComparison(project: string, comparison: EngineComparison): string[] {
  if (comparison.kind === 'not-comparable') return [`${project}: not comparable (${comparison.reason})`];
  if (comparison.kind === 'same') return [`${project}: same`];
  const { onlyJs, onlyNative, scannedDiffers, skippedDiffers } = comparison;
  const lines = [`${project}: DIFFERENT (only-js ${onlyJs.length}, only-native ${onlyNative.length})`];
  if (scannedDiffers) lines.push('  scannedFiles differ');
  if (skippedDiffers) lines.push('  skippedFiles differ');
  return [...lines, ...formatGroups('only-js', onlyJs), ...formatGroups('only-native', onlyNative)];
}

function parseJson(text: string): EngineReport | null {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function runEngine(projectDir: string, engine: string): EngineRun {
  const args = [CLI_PATH, 'perf', '-p', projectDir, '--engine', engine, '--json', '--include-contextual'];
  const spawned = spawnSync(process.execPath, args, {
    cwd: LOADWISE_DIR,
    encoding: 'utf8',
    timeout: RUN_TIMEOUT_MS,
    maxBuffer: MAX_OUTPUT_BYTES,
  });
  const timedOut = spawned.error ? `${engine} engine: ${spawned.error.message}` : '';
  const stderrFirstLine = timedOut || (spawned.stderr ?? '').split(/\r?\n/).find((line) => line.trim()) || '';
  const exitCode = spawned.error ? NOT_COMPARABLE_EXIT_CODE : spawned.status;
  const result = exitCode === NOT_COMPARABLE_EXIT_CODE ? null : parseJson(spawned.stdout ?? '');
  return { exitCode, stderrFirstLine, result };
}

function defaultProjects(): string[] {
  const corpusDir = path.resolve(DEFAULT_CORPUS_DIR);
  const manifest: { repos: { name: string }[] } = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  return manifest.repos.map((repo) => path.join(corpusDir, repo.name));
}

function main(argv: readonly string[]): number {
  const projects = argv.length > 0 ? argv.map((project) => path.resolve(project)) : defaultProjects();
  let different = false;
  let comparable = 0;
  for (const project of projects) {
    const [jsRun, nativeRun] = ENGINES.map((engine) => runEngine(project, engine));
    const comparison = compareRuns(jsRun, nativeRun);
    console.log(formatComparison(project, comparison).join('\n'));
    if (comparison.kind === 'different') different = true;
    if (comparison.kind !== 'not-comparable') comparable += 1;
  }
  if (different || (projects.length > 0 && comparable === 0)) return FINDINGS_EXIT_CODE;
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename)
  process.exitCode = main(process.argv.slice(2));

export { compareRuns, formatComparison, findingKey };
