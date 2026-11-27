// Changed-lines mode finds the source lines a commit or branch touched.
// It only needs git, so a run with nothing changed returns before TypeScript is loaded.
import { spawnSync } from 'node:child_process';
import { nonJsLanguages } from '../../polyglot/maintainability/rules.js';
import { unquoteGitPath } from '../shared/git-paths.js';
import type { Finding } from '../shared/types.js';
import type { ChangedRanges, ChangeSelection, LineRange } from './types/changed-lines.js';

const sourceExtensions = ['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.mts', '.cts', ...Object.keys(nonJsLanguages)];
const sourcePathspecs = sourceExtensions.map((extension) => `:(icase)*${extension}`);
const declarationFile = /\.d\.[cm]?ts$/i;
const hunkHeader = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;
const wholeFile: LineRange[] = [[1, Infinity]];
// A file-level finding has no line of its own, so any change to the file counts.
const fileLevelRules = new Set(['file-placement']);
const maximumDiffBytes = 256 * 1024 * 1024;
const gitTimeoutMs = 60_000;

function runGit(root: string, args: readonly string[]): string {
  const result = spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: maximumDiffBytes,
    timeout: gitTimeoutMs,
  });
  if (result.error) {
    if ('code' in result.error && result.error.code === 'ENOENT')
      throw new Error('git is required for --staged and --changed-since.');
    throw new Error('git diff failed: ' + result.error.message);
  }
  if (result.status !== 0) throw new Error('git diff failed: ' + (result.stderr.trim() || 'exit ' + result.status));
  return result.stdout;
}

// Diff headers end a file's name with a tab when it contains spaces; a quoted name holds no raw
// tab.
function newSidePath(headerLine: string): string | undefined {
  const name = unquoteGitPath(headerLine.slice('+++ '.length).replace(/\t.*$/, ''));
  return name === '/dev/null' ? undefined : name.replace(/^b\//, '');
}

// Reads `git diff -U0` text into a map of file -> [start, end] line ranges on the new side. A hunk
// body can hold a line that looks like a `--- ` header, so headers are only read before the first
// hunk.
function parseChangedRanges(diffText: string): ChangedRanges {
  const changes: ChangedRanges = new Map();
  let inHeader = false;
  let addedFile = false;
  let currentFile: string | undefined;
  for (const line of diffText.split('\n')) {
    if (line.startsWith('diff --git ')) {
      inHeader = true;
      addedFile = false;
      currentFile = undefined;
    } else if (inHeader && line === '--- /dev/null') {
      addedFile = true;
    } else if (inHeader && line.startsWith('+++ ')) {
      currentFile = newSidePath(line);
      if (currentFile && addedFile) changes.set(currentFile, wholeFile);
    } else if (line.startsWith('@@')) {
      inHeader = false;
      const match = hunkHeader.exec(line);
      if (!match || !currentFile || addedFile) continue;
      const start = Number(match[1]);
      const count = match[2] === undefined ? 1 : Number(match[2]);
      // A zero-length hunk only deleted lines; nothing on the new side changed.
      if (count === 0) continue;
      const range: LineRange = [start, start + count - 1];
      const list = changes.get(currentFile);
      if (list) list.push(range);
      else changes.set(currentFile, [range]);
    }
  }
  return changes;
}

// Returns a map of project-relative source file -> changed line ranges. `since` is a git ref,
// `staged` the index.
function readChangedRanges(root: string, { staged, since }: ChangeSelection): ChangedRanges {
  if (since?.startsWith('-')) throw new Error('--changed-since needs a git ref, not an option.');
  const target = staged ? ['--cached'] : since === undefined ? [] : [since];
  const diffText = runGit(root, [
    '-c',
    'core.quotepath=false',
    'diff',
    '-U0',
    '--no-color',
    '--no-ext-diff',
    '--diff-filter=ACMR',
    '--relative',
    ...target,
    '--',
    ...sourcePathspecs,
  ]);
  const changes = parseChangedRanges(diffText);
  if (!staged) {
    const untracked = runGit(root, ['ls-files', '--others', '--exclude-standard', '-z', '--', ...sourcePathspecs]);
    for (const file of untracked.split('\0')) if (file) changes.set(file, wholeFile);
  }
  for (const file of changes.keys()) if (declarationFile.test(file)) changes.delete(file);
  return changes;
}

function overlaps(ranges: readonly LineRange[], firstLine: number, lastLine: number): boolean {
  return ranges.some(([start, end]) => firstLine <= end && lastLine >= start);
}

// A function-level finding covers its whole function, so an edit anywhere inside it keeps the
// finding.
function findingLines(finding: Finding): [number, number] {
  const { line, rangeStartLine, rangeEndLine } = finding;
  const start = typeof rangeStartLine === 'number' ? rangeStartLine : undefined;
  const end = typeof rangeEndLine === 'number' ? rangeEndLine : undefined;
  const fallback = typeof line === 'number' ? line : (start ?? end ?? 0);
  const firstLine = Math.min(fallback, start ?? fallback);
  const lastLine = Math.max(fallback, end ?? fallback);
  return [firstLine, lastLine];
}

function filterToChangedLines(findings: Finding[], changes: ReadonlyMap<string, readonly LineRange[]>): Finding[] {
  return findings.filter((finding: Finding) => {
    const ranges = finding.file === undefined ? undefined : changes.get(finding.file);
    if (!ranges) return false;
    if (fileLevelRules.has(finding.ruleId)) return true;
    return overlaps(ranges, ...findingLines(finding));
  });
}

export { readChangedRanges, parseChangedRanges, filterToChangedLines };
