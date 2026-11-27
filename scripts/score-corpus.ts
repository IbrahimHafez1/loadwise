// Scores loadwise against the hand-labelled corpus in bench/corpus and fails on regressions.
// Usage: node scripts/score-corpus.js [--from <dir>] [--loadwise <dir>] [--corpus <dir>] [--repos
// a,b]
//        [--concurrency n] [--min-precision <0..1>] [--write-scores] [--json] [--scorecard]
// Scans run in parallel, up to 4 at once by default; lower --concurrency when memory is short.
// --scorecard needs no scan: it reads the label files and bench/corpus/scores.json and writes
// scorecard.md.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as perf from '../lib/performance/rule-ids.js';
import * as rel from '../lib/reliability/rule-ids.js';
import * as maint from '../lib/maintainability/rule-ids.js';
import * as sec from '../lib/security/rule-ids.js';

const CORPUS_DIR = path.join(import.meta.dirname, '..', 'bench', 'corpus');
const MANIFEST_PATH = path.join(CORPUS_DIR, 'manifest.json');
const LABELS_DIR = path.join(CORPUS_DIR, 'labels');
const SCORES_PATH = path.join(CORPUS_DIR, 'scores.json');
const SCORECARD_PATH = path.join(CORPUS_DIR, 'scorecard.md');
const FLOOR_EXCEPTIONS_PATH = path.join(CORPUS_DIR, 'precision-floor-exceptions.json');
const LIB_DIR = path.join(import.meta.dirname, '..', 'lib');
const PRECISION_FLOOR = 0.8;
const MINIMUM_LABELS_FOR_FLOOR = 10;
const MEASURED_LABEL_COUNT = 10;
const PILLAR_LIB_DIRS: Record<string, string> = {
  perf: path.join(LIB_DIR, 'performance'),
  // The reliability rules the performance analyzer finds keep their fix builders beside it.
  rel: path.join(LIB_DIR, 'performance'),
  maint: path.join(LIB_DIR, 'maintainability'),
  sec: path.join(LIB_DIR, 'security'),
};
const STATUS_ORDER = ['unmeasured', 'thin', 'measured'];
const RUN_TIMEOUT_MS = 20 * 60 * 1000;
const MAX_OUTPUT_BYTES = 1024 * 1024 * 1024;
const GIT_TIMEOUT_MS = 30 * 1000;
const PRETTIER_BIN = path.join(
  path.dirname(fileURLToPath(import.meta.resolve('prettier/package.json'))),
  'bin',
  'prettier.cjs',
);
const PILLARS: Record<string, string> = {
  perf: 'performance',
  rel: 'reliability',
  maint: 'maintainability',
  sec: 'security',
};
const CORPUS_PATH_MARKER = 'loadwise-corpus/';
const FLAG_NAMES_WITH_VALUE = new Set(['from', 'loadwise', 'corpus', 'repos', 'concurrency', 'min-precision']);
const RULE_COLUMN_WIDTH = 52;
const NUMBER_COLUMN_WIDTH = 6;

/**
 * The command-line flags: a flag without a value is `true`, a flag that takes one holds its text.
 */
interface ScoreOptions {
  [flag: string]: string | boolean | undefined;
  from?: string;
  loadwise?: string;
  corpus?: string;
  repos?: string;
  concurrency?: string;
  'min-precision'?: string;
  scorecard?: boolean;
  json?: boolean;
  'write-scores'?: boolean;
}

/** One hand-labelled finding in bench/corpus/labels. */
interface Label {
  pillar: string;
  ruleId: string;
  file: string;
  line: number;
  verdict: string;
  note: string;
}

/** A finding as the scan prints it; only these fields are scored. */
interface ScoredFinding {
  ruleId: string;
  file: string;
  line: number;
  contextualReason?: string;
}

/** One scanned repo and pillar. */
interface ScanUnit {
  repo: string;
  pillar: string;
  findings: ScoredFinding[];
}

