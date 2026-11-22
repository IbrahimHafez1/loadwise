'use strict';

// `--staged` and `--changed-since <ref>`: report only findings on lines a commit or branch changed.
// This module reads git output only; it never loads TypeScript, so an empty change set exits before the compiler loads.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { isSourceInput } = require('./source-inputs.cjs');
const { unquoteGitPath } = require('../shared/git-paths.cjs');

const gitOutputLimit = 256 * 1024 * 1024;
const sourceSuffixes = ['ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs', 'prisma'];
const sourcePathspecs = sourceSuffixes.map((suffix) => `*.${suffix}`);
const addedFileHeader = /^\+\+\+ ([^\t]+)(?:\t.*)?$/;
const hunkHeader = /^@@ -\S+ \+(\d+)(?:,(\d+))? @@/;
function runGit(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: gitOutputLimit,
  });
}

// Files are compared by resolved path; Windows paths differ only by case between git and the compiler.
function fileKey(filename) {
  const resolved = path.resolve(filename);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

// Maps each changed file to its new-side line ranges. Deleted lines (a zero-length hunk) change nothing to report.
function parseChangedLines(diffText, directory) {
  const rangesByFile = new Map();
  let ranges;
  for (const line of diffText.split(/\r?\n/)) {
    const header = addedFileHeader.exec(line);
    const newPath = header && unquoteGitPath(header[1]);
    if (newPath?.startsWith('b/')) {
      const key = fileKey(path.join(directory, newPath.slice('b/'.length)));
      ranges = rangesByFile.get(key) ?? [];
      rangesByFile.set(key, ranges);
      continue;
    }
    const hunk = hunkHeader.exec(line);
    if (!hunk || !ranges) continue;
    const start = Number(hunk[1]);
    const length = hunk[2] === undefined ? 1 : Number(hunk[2]);
    if (length > 0) ranges.push([start, start + length - 1]);
  }
  return rangesByFile;
}

function diffArguments({ staged, ref, allFiles }) {
  const base = [
    '-c',
    'core.quotePath=false',
    'diff',
    '-U0',
    '--no-color',
    '--src-prefix=a/',
    '--dst-prefix=b/',
    '--diff-filter=ACMR',
    '--relative',
  ];
  if (staged) base.push('--cached');
  else base.push('--end-of-options', ref);
  return [...base, '--', ...(allFiles ? ['.'] : sourcePathspecs)];
}

// An untracked file is entirely new, which `git diff` against a ref does not list.
function untrackedFiles(directory, allFiles) {
  const pathspecs = allFiles ? ['.'] : sourcePathspecs;
  const output = runGit(['ls-files', '--others', '--exclude-standard', '-z', '--', ...pathspecs], directory);
  return output.split('\0').filter(Boolean);
}

function validateRef(ref) {
  if (typeof ref !== 'string' || ref.length === 0 || ref.startsWith('-')) {
    throw new Error('--changed-since needs a git ref such as origin/main; refs starting with "-" are rejected.');
  }
}

// Returns Map<fileKey, [start, end][]> for source files only, or for every file with allFiles (the security checker
// also reads env, Dockerfile and compose files); an untracked file maps to every line.
function collectChangedLines({ staged = false, ref, allFiles = false } = {}, directory = process.cwd()) {
  if (!staged) validateRef(ref);
  let diffText;
  try {
    diffText = runGit(diffArguments({ staged, ref, allFiles }), directory);
  } catch (error) {
    throw new Error(`${staged ? '--staged' : '--changed-since'} could not read git changes: ${gitFailure(error)}`);
  }
  const changed = parseChangedLines(diffText, directory);
  if (!staged) {
    for (const file of untrackedFiles(directory, allFiles))
      changed.set(fileKey(path.join(directory, file)), [[1, Infinity]]);
  }
  if (!allFiles)
    for (const key of changed.keys()) if (!isSourceInput(key) && !key.endsWith('.prisma')) changed.delete(key);
  return changed;
}

function collectProjectChangedLines(options, project) {
  if (project === undefined) return collectChangedLines(options);
  const target = path.resolve(project);
  const directory = fs.statSync(target, { throwIfNoEntry: false })?.isDirectory() ? target : path.dirname(target);
  // Workspace scans can include shared root files and referenced sibling packages.
  let repository;
  try {
    repository = path.resolve(directory, runGit(['rev-parse', '--show-cdup'], directory).trim());
  } catch {
    // The diff reader supplies the CLI's contextual Git error.
  }
  return collectChangedLines(options, repository || directory);
}

function gitFailure(error) {
  if (error.code === 'ENOENT') return 'git must be on PATH.';
  return String(error.stderr ?? error.message).trim() || 'not a git repository?';
}

function overlapsChangedRange(ranges, firstLine, lastLine) {
  return ranges.some(([start, end]) => firstLine <= end && lastLine >= start);
}

// A finding is changed when its line range, or just its line, overlaps a changed range of its file.
function keepChangedFindings(findings, changedLines, directory = process.cwd()) {
  return findings.filter((finding) => {
    const ranges = changedLines.get(fileKey(path.resolve(directory, finding.file)));
    return ranges !== undefined && overlapsChangedRange(ranges, finding.line, finding.endLine ?? finding.line);
  });
}

module.exports = {
  collectChangedLines,
  collectProjectChangedLines,
  fileKey,
  keepChangedFindings,
  parseChangedLines,
};
