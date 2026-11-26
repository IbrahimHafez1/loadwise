import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { pillars } from './pillars.js';
import { isRecord } from './is-record.js';
import type { ReviewOutcome } from './types/review-history.js';
import { saveReviewOutcomes } from './fix-history.js';

type JsonRecord = Record<string, unknown>;

interface FindingIdentity {
  checker: string;
  id: string;
}

interface ExpectedFinding extends FindingIdentity {
  ruleId?: string;
  file?: string;
  line?: number;
  column?: number;
}

interface FailedApplication extends Partial<FindingIdentity> {
  source: string;
  reason: unknown;
}

interface HistoryEntry {
  source: string;
  enabled: boolean;
  runs: number;
  reviews: number;
}

interface VerifyState {
  expected: Map<string, ExpectedFinding>;
  unavailable: { source: string; checker: string }[];
  failedApplications: FailedApplication[];
  history: HistoryEntry[];
}

interface InvalidOutcome extends Partial<FindingIdentity> {
  index: number;
  reason: string;
}

interface CoverageResult {
  complete: boolean;
  expected: number;
  reviewed: number;
  counts: Record<string, number>;
  missing: ExpectedFinding[];
  duplicates: (Partial<FindingIdentity> & { count: number })[];
  unexpected: FindingIdentity[];
  invalid: InvalidOutcome[];
  unavailable: VerifyState['unavailable'];
  failedApplications: FailedApplication[];
  history: HistoryEntry[];
  saved?: number;
}

const usage =
  'Usage: loadwise agent verify [--save] [--checker perf|maint|sec] --outcomes outcomes.json report.json [more-reports.json ...]';
const statuses = ['fixed', 'verified', 'intentional', 'false-positive', 'deferred'];
const checkerNames = new Map(
  pillars.flatMap(({ name, jsonKey }): [string, string][] => [
    [name, name],
    [jsonKey, name],
  ]),
);
const emptyEvidence =
  /^(?:n\/?a|none|tbd|todo|ok|done|passed|reviewed|fixed|verified|intentional|false[- ]positive|deferred)[.!]?$/i;

function checkerNamed(value: unknown): string | undefined {
  return typeof value === 'string' ? checkerNames.get(value) : undefined;
}

function isStatus(value: unknown): value is string {
  return statuses.some((status) => status === value);
}