interface RuleStats {
  tp: number;
  fp: number;
  missed: number;
  unlabelled: number;
  findings: number;
  contextual: number;
  precision: number | null;
  recall: number | null;
}

type StatsByRule = Record<string, RuleStats>;

interface LabelResult {
  key: string;
  repo: string;
  label: Label;
  present: boolean;
}

interface ScoreResult {
  rules: StatsByRule;
  labelResults: LabelResult[];
}

/** bench/corpus/scores.json. */
interface StoredScores {
  scanned?: string[];
  rules: StatsByRule;
  labels?: Record<string, boolean>;
}

interface CountDelta {
  rule: string;
  before: number;
  after: number;
  delta: number;
}

interface CorpusRepo {
  name: string;
  commit: string;
}

interface ScanJob {
  name: string;
  repoDir: string;
  pillar: string;
}

interface LabelCounts {
  tp: number;
  fp: number;
  missed: number;
}

type RuleStatus = 'unmeasured' | 'thin' | 'measured';

interface RegisteredPillar {
  ruleIds: string[];
  impactByRule: Record<string, string>;
}

interface ScorecardRow {
  pillar: string;
  ruleId: string;
  impact: string;
  tp: number;
  fp: number;
  missed: number;
  precision: number | null;
  recall: number | null;
  hasFix: boolean;
  status: RuleStatus;
}

function parseArgs(argv: readonly string[]): ScoreOptions {
  const options: ScoreOptions = {};
  for (let index = 0; index < argv.length; index++) {
    const name = argv[index].replace(/^--/, '');
    options[name] = FLAG_NAMES_WITH_VALUE.has(name) ? argv[++index] : true;
  }
  return options;
}

// Findings carry paths relative to the scan's working directory; labels are relative to the repo
// root.
function normalizeFile(file: string, repo: string): string {
  const slashed = file.replaceAll('\\', '/');
  const marker = `${CORPUS_PATH_MARKER}${repo}/`;
  const markerIndex = slashed.indexOf(marker);
  return markerIndex === -1 ? slashed : slashed.slice(markerIndex + marker.length);
}

const locationKey = ({ ruleId, file, line }: Pick<ScoredFinding, 'ruleId' | 'file' | 'line'>): string =>
  `${ruleId}\0${file}\0${line}`;
const ruleKey = (pillar: string, ruleId: string): string => `${pillar}/${ruleId}`;
const labelKey = (repo: string, label: Label): string =>
  `${repo} ${label.pillar}/${label.ruleId} ${label.file}:${label.line}`;

function emptyRuleStats(): RuleStats {
  return { tp: 0, fp: 0, missed: 0, unlabelled: 0, findings: 0, contextual: 0, precision: null, recall: null };
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : Number((numerator / denominator).toFixed(4));
}

// A unit is one scanned repo and pillar: { repo, pillar, findings: [{ ruleId, file, line,
// contextualReason }] }. A "missed" label that is now reported counts as a TP; a "tp" label that
// vanished counts against recall.
function scoreUnits(units: readonly ScanUnit[], labelsByRepo: Record<string, Label[]>): ScoreResult {
  const rules: StatsByRule = {};
  const labelResults: LabelResult[] = [];
  const statsFor = (pillar: string, ruleId: string) => (rules[ruleKey(pillar, ruleId)] ??= emptyRuleStats());

  for (const unit of units) {
    const labels = (labelsByRepo[unit.repo] ?? []).filter((label) => label.pillar === unit.pillar);
    const labelledKeys = new Set(labels.map(locationKey));
    const defaultKeys = new Set<string>();

    for (const finding of unit.findings) {
      const stats = statsFor(unit.pillar, finding.ruleId);
      if (finding.contextualReason) {
        stats.contextual++;
        continue;
      }
      stats.findings++;
      const key = locationKey({ ...finding, file: normalizeFile(finding.file, unit.repo) });
      defaultKeys.add(key);
      if (!labelledKeys.has(key)) stats.unlabelled++;
    }

    for (const label of labels) {
      const present = defaultKeys.has(locationKey(label));
      const stats = statsFor(unit.pillar, label.ruleId);
      if (label.verdict === 'fp') {
        if (present) stats.fp++;
      } else if (present) {
        stats.tp++;
      } else {
        stats.missed++;
      }
      labelResults.push({ key: labelKey(unit.repo, label), repo: unit.repo, label, present });
    }
  }

  for (const stats of Object.values(rules)) {
    stats.precision = ratio(stats.tp, stats.tp + stats.fp);
    stats.recall = ratio(stats.tp, stats.tp + stats.missed);
  }
  return { rules, labelResults };
}

