// `--staged` and `--changed-since <ref>`: report only findings on lines a commit or branch changed.
// This module reads git output only; it never loads TypeScript, so an empty change set exits before
// the compiler loads.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { isSourceInput } from './source-inputs.js';
import { unquoteGitPath } from '../shared/git-paths.js';
import type { Finding } from '../shared/types.js';

const gitOutputLimit = 256 * 1024 * 1024;
const sourceSuffixes = ['ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs', 'prisma'];
const sourcePathspecs = sourceSuffixes.map((suffix) => `*.${suffix}`);
const addedFileHeader = /^\+\+\+ ([^\t]+)(?:\t.*)?$/;
const hunkHeader = /^@@ -\S+ \+(\d+)(?:,(\d+))? @@/;
/** A new-side line range of a changed file, both ends included. */
type ChangedRange = [start: number, end: number];
type ChangedLines = Map<string, ChangedRange[]>;

interface ChangeOptions {
  staged?: boolean;
  ref?: string;
  allFiles?: boolean;
}

type DiffRequest = { staged: true; allFiles: boolean } | { staged: false; ref: string; allFiles: boolean };

function runGit(args: readonly string[], cwd: string): string {
  return execFileSync('git', [...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: gitOutputLimit,
  });
}

// Files are compared by resolved path; Windows paths differ only by case between git and the
// compiler.
function fileKey(filename: string): string {
  const resolved = path.resolve(filename);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

// Maps each changed file to its new-side line ranges. Deleted lines (a zero-length hunk) change
// nothing to report.
function parseChangedLines(diffText: string, directory: string): ChangedLines {
  const rangesByFile: ChangedLines = new Map();
  let ranges: ChangedRange[] | undefined;
  for (const line of diffText.split(/\r?\n/)) {
    const header = addedFileHeader.exec(line);
    const newPath = header && unquoteGitPath(header[1] ?? '');
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

function diffArguments(request: DiffRequest): string[] {
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
  if (request.staged) base.push('--cached');
  else base.push('--end-of-options', request.ref);
  return [...base, '--', ...(request.allFiles ? ['.'] : sourcePathspecs)];
}

// An untracked file is entirely new, which `git diff` against a ref does not list.
function untrackedFiles(directory: string, allFiles: boolean): string[] {
  const pathspecs = allFiles ? ['.'] : sourcePathspecs;
  const output = runGit(['ls-files', '--others', '--exclude-standard', '-z', '--', ...pathspecs], directory);
  return output.split('\0').filter(Boolean);
}

function validateRef(ref: string | undefined): string {
  if (typeof ref !== 'string' || ref.length === 0 || ref.startsWith('-')) {
    throw new Error('--changed-since needs a git ref such as origin/main; refs starting with "-" are rejected.');
  }
  return ref;
}

// Returns Map<fileKey, [start, end][]> for source files only, or for every file with allFiles (the
// security checker also reads env, Dockerfile and compose files); an untracked file maps to every
// line.
function collectChangedLines(
  { staged = false, ref, allFiles = false }: ChangeOptions = {},
  directory = process.cwd(),
): ChangedLines {
  const request: DiffRequest = staged ? { staged, allFiles } : { staged, ref: validateRef(ref), allFiles };
  let diffText: string;
  try {
    diffText = runGit(diffArguments(request), directory);
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

function collectProjectChangedLines(options: ChangeOptions, project: string | undefined): ChangedLines {
  if (project === undefined) return collectChangedLines(options);
  const target = path.resolve(project);
  const directory = fs.statSync(target, { throwIfNoEntry: false })?.isDirectory() ? target : path.dirname(target);
  // Workspace scans can include shared root files and referenced sibling packages.
  let repository: string | undefined;
  try {
    repository = path.resolve(directory, runGit(['rev-parse', '--show-cdup'], directory).trim());
  } catch {
    // The diff reader supplies the CLI's contextual Git error.
  }
  return collectChangedLines(options, repository || directory);
}

function gitFailure(error: unknown): string {
  if (!(error instanceof Error)) return String(error).trim() || 'not a git repository?';
  if ('code' in error && error.code === 'ENOENT') return 'git must be on PATH.';
  const stderr = 'stderr' in error ? error.stderr : undefined;
  return String(stderr ?? error.message).trim() || 'not a git repository?';
}

function overlapsChangedRange(ranges: readonly ChangedRange[], firstLine: number, lastLine: number): boolean {
  return ranges.some(([start, end]) => firstLine <= end && lastLine >= start);
}

// A finding is changed when its line range, or just its line, overlaps a changed range of its file.
function keepChangedFindings(findings: Finding[], changedLines: ChangedLines, directory = process.cwd()): Finding[] {
  return findings.filter((finding: Finding) => {
    if (finding.file === undefined || finding.line === undefined) return false;
    const ranges = changedLines.get(fileKey(path.resolve(directory, finding.file)));
    const lastLine = typeof finding.endLine === 'number' ? finding.endLine : finding.line;
    return ranges !== undefined && overlapsChangedRange(ranges, finding.line, lastLine);
  });
}

export type { ChangedLines };
export { collectChangedLines, collectProjectChangedLines, fileKey, keepChangedFindings, parseChangedLines };
