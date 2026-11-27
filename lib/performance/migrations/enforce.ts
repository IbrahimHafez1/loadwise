// Decides which migration files are enforced ("only new migrations fail") and which findings are
// contextual.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { BaselineDocument, MigrationPolicy, MigrationSource } from '../types/migration-files.js';
import type { MigrationFinding } from '../types/migration-operations.js';

const BASELINE_VERSION = 1;
const DEFAULT_BASELINE_NAME = 'loadwise.migrations-baseline.json';
const GIT_OUTPUT_LIMIT = 64 * 1024 * 1024;
const SQL_DIRECTIVE = /^[\t ]*--[\t ]+loadwise-reviewed[\t ]+([a-z][a-z0-9-]*)[\t ]+--[\t ]+(\S[^\r\n]*?)[\t ]*$/;
const CODE_DIRECTIVE =
  /^[\t ]*(?:\/\/|--)[\t ]+loadwise-reviewed[\t ]+([a-z][a-z0-9-]*)[\t ]+--[\t ]+(\S[^\r\n]*?)[\t ]*$/;
const BASELINE_REASON = 'Migration predates the baseline.';

// Line endings and a byte order mark do not change a migration, so a Windows checkout matches CI.
function hashMigration(text: string) {
  const normalized = text.replace(/^\uFEFF/, '').replaceAll('\r\n', '\n');
  return crypto.createHash('sha256').update(normalized, 'utf8').digest('hex');
}

function baselineKey(baselineFile: string, migrationPath: string) {
  return path
    .relative(path.dirname(path.resolve(baselineFile)), migrationPath)
    .split(path.sep)
    .join('/');
}

function isBaselineDocument(value: unknown): value is BaselineDocument {
  if (typeof value !== 'object' || value === null) return false;
  if (!('version' in value) || value.version !== BASELINE_VERSION) return false;
  return (
    'files' in value &&
    typeof value.files === 'object' &&
    value.files !== null &&
    Object.values(value.files).every((hash) => typeof hash === 'string')
  );
}

function readBaseline(baselineFile: string): BaselineDocument | null {
  let raw: string;
  try {
    raw = fs.readFileSync(baselineFile, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.replace(/^\uFEFF/, ''));
  } catch {
    throw new Error('Migration baseline file contains invalid JSON: ' + baselineFile);
  }
  if (!isBaselineDocument(parsed)) {
    throw new Error(
      `Migration baseline must be { "version": ${BASELINE_VERSION}, "files": { path: sha256 } }: ${baselineFile}`,
    );
  }
  return parsed;
}

// migrations: [{ path, text }]
function writeBaseline(baselineFile: string, migrations: readonly MigrationSource[]) {
  const entries = migrations
    .map(({ path: migrationPath, text }): [string, string] => [
      baselineKey(baselineFile, migrationPath),
      hashMigration(text),
    ])
    .sort(([left], [right]) => left.localeCompare(right, 'en', { numeric: true }));
  const document = { version: BASELINE_VERSION, files: Object.fromEntries(entries) };
  fs.writeFileSync(baselineFile, JSON.stringify(document, null, 2) + '\n');
  return entries.length;
}

// A file listed in the baseline with an unchanged hash is not enforced; an edited old migration
// re-enters.
function baselinePolicy(baselineFile: string, baseline: BaselineDocument): MigrationPolicy {
  return {
    reason: BASELINE_REASON,
    isEnforced: ({ path: migrationPath, text }) =>
      baseline.files[baselineKey(baselineFile, migrationPath)] !== hashMigration(text),
  };
}

function git(args: readonly string[], cwd: string) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: GIT_OUTPUT_LIMIT,
  });
}

