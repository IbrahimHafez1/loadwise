'use strict';

// Scores loadwise against the hand-labelled corpus in bench/corpus and fails on regressions.
// Usage: node scripts/score-corpus.cjs [--from <dir>] [--loadwise <dir>] [--corpus <dir>] [--repos a,b]
//        [--write-scores] [--json] [--scorecard]
// --scorecard needs no scan: it reads the label files and bench/corpus/scores.json and writes scorecard.md.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const CORPUS_DIR = path.join(__dirname, '..', 'bench', 'corpus');
const MANIFEST_PATH = path.join(CORPUS_DIR, 'manifest.json');
const LABELS_DIR = path.join(CORPUS_DIR, 'labels');
const SCORES_PATH = path.join(CORPUS_DIR, 'scores.json');
const SCORECARD_PATH = path.join(CORPUS_DIR, 'scorecard.md');
const FLOOR_EXCEPTIONS_PATH = path.join(CORPUS_DIR, 'precision-floor-exceptions.json');
const LIB_DIR = path.join(__dirname, '..', 'lib');
const PRECISION_FLOOR = 0.8;
const MINIMUM_LABELS_FOR_FLOOR = 10;
const MEASURED_LABEL_COUNT = 10;
const PILLAR_LIB_DIRS = {
  perf: path.join(LIB_DIR, 'performance'),
  maint: path.join(LIB_DIR, 'maintainability'),
  sec: path.join(LIB_DIR, 'security'),
};
const STATUS_ORDER = ['unmeasured', 'thin', 'measured'];
const RUN_TIMEOUT_MS = 20 * 60 * 1000;
const MAX_OUTPUT_BYTES = 1024 * 1024 * 1024;
const GIT_TIMEOUT_MS = 30 * 1000;
const PRETTIER_BIN = path.join(path.dirname(require.resolve('prettier/package.json')), 'bin', 'prettier.cjs');
const PILLARS = { perf: 'performance', maint: 'maintainability', sec: 'security' };
const CORPUS_PATH_MARKER = 'loadwise-corpus/';
const FLAG_NAMES_WITH_VALUE = new Set(['from', 'loadwise', 'corpus', 'repos']);
const RULE_COLUMN_WIDTH = 52;
const NUMBER_COLUMN_WIDTH = 6;

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index++) {
    const name = argv[index].replace(/^--/, '');
    options[name] = FLAG_NAMES_WITH_VALUE.has(name) ? argv[++index] : true;
  }
  return options;
}

// Findings carry paths relative to the scan's working directory; labels are relative to the repo root.
function normalizeFile(file, repo) {
  const slashed = file.replaceAll('\\', '/');
  const marker = `${CORPUS_PATH_MARKER}${repo}/`;
  const markerIndex = slashed.indexOf(marker);
  return markerIndex === -1 ? slashed : slashed.slice(markerIndex + marker.length);
}

const locationKey = ({ ruleId, file, line }) => `${ruleId}\0${file}\0${line}`;
const ruleKey = (pillar, ruleId) => `${pillar}/${ruleId}`;
const labelKey = (repo, label) => `${repo} ${label.pillar}/${label.ruleId} ${label.file}:${label.line}`;

function emptyRuleStats() {
  return { tp: 0, fp: 0, missed: 0, unlabelled: 0, findings: 0, contextual: 0 };
}

function ratio(numerator, denominator) {
  return denominator === 0 ? null : Number((numerator / denominator).toFixed(4));
}

