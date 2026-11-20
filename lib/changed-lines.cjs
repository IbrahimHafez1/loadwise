'use strict';

// Changed-lines mode: finds the JS/TS lines a commit or branch touched, so a report can be limited to new findings.
// It only needs git, so a run with nothing changed returns before TypeScript is loaded.
const { spawnSync } = require('node:child_process');

const sourcePathspecs = ['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'mts', 'cts'].map((suffix) => `*.${suffix}`);
const declarationFile = /\.d\.[cm]?ts$/i;
const hunkHeader = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;
const wholeFile = [[1, Infinity]];
// A file-level finding has no line of its own, so any change to the file counts.
const fileLevelRules = new Set(['file-placement']);
const maximumDiffBytes = 256 * 1024 * 1024;

function runGit(root, args) {
  const result = spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: maximumDiffBytes,
  });
  if (result.error?.code === 'ENOENT') throw new Error('git is required for --staged and --changed-since.');
  if (result.status !== 0) throw new Error('git diff failed: ' + (result.stderr.trim() || 'exit ' + result.status));
  return result.stdout;
}

// Diff headers end a file's name with a tab when it contains spaces.
function newSidePath(headerLine) {
  const name = headerLine.slice('+++ '.length).replace(/\t.*$/, '');
  return name === '/dev/null' ? undefined : name.replace(/^b\//, '');
}

// Reads `git diff -U0` text into a map of file -> [start, end] line ranges on the new side.
// A hunk body can hold a line that looks like a `--- ` header, so headers are only read before the first hunk.
function parseChangedRanges(diffText) {
  const changes = new Map();
  let inHeader = false;
  let addedFile = false;
  let currentFile;
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
      if (count > 0) changes.set(currentFile, [...(changes.get(currentFile) ?? []), [start, start + count - 1]]);
    }
  }
  return changes;
}

// Returns a map of project-relative source file -> changed line ranges. `since` is a git ref, `staged` the index.
function readChangedRanges(root, { staged, since }) {
  if (since?.startsWith('-')) throw new Error('--changed-since needs a git ref, not an option.');
  const target = staged ? ['--cached'] : [since];
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
  for (const file of changes.keys()) if (declarationFile.test(file)) changes.delete(file);
  return changes;
}

function overlaps(ranges, firstLine, lastLine) {
  return ranges.some(([start, end]) => firstLine <= end && lastLine >= start);
}

// A function-level finding covers its whole function, so an edit anywhere inside it keeps the finding.
function findingLines(finding) {
  const firstLine = Math.min(finding.line, finding.rangeStartLine ?? finding.line);
  const lastLine = Math.max(finding.line, finding.rangeEndLine ?? finding.line);
  return [firstLine, lastLine];
}

function filterToChangedLines(findings, changes) {
  return findings.filter((finding) => {
    const ranges = changes.get(finding.file);
    if (!ranges) return false;
    if (fileLevelRules.has(finding.ruleId)) return true;
    return overlaps(ranges, ...findingLines(finding));
  });
}

module.exports = { readChangedRanges, parseChangedRanges, filterToChangedLines };