function labelText({ repo, label }: Pick<LabelResult, 'repo' | 'label'>): string {
  return `${repo} ${label.pillar}/${label.ruleId} ${label.file}:${label.line} [${label.verdict}] ${label.note}`;
}

// Many labelled FPs are still reported today, so a label only regresses against its state in the
// baseline.
function findRegressions(
  current: ScoreResult,
  baseline: Pick<StoredScores, 'rules' | 'labels'>,
  { compareMetrics }: { compareMetrics: boolean },
): string[] {
  const regressions: string[] = [];
  for (const result of current.labelResults) {
    const wasPresent = baseline.labels?.[result.key];
    if (wasPresent === undefined) continue;
    if (result.label.verdict !== 'fp' && wasPresent && !result.present) {
      regressions.push(`labelled TP disappeared: ${labelText(result)}`);
    }
    if (result.label.verdict === 'fp' && !wasPresent && result.present) {
      regressions.push(`labelled FP reappeared: ${labelText(result)}`);
    }
  }
  if (!compareMetrics) return regressions;

  for (const [key, before] of Object.entries(baseline.rules)) {
    const after = current.rules[key] ?? emptyRuleStats();
    for (const metric of ['precision', 'recall'] as const) {
      const beforeValue = before[metric];
      if (beforeValue === null || beforeValue === undefined) continue;
      const afterValue = after[metric] ?? 0;
      if (afterValue < beforeValue) regressions.push(`${key} ${metric} dropped ${beforeValue} -> ${afterValue}`);
    }
  }
  return regressions;
}

function labelStates(labelResults: readonly LabelResult[]): Record<string, boolean> {
  return Object.fromEntries(labelResults.map((result) => [result.key, result.present]));
}

function countDeltas(current: Pick<ScoreResult, 'rules'>, baseline: Pick<StoredScores, 'rules'>): CountDelta[] {
  const deltas: CountDelta[] = [];
  const keys = new Set([...Object.keys(current.rules), ...Object.keys(baseline.rules)]);
  for (const key of [...keys].sort()) {
    const before = baseline.rules[key]?.findings ?? 0;
    const after = current.rules[key]?.findings ?? 0;
    if (before !== after) deltas.push({ rule: key, before, after, delta: after - before });
  }
  return deltas;
}

