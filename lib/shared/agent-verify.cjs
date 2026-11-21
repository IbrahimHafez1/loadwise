'use strict';

const fs = require('node:fs');
const { parseArgs } = require('node:util');
const { pillars } = require('./pillars.cjs');

const usage =
  'Usage: loadwise agent verify [--save] [--checker perf|maint|sec] --outcomes outcomes.json report.json [more-reports.json ...]';
const statuses = ['fixed', 'verified', 'intentional', 'false-positive', 'deferred'];
const checkerNames = new Map(
  pillars.flatMap(({ name, jsonKey }) => [
    [name, name],
    [jsonKey, name],
  ]),
);
const emptyEvidence =
  /^(?:n\/?a|none|tbd|todo|ok|done|passed|reviewed|fixed|verified|intentional|false[- ]positive|deferred)[.!]?$/i;

function readJson(file) {
  const bytes = fs.readFileSync(file);
  const utf16 = bytes[0] === 0xff && bytes[1] === 0xfe;
  try {
    return JSON.parse(bytes.toString(utf16 ? 'utf16le' : 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    throw new Error(`Invalid JSON in ${file}.`);
  }
}

function requireArray(value, label) {
  if (!Array.isArray(value)) throw new Error(label + ' must be an array.');
  return value;
}

function identity(finding, defaultChecker) {
  if (!finding || typeof finding !== 'object') return;
  const checker = checkerNames.get('checker' in finding ? finding.checker : defaultChecker);
  const id = finding.id;
  if (
    !checker ||
    (defaultChecker && checker !== defaultChecker) ||
    typeof id !== 'string' ||
    !id.trim() ||
    id !== id.trim()
  )
    return;
  return { checker, id };
}

function reviewLocation(finding) {
  const location = {};
  for (const key of ['ruleId', 'file']) if (typeof finding[key] === 'string') location[key] = finding[key];
  for (const key of ['line', 'column'])
    if (Number.isSafeInteger(finding[key]) && finding[key] > 0) location[key] = finding[key];
  return location;
}

function recordFindings(rows, source, state, checker) {
  for (const row of requireArray(rows, source)) {
    const item = identity(row, checker);
    if (!item) throw new Error(source + ' contains a finding without a valid checker and id.');
    const key = JSON.stringify(item);
    state.expected.set(key, { ...state.expected.get(key), ...item, ...reviewLocation(row) });
  }
}

function recordFixRun(run, source, state) {
  for (const field of ['applied', 'manual', 'pendingReview']) recordFindings(run?.[field], source + '.' + field, state);
  if ('alreadyApplied' in run) recordFindings(run.alreadyApplied, source + '.alreadyApplied', state);
  if ('failed' in run) {
    recordFindings(run.failed, source + '.failed', state);
    for (const finding of run.failed) {
      state.failedApplications.push({ ...identity(finding), source, reason: finding.reason });
    }
  }
}

function recordHistory(report, source, state) {
  if (typeof report.enabled !== 'boolean') throw new Error(source + '.enabled must be a boolean.');
  const runs = requireArray(report.runs, source + '.runs');
  const reviews = requireArray(report.reviews === undefined ? [] : report.reviews, source + '.reviews');
  if (!report.enabled && (runs.length || reviews.length))
    throw new Error(source + ' contains records despite history being disabled.');
  state.history.push({ source, enabled: report.enabled, runs: runs.length, reviews: reviews.length });
  runs.forEach((run, index) => recordFixRun(run, `${source}.runs[${index}]`, state));
  // Past decisions are evidence to inspect. They do not count as current outcomes.
  recordFindings(reviews, source + '.reviews', state);
}

function recordStandaloneScan(report, source, state, selectedChecker) {
  const findings = requireArray(report.findings, source + '.findings');
  let checker = selectedChecker;
  if ('checker' in report) {
    checker = checkerNames.get(report.checker);
    if (!checker || (selectedChecker && checker !== selectedChecker))
      throw new Error(source + ' declares an unknown checker or disagrees with --checker.');
  }
  if (!checker) {
    checker = checkerNames.get(findings[0]?.checker);
    if (!checker || findings.some((finding) => !checkerNames.has(finding?.checker)))
      throw new Error(source + ' needs --checker perf|maint|sec for an unlabelled standalone scan.');
  }
  recordFindings(findings, source + '.findings', state, checker);
}

function recordReport(report, source, state, selectedChecker) {
  if (!report || typeof report !== 'object' || Array.isArray(report))
    throw new Error(source + ' must be a report object.');
  const isHistory = 'runs' in report || 'enabled' in report;
  const isFix = 'applied' in report || 'manual' in report || 'pendingReview' in report;
  const isScan = Object.keys(report).some((name) => checkerNames.has(name));
  const isStandalone = 'findings' in report;
  if ([isHistory, isFix, isScan, isStandalone].filter(Boolean).length !== 1)
    throw new Error(source + ' must contain one scan, fix or history report.');
  if (isStandalone) return recordStandaloneScan(report, source, state, selectedChecker);
  if (isHistory) {
    recordHistory(report, source, state);
    return;
  }
  if (isFix) {
    recordFixRun(report, source, state);
    return;
  }
  for (const [name, result] of Object.entries(report)) {
    const checker = checkerNames.get(name);
    if (!checker) throw new Error(source + ' has an unrecognized checker: ' + name);
    if (result === null) state.unavailable.push({ source, checker });
    else recordFindings(result?.findings, source + '.' + name + '.findings', state, checker);
  }
}

function hasEvidence(value) {
  return typeof value === 'string' && /[\p{L}\p{N}]/u.test(value) && !emptyEvidence.test(value.trim());
}

function reviewCoverage(state, outcomes) {
  const byFinding = new Map();
  const invalid = [];
  const unexpected = [];
  for (const [index, outcome] of outcomes.entries()) {
    const item = identity(outcome);
    if (!item) {
      invalid.push({ index, reason: 'Expected a recognized checker and a nonempty id.' });
      continue;
    }
    const key = JSON.stringify(item);
    if (!byFinding.has(key)) byFinding.set(key, []);
    byFinding.get(key).push(outcome);
    if (!state.expected.has(key)) unexpected.push(item);
    if (!statuses.includes(outcome.status) || !hasEvidence(outcome.evidence)) {
      invalid.push({ index, ...item, reason: 'Use a documented status and specific evidence.' });
    }
  }
  const missing = [];
  const duplicates = [];
  const counts = Object.fromEntries(statuses.map((status) => [status, 0]));
  for (const [key, rows] of byFinding) {
    if (rows.length > 1) duplicates.push({ ...identity(rows[0]), count: rows.length });
    else if (state.expected.has(key) && statuses.includes(rows[0].status) && hasEvidence(rows[0].evidence))
      counts[rows[0].status]++;
  }
  for (const [key, item] of state.expected) if (!byFinding.has(key)) missing.push(item);
  const complete = [state.unavailable, missing, duplicates, unexpected, invalid].every((issues) => !issues.length);
  return {
    complete: complete && state.history.every((history) => history.enabled),
    expected: state.expected.size,
    reviewed: Object.values(counts).reduce((sum, count) => sum + count, 0),
    counts,
    missing,
    duplicates,
    unexpected,
    invalid,
    unavailable: state.unavailable,
    failedApplications: state.failedApplications,
    history: state.history,
  };
}

function runAgentVerify(args) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      outcomes: { type: 'string' },
      checker: { type: 'string', multiple: true },
      save: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    console.log(usage);
    return 0;
  }
  if (!values.outcomes || !positionals.length) throw new Error(usage);
  const selectedChecker = checkerNames.get(values.checker?.[0]);
  if (values.checker && (!selectedChecker || values.checker.length !== 1))
    throw new Error('Pass one checker name to --checker: perf, maint or sec.');
  const outcomes = requireArray(readJson(values.outcomes)?.outcomes, values.outcomes + '.outcomes');
  const state = { expected: new Map(), unavailable: [], failedApplications: [], history: [] };
  for (const report of positionals) recordReport(readJson(report), report, state, selectedChecker);
  const result = reviewCoverage(state, outcomes);
  if (values.save && result.complete) {
    const decisions = outcomes.map((outcome) => ({
      ...state.expected.get(JSON.stringify(identity(outcome))),
      status: outcome.status,
      evidence: outcome.evidence.trim(),
    }));
    result.saved = require('./fix-history.cjs').saveReviewOutcomes(process.cwd(), decisions);
  }
  console.log(JSON.stringify(result, null, 2));
  return result.complete ? 0 : 1;
}

module.exports = { runAgentVerify };