// A unit is one scanned repo and pillar: { repo, pillar, findings: [{ ruleId, file, line, contextualReason }] }.
// A "missed" label that is now reported counts as a TP; a "tp" label that vanished counts against recall.
function scoreUnits(units, labelsByRepo) {
  const rules = {};
  const labelResults = [];
  const statsFor = (pillar, ruleId) => (rules[ruleKey(pillar, ruleId)] ??= emptyRuleStats());

  for (const unit of units) {
    const labels = (labelsByRepo[unit.repo] ?? []).filter((label) => label.pillar === unit.pillar);
    const labelledKeys = new Set(labels.map(locationKey));
    const defaultKeys = new Set();

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

function labelText({ repo, label }) {
  return `${repo} ${label.pillar}/${label.ruleId} ${label.file}:${label.line} [${label.verdict}] ${label.note}`;
}

// Many labelled FPs are still reported today, so a label only regresses against its state in the baseline.
function findRegressions(current, baseline, { compareMetrics }) {
  const regressions = [];
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
    for (const metric of ['precision', 'recall']) {
      if (before[metric] === null || before[metric] === undefined) continue;
      const afterValue = after[metric] ?? 0;
      if (afterValue < before[metric]) regressions.push(`${key} ${metric} dropped ${before[metric]} -> ${afterValue}`);
    }
  }
  return regressions;
}

function labelStates(labelResults) {
  return Object.fromEntries(labelResults.map((result) => [result.key, result.present]));
}

function countDeltas(current, baseline) {
  const deltas = [];
  const keys = new Set([...Object.keys(current.rules), ...Object.keys(baseline.rules)]);
  for (const key of [...keys].sort()) {
    const before = baseline.rules[key]?.findings ?? 0;
    const after = current.rules[key]?.findings ?? 0;
    if (before !== after) deltas.push({ rule: key, before, after, delta: after - before });
  }
  return deltas;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function readLabels(repoNames) {
  const labelsByRepo = {};
  for (const repo of repoNames) {
    const file = path.join(LABELS_DIR, `${repo}.json`);
    labelsByRepo[repo] = fs.existsSync(file) ? readJson(file) : [];
  }
  return labelsByRepo;
}

function parseScan(text, pillar) {
  const scan = text.trim() ? JSON.parse(text) : null;
  return scan?.[PILLARS[pillar]]?.findings ?? null;
}

function readFromDirectory(directory, repo, pillar) {
  const file = path.join(directory, `${repo}.${pillar}.json`);
  return fs.existsSync(file) ? parseScan(fs.readFileSync(file, 'utf8'), pillar) : null;
}

function gitHead(repoDir) {
  const result = spawnSync('git', ['-C', repoDir, 'rev-parse', 'HEAD'], { encoding: 'utf8', timeout: GIT_TIMEOUT_MS });
  return result.status === 0 ? result.stdout.trim() : null;
}

function runLoadwise(loadwiseDir, repoDir, pillar) {
  const cliPath = path.join(loadwiseDir, 'bin', 'loadwise.cjs');
  const result = spawnSync(
    process.execPath,
    [cliPath, 'check', repoDir, '--only', pillar, '--json', '--include-contextual'],
    { cwd: loadwiseDir, encoding: 'utf8', timeout: RUN_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES },
  );
  if (result.error) throw new Error(`loadwise ${pillar} on ${repoDir}: ${result.error.message}`);
  return parseScan(result.stdout, pillar);
}

function collectUnits(options, repos) {
  const loadwiseDir = path.resolve(options.loadwise ?? path.join(__dirname, '..'));
  const corpusDir = path.resolve(options.corpus ?? path.join(loadwiseDir, '..', 'loadwise-corpus'));
  const units = [];
  const skipped = [];
  for (const { name, commit } of repos) {
    const repoDir = path.join(corpusDir, name);
    const head = options.from ? commit : gitHead(repoDir);
    if (head !== commit) {
      skipped.push(`${name}: HEAD ${head ?? 'unavailable'} differs from pin ${commit}`);
      continue;
    }
    for (const pillar of Object.keys(PILLARS)) {
      const findings = options.from
        ? readFromDirectory(path.resolve(options.from), name, pillar)
        : runLoadwise(loadwiseDir, repoDir, pillar);
      if (findings) units.push({ repo: name, pillar, findings });
      else skipped.push(`${name}.${pillar}: no scan output`);
    }
  }
  return { units, skipped };
}

function formatRuleTable(rules) {
  const percent = (value) => (value === null ? '-' : `${(value * 100).toFixed(0)}%`);
  const columns = ['TP', 'FP', 'miss', 'unlab', 'ctx', 'prec', 'rec'];
  const line = (name, cells) =>
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

function readAllLabels() {
  return fs
    .readdirSync(LABELS_DIR)
    .filter((name) => name.endsWith('.json'))
    .flatMap((name) => readJson(path.join(LABELS_DIR, name)));
}

function registeredRules() {
  const perf = require('../lib/performance/rule-ids.cjs');
  const maint = require('../lib/maintainability/rule-ids.cjs');
  const sec = require('../lib/security/rule-ids.cjs');
  return {
    perf: { ruleIds: [...perf.knownRules], impactByRule: perf.impactByRule },
    maint: { ruleIds: [...maint.knownRules], impactByRule: maint.impactByRule },
    sec: { ruleIds: sec.securityRules, impactByRule: sec.impactByRule },
  };
}

// Fix builders are exported by rule id from each pillar's site-fixes modules (see lib/*/site-fix.cjs).
function fixRuleIds(pillar) {
  const directory = path.join(PILLAR_LIB_DIRS[pillar], 'site-fixes');
  const ruleIds = new Set();
  for (const name of fs.readdirSync(directory).filter((file) => file.endsWith('.cjs'))) {
    for (const [ruleId, build] of Object.entries(require(path.join(directory, name)))) {
      if (typeof build === 'function') ruleIds.add(ruleId);
    }
  }
  return ruleIds;
}

function countLabels(labels) {
  const counts = {};
  for (const { pillar, ruleId, verdict } of labels) {
    const entry = (counts[ruleKey(pillar, ruleId)] ??= { tp: 0, fp: 0, missed: 0 });
    if (verdict in entry) entry[verdict]++;
  }
  return counts;
}

function classifyStatus(labelTotal) {
  if (labelTotal === 0) return 'unmeasured';
  return labelTotal >= MEASURED_LABEL_COUNT ? 'measured' : 'thin';
}

function buildScorecard(registry, labelCounts, storedRules, fixIdsByPillar) {
  const scorecard = {};
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

// Unmeasured rules first, then the lowest precision; rules without a precision follow the measured ones.
function compareScorecardRows(left, right) {
  const statusGap = Number(right.status === 'unmeasured') - Number(left.status === 'unmeasured');
  if (statusGap !== 0) return statusGap;
  const leftPrecision = left.precision ?? Infinity;
  const rightPrecision = right.precision ?? Infinity;
  if (leftPrecision !== rightPrecision) return leftPrecision < rightPrecision ? -1 : 1;
  return left.ruleId.localeCompare(right.ruleId);
}

const percentText = (value) => (value === null ? '-' : `${(value * 100).toFixed(0)}%`);

function statusSummary(rows) {
  const counts = Object.fromEntries(STATUS_ORDER.map((status) => [status, 0]));
  for (const row of rows) counts[row.status]++;
  return `${rows.length} rules: ${counts.measured} measured, ${counts.thin} thin, ${counts.unmeasured} unmeasured`;
}

function formatScorecard(scorecard) {
  const header = '| Rule | Impact | TP | FP | Missed | Precision | Recall | Fix | Status |';
  const divider = '| --- | --- | ---: | ---: | ---: | ---: | ---: | --- | --- |';
  const sections = Object.entries(scorecard).map(([pillar, rows]) => {
    const lines = [...rows].sort(compareScorecardRows).map((row) => {
      const cells = [row.ruleId, row.impact, row.tp, row.fp, row.missed, percentText(row.precision)];
      cells.push(percentText(row.recall), row.hasFix ? 'yes' : 'no', row.status);
      return `| ${cells.join(' | ')} |`;
    });
    return [`## ${pillar}`, '', statusSummary(rows), '', header, divider, ...lines].join('\n');
  });
  return ['# Rule scorecard', '', ...sections].join('\n\n') + '\n';
}

function writeScorecard() {
  const registry = registeredRules();
  const fixIdsByPillar = Object.fromEntries(Object.keys(PILLARS).map((pillar) => [pillar, fixRuleIds(pillar)]));
  const stored = readJson(SCORES_PATH);
  const scorecard = buildScorecard(registry, countLabels(readAllLabels()), stored.rules, fixIdsByPillar);
  fs.writeFileSync(SCORECARD_PATH, formatScorecard(scorecard));
  // The project's own Prettier aligns the tables, so a fresh scorecard passes `npm run format:check`.
  const prettier = spawnSync(process.execPath, [PRETTIER_BIN, '--write', SCORECARD_PATH], { encoding: 'utf8' });
  if (prettier.status !== 0) throw new Error(`prettier failed on the scorecard: ${prettier.stderr}`);
  console.log(`Wrote ${path.relative(process.cwd(), SCORECARD_PATH)}`);
  return 0;
}

// Only default-level findings are scored into tp/fp (contextual ones are counted separately), so the floor
// judges exactly the findings users see by default.
function findBelowFloor(rules, exceptions) {
  const excepted = new Set(exceptions.map((exception) => exception.rule));
  return Object.keys(rules)
    .sort()
    .filter((key) => {
      const { tp, fp, precision } = rules[key];
      return tp + fp >= MINIMUM_LABELS_FOR_FLOOR && precision < PRECISION_FLOOR && !excepted.has(key);
    });
}

function readFloorExceptions() {
  return fs.existsSync(FLOOR_EXCEPTIONS_PATH) ? readJson(FLOOR_EXCEPTIONS_PATH) : [];
}

function main(argv) {
  const options = parseArgs(argv);
  if (options.scorecard) return writeScorecard();
  const manifest = readJson(MANIFEST_PATH);
  const wanted = options.repos ? new Set(options.repos.split(',')) : null;
  const repos = manifest.repos.filter((repo) => !wanted || wanted.has(repo.name));
  const { units, skipped } = collectUnits(options, repos);
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

  const baseline = fs.existsSync(SCORES_PATH) ? readJson(SCORES_PATH) : { scanned: [], rules: {} };
  const compareMetrics = JSON.stringify(scanned) === JSON.stringify(baseline.scanned);
  const regressions = findRegressions(current, baseline, { compareMetrics });
  const deltas = countDeltas(current, baseline);
  const belowFloor = findBelowFloor(current.rules, readFloorExceptions());
  const exitCode = regressions.length > 0 || belowFloor.length > 0 ? 1 : 0;

  if (options.json) {
    console.log(JSON.stringify({ scanned, skipped, rules: current.rules, deltas, regressions, belowFloor }, null, 2));
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
  return exitCode;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = {
  normalizeFile,
  scoreUnits,
  findRegressions,
  countDeltas,
  labelStates,
  classifyStatus,
  buildScorecard,
  findBelowFloor,
  PRECISION_FLOOR,
  MINIMUM_LABELS_FOR_FLOOR,
};