function readJson<Content>(file: string): Content {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function readLabels(repoNames: readonly string[]): Record<string, Label[]> {
  const labelsByRepo: Record<string, Label[]> = {};
  for (const repo of repoNames) {
    const file = path.join(LABELS_DIR, `${repo}.json`);
    labelsByRepo[repo] = fs.existsSync(file) ? readJson<Label[]>(file) : [];
  }
  return labelsByRepo;
}

function parseScan(text: string, pillar: string): ScoredFinding[] | null {
  const scan: Record<string, { findings?: ScoredFinding[] } | undefined> | null = text.trim() ? JSON.parse(text) : null;
  return scan?.[PILLARS[pillar]]?.findings ?? null;
}

function readFromDirectory(directory: string, repo: string, pillar: string): ScoredFinding[] | null {
  const file = path.join(directory, `${repo}.${pillar}.json`);
  return fs.existsSync(file) ? parseScan(fs.readFileSync(file, 'utf8'), pillar) : null;
}

function gitHead(repoDir: string): string | null {
  const result = spawnSync('git', ['-C', repoDir, 'rev-parse', 'HEAD'], { encoding: 'utf8', timeout: GIT_TIMEOUT_MS });
  return result.status === 0 ? result.stdout.trim() : null;
}

function runLoadwiseAsync(loadwiseDir: string, repoDir: string, pillar: string): Promise<ScoredFinding[] | null> {
  const cliPath = path.join(loadwiseDir, 'bin', 'loadwise.js');
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [cliPath, 'check', repoDir, '--only', pillar, '--json', '--include-contextual'],
      { cwd: loadwiseDir, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    let stdout = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`loadwise ${pillar} on ${repoDir}: timed out`));
    }, RUN_TIMEOUT_MS);
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      if (stdout.length + chunk.length <= MAX_OUTPUT_BYTES) stdout += chunk;
    });
    child.on('error', (error: Error) => {
      clearTimeout(timer);
      reject(new Error(`loadwise ${pillar} on ${repoDir}: ${error.message}`));
    });
    child.on('close', () => {
      clearTimeout(timer);
      try {
        resolve(parseScan(stdout, pillar));
      } catch (error) {
        reject(error);
      }
    });
  });
}

async function runPool<Result>(tasks: readonly (() => Promise<Result>)[], concurrency: number): Promise<Result[]> {
  const results: Result[] = [];
  let next = 0;
  async function worker(): Promise<void> {
    while (next < tasks.length) {
      const index = next++;
      results[index] = await tasks[index]();
    }
  }
  const count = Math.max(1, Math.min(concurrency, tasks.length));
  await Promise.all(Array.from({ length: count }, worker));
  return results;
}

async function collectUnits(
  options: ScoreOptions,
  repos: readonly CorpusRepo[],
): Promise<{ units: ScanUnit[]; skipped: string[] }> {
  const loadwiseDir = path.resolve(options.loadwise ?? path.join(import.meta.dirname, '..'));
  const corpusDir = path.resolve(options.corpus ?? path.join(loadwiseDir, '..', 'loadwise-corpus'));
  const concurrency = Math.max(1, Number(options.concurrency) || Math.min(4, os.cpus().length || 2));
  const units: ScanUnit[] = [];
  const skipped: string[] = [];
  const jobs: ScanJob[] = [];
  for (const { name, commit } of repos) {
    const repoDir = path.join(corpusDir, name);
    const head = options.from ? commit : gitHead(repoDir);
    if (head !== commit) {
      skipped.push(`${name}: HEAD ${head ?? 'unavailable'} differs from pin ${commit}`);
      continue;
    }
    for (const pillar of Object.keys(PILLARS)) {
      jobs.push({ name, repoDir, pillar });
    }
  }
  const outputs = await runPool(
    jobs.map(({ name, repoDir, pillar }) => async () => {
      const findings = options.from
        ? readFromDirectory(path.resolve(options.from), name, pillar)
        : await runLoadwiseAsync(loadwiseDir, repoDir, pillar);
      return { name, pillar, findings };
    }),
    options.from ? 1 : concurrency,
  );
  for (const { name, pillar, findings } of outputs) {
    if (findings) units.push({ repo: name, pillar, findings });
    else skipped.push(`${name}.${pillar}: no scan output`);
  }
  return { units, skipped };
}

function formatRuleTable(rules: StatsByRule): string {
  const percent = (value: number | null) => (value === null ? '-' : `${(value * 100).toFixed(0)}%`);
  const columns = ['TP', 'FP', 'miss', 'unlab', 'ctx', 'prec', 'rec'];
  const line = (name: string, cells: readonly (string | number)[]) =>
    name.padEnd(RULE_COLUMN_WIDTH) + cells.map((cell) => String(cell).padStart(NUMBER_COLUMN_WIDTH)).join('');
  const rows = Object.keys(rules)
    .sort()
    .map((key) => {
      const stats = rules[key];
      const { tp, fp, missed, unlabelled, contextual, precision, recall } = stats;
      return line(key, [tp, fp, missed, unlabelled, contextual, percent(precision), percent(recall)]);
    });
  return [line('rule', columns), ...rows].join('\n');
}