function readJson(file: string): unknown {
  const bytes = fs.readFileSync(file);
  const utf16 = bytes[0] === 0xff && bytes[1] === 0xfe;
  try {
    return JSON.parse(bytes.toString(utf16 ? 'utf16le' : 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    throw new Error(`Invalid JSON in ${file}.`);
  }
}

function requireArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(label + ' must be an array.');
  return value;
}

function identity(finding: unknown, defaultChecker?: string): FindingIdentity | undefined {
  if (!isRecord(finding)) return;
  const checker = checkerNamed('checker' in finding ? finding.checker : defaultChecker);
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

function reviewLocation(finding: JsonRecord): Omit<ExpectedFinding, keyof FindingIdentity> {
  const location: Omit<ExpectedFinding, keyof FindingIdentity> = {};
  const { ruleId, file, line, column } = finding;
  if (typeof ruleId === 'string') location.ruleId = ruleId;
  if (typeof file === 'string') location.file = file;
  if (typeof line === 'number' && Number.isSafeInteger(line) && line > 0) location.line = line;
  if (typeof column === 'number' && Number.isSafeInteger(column) && column > 0) location.column = column;
  return location;
}

function recordFindings(rows: unknown, source: string, state: VerifyState, checker?: string): unknown[] {
  const checked = requireArray(rows, source);
  for (const row of checked) {
    const item = identity(row, checker);
    if (!item || !isRecord(row)) throw new Error(source + ' contains a finding without a valid checker and id.');
    const key = JSON.stringify(item);
    state.expected.set(key, { ...state.expected.get(key), ...item, ...reviewLocation(row) });
  }
  return checked;
}

function recordFixRun(run: unknown, source: string, state: VerifyState): void {
  const fields: JsonRecord = isRecord(run) ? run : {};
  for (const field of ['applied', 'manual', 'pendingReview'])
    recordFindings(fields[field], source + '.' + field, state);
  if ('alreadyApplied' in fields) recordFindings(fields.alreadyApplied, source + '.alreadyApplied', state);
  if ('failed' in fields) {
    for (const finding of recordFindings(fields.failed, source + '.failed', state)) {
      state.failedApplications.push({
        ...identity(finding),
        source,
        reason: isRecord(finding) ? finding.reason : undefined,
      });
    }
  }
}

function recordHistory(report: JsonRecord, source: string, state: VerifyState): void {
  const { enabled } = report;
  if (typeof enabled !== 'boolean') throw new Error(source + '.enabled must be a boolean.');
  const runs = requireArray(report.runs, source + '.runs');
  const reviews = requireArray(report.reviews === undefined ? [] : report.reviews, source + '.reviews');
  if (!enabled && (runs.length || reviews.length))
    throw new Error(source + ' contains records despite history being disabled.');
  state.history.push({ source, enabled, runs: runs.length, reviews: reviews.length });
  runs.forEach((run: unknown, index: number) => recordFixRun(run, `${source}.runs[${index}]`, state));
  // Past decisions are evidence to inspect. They do not count as current outcomes.
  recordFindings(reviews, source + '.reviews', state);
}

function declaredChecker(finding: unknown): unknown {
  return isRecord(finding) ? finding.checker : undefined;
}

function recordStandaloneScan(report: JsonRecord, source: string, state: VerifyState, selectedChecker?: string): void {
  const findings = requireArray(report.findings, source + '.findings');
  let checker: string | undefined = selectedChecker;
  if ('checker' in report) {
    checker = checkerNamed(report.checker);
    if (!checker || (selectedChecker && checker !== selectedChecker))
      throw new Error(source + ' declares an unknown checker or disagrees with --checker.');
  }
  if (!checker) {
    checker = checkerNamed(declaredChecker(findings[0]));
    if (!checker || findings.some((finding: unknown) => checkerNamed(declaredChecker(finding)) === undefined))
      throw new Error(source + ' needs --checker perf|maint|sec for an unlabelled standalone scan.');
  }
  recordFindings(findings, source + '.findings', state, checker);
}

function recordReport(report: unknown, source: string, state: VerifyState, selectedChecker?: string): void {
  if (!isRecord(report)) throw new Error(source + ' must be a report object.');
  const isHistory = 'runs' in report || 'enabled' in report;
  const isFix = 'applied' in report || 'manual' in report || 'pendingReview' in report;
  const isScan = Object.keys(report).some((name) => checkerNames.has(name));
  const isStandalone = 'findings' in report;
  if ([isHistory, isFix, isScan, isStandalone].filter(Boolean).length !== 1)
    throw new Error(source + ' must contain one scan, fix or history report.');
  if (isStandalone) {
    recordStandaloneScan(report, source, state, selectedChecker);
    return;
  }
  if (isHistory) {
    recordHistory(report, source, state);
    return;
  }
  if (isFix) {
    recordFixRun(report, source, state);
    return;
  }
  for (const [name, result] of Object.entries(report)) {
    const checker = checkerNamed(name);
    if (!checker) throw new Error(source + ' has an unrecognized checker: ' + name);
    if (result === null) state.unavailable.push({ source, checker });
    else
      recordFindings(isRecord(result) ? result.findings : undefined, source + '.' + name + '.findings', state, checker);
  }
}

function hasEvidence(value: unknown): boolean {
  return typeof value === 'string' && /[\p{L}\p{N}]/u.test(value) && !emptyEvidence.test(value.trim());
}

function reviewCoverage(state: VerifyState, outcomes: readonly unknown[]): CoverageResult {
  const byFinding = new Map<string, JsonRecord[]>();
  const invalid: InvalidOutcome[] = [];
  const unexpected: FindingIdentity[] = [];
  for (const [index, outcome] of outcomes.entries()) {
    const item = identity(outcome);
    if (!item || !isRecord(outcome)) {
      invalid.push({ index, reason: 'Expected a recognized checker and a nonempty id.' });
      continue;
    }
    const key = JSON.stringify(item);
    if (!byFinding.has(key)) byFinding.set(key, []);
    byFinding.get(key)?.push(outcome);
    if (!state.expected.has(key)) unexpected.push(item);
    if (!isStatus(outcome.status) || !hasEvidence(outcome.evidence)) {
      invalid.push({ index, ...item, reason: 'Use a documented status and specific evidence.' });
    }
  }
  const missing: ExpectedFinding[] = [];
  const duplicates: CoverageResult['duplicates'] = [];
  const counts = Object.fromEntries(statuses.map((status) => [status, 0]));
  for (const [key, rows] of byFinding) {
    const [first] = rows;
    if (rows.length > 1) duplicates.push({ ...identity(first), count: rows.length });
    else if (state.expected.has(key) && isStatus(first.status) && hasEvidence(first.evidence)) counts[first.status]++;
  }
  for (const [key, item] of state.expected) if (!byFinding.has(key)) missing.push(item);
  const complete = [state.unavailable, missing, duplicates, unexpected, invalid].every(
    (issues: readonly unknown[]) => !issues.length,
  );
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

function decisionFor(state: VerifyState, outcome: unknown): ReviewOutcome {
  const expected = state.expected.get(JSON.stringify(identity(outcome)));
  if (!expected || !isRecord(outcome)) throw new Error('Cannot save an outcome that matches no expected finding.');
  return { ...expected, status: String(outcome.status), evidence: String(outcome.evidence).trim() };
}

function runAgentVerify(args: string[]): number {
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
  const selectedChecker = checkerNamed(values.checker?.[0]);
  if (values.checker && (!selectedChecker || values.checker.length !== 1))
    throw new Error('Pass one checker name to --checker: perf, maint or sec.');
  const outcomesDocument = readJson(values.outcomes);
  const outcomes = requireArray(
    isRecord(outcomesDocument) ? outcomesDocument.outcomes : undefined,
    values.outcomes + '.outcomes',
  );
  const state: VerifyState = { expected: new Map(), unavailable: [], failedApplications: [], history: [] };
  for (const report of positionals) recordReport(readJson(report), report, state, selectedChecker);
  const result = reviewCoverage(state, outcomes);
  if (values.save && result.complete) {
    const decisions = outcomes.map((outcome: unknown) => decisionFor(state, outcome));
    result.saved = saveReviewOutcomes(process.cwd(), decisions);
  }
  console.log(JSON.stringify(result, null, 2));
  return result.complete ? 0 : 1;
}

export { runAgentVerify };