// git reports long, real paths; the caller's may be relative, linked or (on Windows) 8.3 short
// names.
function canonicalPath(target: string) {
  let resolved = path.resolve(target);
  try {
    resolved = fs.realpathSync.native(resolved);
  } catch {
    // A deleted file keeps its resolved path.
  }
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function unresolvedRef(ref: string) {
  return new Error(
    `Cannot resolve git ref \`${ref}\` or its merge base with HEAD. In a shallow CI clone, fetch full history ` +
      '(`git fetch --unshallow`, or `fetch-depth: 0` in actions/checkout) and the branch you compare against.',
  );
}

function splitNul(output: string) {
  return output.split('\0').filter(Boolean);
}

// The repository top level and the merge base of `ref` and HEAD, which every --changed-since
// comparison starts from.
function mergeBaseSince(ref: string, cwd: string) {
  if (typeof ref !== 'string' || ref.length === 0 || ref.startsWith('-')) {
    throw new Error('--changed-since needs a git ref such as origin/main; refs starting with "-" are rejected.');
  }
  let top: string;
  try {
    top = git(['rev-parse', '--show-toplevel'], cwd).trim();
  } catch {
    throw new Error('--changed-since needs a git repository, and git must be on PATH.');
  }
  try {
    const resolved = git(['rev-parse', '--verify', '--quiet', '--end-of-options', ref + '^{commit}'], top).trim();
    return { top, base: git(['merge-base', '--end-of-options', resolved, 'HEAD'], top).trim() };
  } catch {
    throw unresolvedRef(ref);
  }
}

// `--name-status -z` entries are `status\0path` or, for a rename or copy, `status\0old\0new`. A
// rename with unchanged content (R100) is not a changed migration; an edited rename and any copy
// are listed by their new path.
function changedPathsFromNameStatus(output: string) {
  const fields = splitNul(output);
  const paths: string[] = [];
  let index = 0;
  while (index < fields.length) {
    const status = fields[index];
    const pathCount = /^[RC]/.test(status) ? 2 : 1;
    if (status !== 'R100') paths.push(fields[index + pathCount]);
    index += pathCount + 1;
  }
  return paths;
}

// Files added, modified, copied or renamed with edits since the merge base of `ref` and HEAD, plus
// untracked files. No shell is involved.
function changedFilesSince(ref: string, cwd: string) {
  const { top, base } = mergeBaseSince(ref, cwd);
  const changed = changedPathsFromNameStatus(
    git(['diff', '--name-status', '-z', '--diff-filter=ACMR', '--end-of-options', base], top),
  );
  const untracked = splitNul(git(['ls-files', '--others', '--exclude-standard', '--full-name', '-z'], top));
  return new Set([...changed, ...untracked].map((file) => canonicalPath(path.join(top, file))));
}

function changedSincePolicy(ref: string, cwd: string): MigrationPolicy {
  const changed = changedFilesSince(ref, cwd);
  return {
    reason: `Migration is unchanged since ${ref}.`,
    isEnforced: ({ path: migrationPath }) => changed.has(canonicalPath(migrationPath)),
  };
}

function enforceAllPolicy(): MigrationPolicy {
  return { reason: null, isEnforced: () => true };
}

// The comment must be on its own line immediately before the finding line and name the exact rule.
function reviewedReason(lines: string[], finding: MigrationFinding, isSqlFile: boolean) {
  const previous = lines[finding.line - 2];
  if (previous === undefined) return null;
  const match = (isSqlFile ? SQL_DIRECTIVE : CODE_DIRECTIVE).exec(previous);
  return match && match[1] === finding.ruleId ? 'Reviewed in source: ' + match[2] : null;
}

function applyReviewComments(findings: MigrationFinding[], text: string, isSqlFile: boolean) {
  const lines = text.split(/\r?\n/);
  for (const finding of findings) {
    if (finding.contextualReason) continue;
    const reason = reviewedReason(lines, finding, isSqlFile);
    if (reason) finding.contextualReason = reason;
  }
  return findings;
}

export {
  BASELINE_REASON,
  DEFAULT_BASELINE_NAME,
  applyReviewComments,
  baselinePolicy,
  changedFilesSince,
  changedSincePolicy,
  enforceAllPolicy,
  git,
  hashMigration,
  mergeBaseSince,
  readBaseline,
  writeBaseline,
};