function readAllLabels(): Label[] {
  return fs
    .readdirSync(LABELS_DIR)
    .filter((name) => name.endsWith('.json'))
    .flatMap((name) => readJson<Label[]>(path.join(LABELS_DIR, name)));
}

function registeredRules(): Record<string, RegisteredPillar> {
  return {
    perf: { ruleIds: [...perf.knownRules], impactByRule: perf.impactByRule },
    rel: { ruleIds: [...rel.knownRules], impactByRule: rel.impactByRule },
    maint: { ruleIds: [...maint.knownRules], impactByRule: maint.impactByRule },
    sec: { ruleIds: sec.securityRules, impactByRule: sec.impactByRule },
  };
}

// Fix builders are exported by rule id from each pillar's site-fixes modules (see
// lib/*/site-fix.cjs).
async function fixRuleIds(pillar: string): Promise<Set<string>> {
  const directory = path.join(PILLAR_LIB_DIRS[pillar], 'site-fixes');
  const ruleIds = new Set<string>();
  for (const name of fs.readdirSync(directory).filter((file) => file.endsWith('.js'))) {
    const loaded: { default?: Record<string, unknown> } = await import(pathToFileURL(path.join(directory, name)).href);
    const builders = loaded.default ?? loaded;
    for (const [ruleId, build] of Object.entries(builders)) {
      if (typeof build === 'function') ruleIds.add(ruleId);
    }
  }
  return ruleIds;
}

function countLabels(labels: readonly Label[]): Record<string, LabelCounts> {
  const counts: Record<string, LabelCounts> = {};
  for (const { pillar, ruleId, verdict } of labels) {
    const entry = (counts[ruleKey(pillar, ruleId)] ??= { tp: 0, fp: 0, missed: 0 });
    if (verdict === 'tp' || verdict === 'fp' || verdict === 'missed') entry[verdict]++;
  }
  return counts;
}

function classifyStatus(labelTotal: number): RuleStatus {
  if (labelTotal === 0) return 'unmeasured';
  return labelTotal >= MEASURED_LABEL_COUNT ? 'measured' : 'thin';
}

function buildScorecard(
  registry: Record<string, RegisteredPillar>,
  labelCounts: Record<string, LabelCounts>,
  storedRules: Record<string, Pick<RuleStats, 'precision' | 'recall'>>,
  fixIdsByPillar: Record<string, ReadonlySet<string>>,
): Record<string, ScorecardRow[]> {
  const scorecard: Record<string, ScorecardRow[]> = {};
  for (const [pillar, { ruleIds, impactByRule }] of Object.entries(registry)) {
    scorecard[pillar] = ruleIds.map((ruleId) => {
      const key = ruleKey(pillar, ruleId);
      const { tp, fp, missed } = labelCounts[key] ?? { tp: 0, fp: 0, missed: 0 };
      return {
        pillar,
        ruleId,
        impact: impactByRule[ruleId] ?? '-',
        tp,
        fp,
        missed,
        precision: storedRules[key]?.precision ?? null,
        recall: storedRules[key]?.recall ?? null,
        hasFix: fixIdsByPillar[pillar].has(ruleId),
        status: classifyStatus(tp + fp + missed),
      };
    });
  }
  return scorecard;
}

// Unmeasured rules first, then the lowest precision; rules without a precision follow the measured
// ones.
function compareScorecardRows(left: ScorecardRow, right: ScorecardRow): number {
  const statusGap = Number(right.status === 'unmeasured') - Number(left.status === 'unmeasured');
  if (statusGap !== 0) return statusGap;
  const leftPrecision = left.precision ?? Infinity;
  const rightPrecision = right.precision ?? Infinity;
  if (leftPrecision !== rightPrecision) return leftPrecision < rightPrecision ? -1 : 1;
  return left.ruleId.localeCompare(right.ruleId);
}

