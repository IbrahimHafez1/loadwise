'use strict';

// Decides which migration files are enforced ("only new migrations fail") and which findings are contextual.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const BASELINE_VERSION = 1;
const DEFAULT_BASELINE_NAME = 'backend-perf.migrations-baseline.json';
const SQL_DIRECTIVE = /^[\t ]*--[\t ]+backend-perf-reviewed[\t ]+([a-z][a-z0-9-]*)[\t ]+--[\t ]+(\S[^\r\n]*?)[\t ]*$/;
const CODE_DIRECTIVE =
  /^[\t ]*(?:\/\/|--)[\t ]+backend-perf-reviewed[\t ]+([a-z][a-z0-9-]*)[\t ]+--[\t ]+(\S[^\r\n]*?)[\t ]*$/;
const BASELINE_REASON = 'Migration predates the baseline.';

// Line endings and a byte order mark do not change a migration, so a Windows checkout matches CI.
function hashMigration(text) {
  const normalized = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  return crypto.createHash('sha256').update(normalized, 'utf8').digest('hex');
}

function baselineKey(baselineFile, migrationPath) {
  return path
    .relative(path.dirname(path.resolve(baselineFile)), migrationPath)
    .split(path.sep)
    .join('/');
}

function readBaseline(baselineFile) {
  let raw;
  try {
    raw = fs.readFileSync(baselineFile, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw.replace(/^\uFEFF/, ''));
  } catch {
    throw new Error('Migration baseline file contains invalid JSON: ' + baselineFile);
  }
  const validFiles =
    parsed?.files &&
    typeof parsed.files === 'object' &&
    Object.values(parsed.files).every((hash) => typeof hash === 'string');
  if (parsed?.version !== BASELINE_VERSION || !validFiles) {
    throw new Error(
      `Migration baseline must be { "version": ${BASELINE_VERSION}, "files": { path: sha256 } }: ${baselineFile}`,
    );
  }
  return parsed;
}

// migrations: [{ path, text }]
function writeBaseline(baselineFile, migrations) {
  const entries = migrations
    .map(({ path: migrationPath, text }) => [baselineKey(baselineFile, migrationPath), hashMigration(text)])
    .sort(([left], [right]) => left.localeCompare(right, 'en', { numeric: true }));
  const document = { version: BASELINE_VERSION, files: Object.fromEntries(entries) };
  fs.writeFileSync(baselineFile, JSON.stringify(document, null, 2) + '\n');
  return entries.length;
}

// A file listed in the baseline with an unchanged hash is not enforced; an edited old migration re-enters.
function baselinePolicy(baselineFile, baseline) {
  return {
    reason: BASELINE_REASON,
    isEnforced: ({ path: migrationPath, text }) =>
      baseline.files[baselineKey(baselineFile, migrationPath)] !== hashMigration(text),
  };
}

function enforceAllPolicy() {
  return { reason: null, isEnforced: () => true };
}

// The comment must be on its own line immediately before the finding line and name the exact rule.
function reviewedReason(lines, finding, isSqlFile) {
  const previous = lines[finding.line - 2];
  if (previous === undefined) return null;
  const match = (isSqlFile ? SQL_DIRECTIVE : CODE_DIRECTIVE).exec(previous);
  return match && match[1] === finding.ruleId ? 'Reviewed in source: ' + match[2] : null;
}

function applyReviewComments(findings, text, isSqlFile) {
  const lines = text.split(/\r?\n/);
  for (const finding of findings) {
    if (finding.contextualReason) continue;
    const reason = reviewedReason(lines, finding, isSqlFile);
    if (reason) finding.contextualReason = reason;
  }
  return findings;
}

module.exports = {
  BASELINE_REASON,
  DEFAULT_BASELINE_NAME,
  applyReviewComments,
  baselinePolicy,
  enforceAllPolicy,
  hashMigration,
  readBaseline,
  writeBaseline,
};
