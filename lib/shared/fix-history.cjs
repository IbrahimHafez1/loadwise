'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { isAgentSession } = require('./agent-session.cjs');

const runFile = /^\d{13}-\d{20}-[0-9a-f-]{36}\.json$/;
const reviewFile = /^\d{13}-\d{20}-[0-9a-f-]{36}\.review\.json$/;
const outcomes = ['applied', 'manual', 'pendingReview', 'alreadyApplied', 'failed'];

function stateHome() {
  const home = os.homedir();
  const windows = process.platform === 'win32';
  const configured = windows ? process.env.LOCALAPPDATA : process.env.XDG_STATE_HOME;
  if (configured && path.isAbsolute(configured)) return configured;
  return windows ? path.join(home, 'AppData', 'Local') : path.join(home, '.local', 'state');
}

function within(root, target) {
  const relative = path.relative(root, target);
  return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

function privateEntry(file, stat) {
  if (stat.isSymbolicLink() || (process.getuid && (stat.uid !== process.getuid() || stat.mode & 0o077))) {
    throw new Error('Expected a private, user-owned Loadwise history path: ' + file);
  }
}

function storage(project, create, suffix = '') {
  const root = fs.realpathSync.native(require('./agent-init.cjs').findProjectRoot(project));
  const parts = ['loadwise', 'review-history', createHash('sha256').update(root).digest('hex') + suffix];
  const base = stateHome();
  const destination = path.join(base, ...parts);
  if (within(root, destination)) throw new Error('Loadwise review history must be outside the project.');
  if (create) fs.mkdirSync(base, { recursive: true, mode: 0o700 });
  const baseStat = fs.lstatSync(base, { throwIfNoEntry: false });
  if (!baseStat) return;
  if (!baseStat.isDirectory() || (process.getuid && (baseStat.uid !== process.getuid() || baseStat.mode & 0o022))) {
    throw new Error('Expected a user-owned local state directory: ' + base);
  }
  let directory = fs.realpathSync.native(base);
  if (within(root, path.join(directory, ...parts)))
    throw new Error('Loadwise review history must be outside the project.');
  for (const part of parts) {
    directory = path.join(directory, part);
    if (create) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(directory, { throwIfNoEntry: false });
    if (!stat) return;
    privateEntry(directory, stat);
    if (!stat.isDirectory()) throw new Error('Expected a review history directory: ' + directory);
  }
  return { root, directory };
}

function enableHistory(project) {
  return storage(project, true).directory;
}

// An inbox shares the checkout's private storage rules but does not opt the user into fix history.
function pendingReviewStorage(directory, create) {
  return storage(fs.realpathSync.native(directory), create, '.pending');
}

// The original directory means the user explicitly enabled recording for manual CLI fixes.
const agentOnlySuffix = '.agent';

function readableHistory(project) {
  return [storage(project, false), storage(project, false, agentOnlySuffix)].filter(Boolean);
}

function sourceHistoryProject(directory, files) {
  if (!files.length) return directory;
  const { findProjectRoot } = require('./agent-init.cjs');
  const roots = [...new Set(files.map((file) => findProjectRoot(path.dirname(path.resolve(file)))))];
  if (roots.length === 1) return roots[0];
  if (isAgentSession() || roots.some((root) => historyForFix(root))) {
    console.error(
      'Review history cannot record fixes spanning separate projects. Run each project separately to record its edits.',
    );
  }
  return null;
}

function historyForFix(project) {
  if (project === null) return;
  try {
    return storage(project, false) ?? (isAgentSession() ? storage(project, true, agentOnlySuffix) : undefined);
  } catch (error) {
    console.error('Loadwise review history unavailable: ' + error.message);
  }
}

// Receipts contain the finding and its edited lines. Examples and unrelated source file contents stay out.
function receiptFinding(finding, checker, changes) {
  const { id, ruleId, file, line, column, message, related, fix } = finding;
  return {
    id,
    checker: finding.checker ?? checker,
    ruleId,
    file,
    line,
    column,
    message,
    related,
    ...(fix && { fix: { note: fix.note, requiresReview: fix.requiresReview, changes: changes ?? fix.changes } }),
  };
}

function writeRecord(directory, filenameSuffix, data) {
  const timestamp = new Date();
  // Same-millisecond decisions must replay in the order they were written.
  const sequence = process.hrtime.bigint().toString().padStart(20, '0');
  const prefix = path.join(directory, [timestamp.getTime(), sequence, randomUUID()].join('-'));
  const temporary = prefix + '.tmp';
  const fd = fs.openSync(temporary, 'wx', 0o600);
  try {
    try {
      fs.writeFileSync(fd, JSON.stringify({ at: timestamp.toISOString(), ...data }));
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temporary, prefix + filenameSuffix);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function writeReceipt(history, directory, groups) {
  if (!history || !groups.applied.length) return;
  try {
    const { realTarget } = require('./real-target.cjs');
    const inProject = (change) => within(history.root, realTarget(path.resolve(directory, change.file)));
    if (!groups.applied.every((finding) => finding.fix.changes.every(inProject))) {
      throw new Error('an edited file lies outside the initialized project');
    }
    for (const finding of groups.pendingReview) finding.fix.changes = finding.fix.changes.filter(inProject);
    writeRecord(history.directory, '.json', { directory: path.resolve(directory), ...groups });
  } catch (error) {
    console.error('Fixes were applied, but Loadwise could not save their review history: ' + error.message);
  }
}

function recordBulk(directory, result) {
  const history = historyForFix(directory);
  if (!history) return;
  const pack = (findings) => findings.map((finding) => receiptFinding(finding));
  writeReceipt(history, directory, {
    applied: pack(result.applied),
    manual: pack(result.manual),
    pendingReview: pack(result.pendingReview),
    alreadyApplied: [],
    failed: [],
  });
}

function checkerHistory(project, directory, checker) {
  const history = historyForFix(project);
  if (!history) return;
  const applied = [];
  let pending;
  return {
    begin() {
      pending = [];
      return (change) => pending.push(change);
    },
    accept(finding) {
      applied.push(receiptFinding(finding, checker, pending));
    },
    finish(alreadyApplied, failed, findings = []) {
      if (!applied.length) return;
      const tagged = (items) => items.map((item) => ({ ...(typeof item === 'string' ? { id: item } : item), checker }));
      const groups = {
        applied,
        manual: [],
        pendingReview: [],
        alreadyApplied: tagged(alreadyApplied),
        failed: tagged(failed),
      };
      const handled = new Set([...applied, ...groups.alreadyApplied, ...groups.failed].map(({ id }) => id));
      for (const finding of findings) {
        if (handled.has(finding.id)) continue;
        const remaining = finding.fix ? groups.pendingReview : groups.manual;
        remaining.push(receiptFinding(finding, checker));
      }
      writeReceipt(history, directory, groups);
    },
  };
}

function readReceipt(directory, name) {
  const file = path.join(directory, name);
  const stat = fs.lstatSync(file);
  privateEntry(file, stat);
  if (!stat.isFile() || stat.nlink !== 1) throw new Error('Invalid Loadwise history file: ' + file);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fs.fstatSync(fd);
    if (stat.dev !== opened.dev || stat.ino !== opened.ino)
      throw new Error('Review history changed while opening: ' + file);
    return JSON.parse(fs.readFileSync(fd, 'utf8'));
  } finally {
    fs.closeSync(fd);
  }
}

function selectOutcomes(run, selected) {
  if (!selected.size) return run;
  for (const key of outcomes) run[key] = (run[key] ?? []).filter((finding) => selected.has(finding.checker));
  if (outcomes.some((key) => run[key].length)) return run;
}

function reviewKey(outcome) {
  return outcome.checker + '/' + outcome.id;
}

function* records(histories, pattern) {
  const files = histories.flatMap(({ directory }) =>
    fs
      .readdirSync(directory)
      .filter((name) => pattern.test(name))
      .map((name) => ({ directory, name })),
  );
  for (const { directory, name } of files.sort((first, second) => first.name.localeCompare(second.name))) {
    yield readReceipt(directory, name);
  }
}

function latestReviews(histories) {
  const entries = new Map();
  for (const record of records(histories, reviewFile)) {
    for (const outcome of record.outcomes) entries.set(reviewKey(outcome), outcome);
  }
  return entries;
}

function saveReviewOutcomes(project, outcomes) {
  const histories = readableHistory(project);
  const history = histories[0] ?? (isAgentSession() ? storage(project, true, agentOnlySuffix) : undefined);
  if (!history) throw new Error('Initialize local review history with loadwise agent init before saving outcomes.');
  const previous = latestReviews(histories);
  const changed = [];
  for (const { id, checker, ruleId, file, line, column, status, evidence } of outcomes) {
    const outcome = { id, checker, ruleId, file, line, column, status, evidence };
    if (JSON.stringify(previous.get(reviewKey(outcome))) !== JSON.stringify(outcome)) changed.push(outcome);
  }
  if (changed.length) writeRecord(history.directory, '.review.json', { outcomes: changed });
  return changed.length;
}

function historyReport(project, args) {
  const { pillars } = require('./pillars.cjs');
  const selected = new Set(
    args
      .flatMap((arg) => arg.split(','))
      .map((name) => {
        const pillar = pillars.find((candidate) => candidate.name === name || candidate.jsonKey === name);
        if (!pillar) throw new Error('Unknown checker in agent history: ' + name);
        return pillar.name;
      }),
  );
  const histories = readableHistory(project);
  const runs = [];
  for (const record of records(histories, runFile)) {
    const run = selectOutcomes(record, selected);
    if (run) runs.push(run);
  }
  const reviews = [...latestReviews(histories).values()].filter(
    (outcome) => !selected.size || selected.has(outcome.checker),
  );
  return { enabled: histories.length > 0 || isAgentSession(), runs, reviews };
}

module.exports = {
  enableHistory,
  recordBulk,
  checkerHistory,
  historyReport,
  saveReviewOutcomes,
  sourceHistoryProject,
  pendingReviewStorage,
};