const percentText = (value: number | null): string => (value === null ? '-' : `${(value * 100).toFixed(0)}%`);

function statusSummary(rows: readonly ScorecardRow[]): string {
  const counts: Record<string, number> = Object.fromEntries(STATUS_ORDER.map((status) => [status, 0]));
  for (const row of rows) counts[row.status]++;
  return `${rows.length} rules: ${counts.measured} measured, ${counts.thin} thin, ${counts.unmeasured} unmeasured`;
}

function formatScorecard(scorecard: Record<string, ScorecardRow[]>): string {
  const header = '| Rule | Impact | TP | FP | Missed | Precision | Recall | Fix | Status |';
  const divider = '| --- | --- | ---: | ---: | ---: | ---: | ---: | --- | --- |';
  const sections = Object.entries(scorecard).map(([pillar, rows]) => {
    const lines = [...rows].sort(compareScorecardRows).map((row) => {
      const cells: (string | number)[] = [
        row.ruleId,
        row.impact,
        row.tp,
        row.fp,
        row.missed,
        percentText(row.precision),
      ];
      cells.push(percentText(row.recall), row.hasFix ? 'yes' : 'no', row.status);
      return `| ${cells.join(' | ')} |`;
    });
    return [`## ${pillar}`, '', statusSummary(rows), '', header, divider, ...lines].join('\n');
  });
  return ['# Rule scorecard', '', ...sections].join('\n\n') + '\n';
}

async function writeScorecard(): Promise<number> {
  const registry = registeredRules();
  const entries = await Promise.all(
    Object.keys(PILLARS).map(async (pillar) => [pillar, await fixRuleIds(pillar)] as const),
  );
  const fixIdsByPillar = Object.fromEntries(entries);
  const stored = readJson<StoredScores>(SCORES_PATH);
  const scorecard = buildScorecard(registry, countLabels(readAllLabels()), stored.rules, fixIdsByPillar);
  fs.writeFileSync(SCORECARD_PATH, formatScorecard(scorecard));
  // The project's own Prettier aligns the tables, so a fresh scorecard passes `npm run
  // format:check`.
  const prettier = spawnSync(process.execPath, [PRETTIER_BIN, '--write', SCORECARD_PATH], { encoding: 'utf8' });
  if (prettier.status !== 0) throw new Error(`prettier failed on the scorecard: ${prettier.stderr}`);
  console.log(`Wrote ${path.relative(process.cwd(), SCORECARD_PATH)}`);
  return 0;
}

// Only default-level findings are scored into tp/fp (contextual ones are counted separately), so
// the floor judges exactly the findings users see by default.
function findBelowFloor(rules: StatsByRule, exceptions: readonly { rule: string }[]): string[] {
  const excepted = new Set(exceptions.map((exception) => exception.rule));
  return Object.keys(rules)
    .sort()
    .filter((key) => {
      const { tp, fp, precision } = rules[key];
      return tp + fp >= MINIMUM_LABELS_FOR_FLOOR && (precision ?? 0) < PRECISION_FLOOR && !excepted.has(key);
    });
}

function readFloorExceptions(): { rule: string }[] {
  return fs.existsSync(FLOOR_EXCEPTIONS_PATH) ? readJson<{ rule: string }[]>(FLOOR_EXCEPTIONS_PATH) : [];
}

function parseMinPrecision(raw: string | boolean | undefined): number | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new Error('--min-precision must be a finite number in [0, 1].');
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error('--min-precision must be a finite number in [0, 1].');
  }
  return value;
}

function overallPrecision(rules: StatsByRule): number | null {
  let tp = 0;
  let fp = 0;
  for (const stats of Object.values(rules)) {
    tp += stats.tp;
    fp += stats.fp;
  }
  return ratio(tp, tp + fp);
}

function findBelowMinPrecision(rules: StatsByRule, minPrecision: number): string[] {
  const below = Object.keys(rules)
    .sort()
    .filter((key) => {
      const { precision } = rules[key];
      return precision !== null && precision < minPrecision;
    });
  const overall = overallPrecision(rules);
  if (overall !== null && overall < minPrecision) below.push('overall');
  return below;
}

async function main(argv: readonly string[]): Promise<number> {
  const options = parseArgs(argv);
  if (options.scorecard) return await writeScorecard();
  let minPrecision: number | undefined;
  try {
    minPrecision = parseMinPrecision(options['min-precision']);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
  const manifest = readJson<{ repos: CorpusRepo[] }>(MANIFEST_PATH);
  const wanted = options.repos ? new Set(options.repos.split(',')) : null;
  const repos = manifest.repos.filter((repo) => !wanted || wanted.has(repo.name));
  const { units, skipped } = await collectUnits(options, repos);
  const current = scoreUnits(units, readLabels(repos.map((repo) => repo.name)));
  const scanned = units.map((unit) => `${unit.repo}.${unit.pillar}`).sort();

  if (options['write-scores']) {
    fs.writeFileSync(
      SCORES_PATH,
      `${JSON.stringify({ scanned, rules: current.rules, labels: labelStates(current.labelResults) }, null, 2)}\n`,
    );
    console.log(`Wrote ${path.relative(process.cwd(), SCORES_PATH)} (${Object.keys(current.rules).length} rules)`);
    return 0;
  }

  const baseline: StoredScores = fs.existsSync(SCORES_PATH)
    ? readJson<StoredScores>(SCORES_PATH)
    : { scanned: [], rules: {} };
  const compareMetrics = JSON.stringify(scanned) === JSON.stringify(baseline.scanned);
  const regressions = findRegressions(current, baseline, { compareMetrics });
  const deltas = countDeltas(current, baseline);
  const belowFloor = findBelowFloor(current.rules, readFloorExceptions());
  const belowMinPrecision = minPrecision === undefined ? [] : findBelowMinPrecision(current.rules, minPrecision);
  const exitCode = regressions.length > 0 || belowFloor.length > 0 || belowMinPrecision.length > 0 ? 1 : 0;

  if (options.json) {
    console.log(
      JSON.stringify(
        { scanned, skipped, rules: current.rules, deltas, regressions, belowFloor, belowMinPrecision },
        null,
        2,
      ),
    );
    return exitCode;
  }
  console.log(formatRuleTable(current.rules));
  for (const note of skipped) console.log(`skipped ${note}`);
  if (!compareMetrics)
    console.log('Scanned set differs from the baseline: rule metrics not compared, label checks apply.');
  for (const { rule, before, after } of deltas) console.log(`count delta ${rule}: ${before} -> ${after}`);
  for (const regression of regressions) console.log(`REGRESSION ${regression}`);
  if (belowFloor.length > 0) console.log(`Below precision floor (${PRECISION_FLOOR}):`);
  for (const key of belowFloor) console.log(`  ${key} precision ${current.rules[key].precision}`);
  if (belowMinPrecision.length > 0) console.log(`Below --min-precision (${minPrecision}):`);
  for (const key of belowMinPrecision) {
    const value = key === 'overall' ? overallPrecision(current.rules) : current.rules[key].precision;
    console.log(`  ${key} precision ${value}`);
  }
  return exitCode;
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename)
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });

export {
  normalizeFile,
  scoreUnits,
  findRegressions,
  countDeltas,
  labelStates,
  classifyStatus,
  buildScorecard,
  findBelowFloor,
  parseArgs,
  parseMinPrecision,
  overallPrecision,
  findBelowMinPrecision,
  main,
  PRECISION_FLOOR,
  MINIMUM_LABELS_FOR_FLOOR,
};
