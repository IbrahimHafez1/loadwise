'use strict';

// Lists the files of a project for the file checks: tracked files when it is in a git repository, so ignored .env
// files are never read, otherwise a directory walk that never opens .env files.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const skippedDirectories = new Set([
  '.git',
  '.next',
  '.nuxt',
  '.turbo',
  '.venv',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'target',
  'vendor',
]);
const gitListBuffer = 1 << 28;

function git(directory, args) {
  return spawnSync('git', ['-C', directory, ...args], {
    encoding: 'utf8',
    maxBuffer: gitListBuffer,
    windowsHide: true,
  });
}

function splitNames(directory, run) {
  return run.stdout
    .split('\0')
    .filter(Boolean)
    .map((name) => path.resolve(directory, name));
}

// Paths are listed relative to `directory`, so they stay in the spelling the caller used for it.
function trackedFiles(directory, pathspec) {
  const run = git(directory, ['ls-files', '-z', '--cached', '--', pathspec]);
  return run.status === 0 ? splitNames(directory, run) : undefined;
}

// The git top-level when it is a different folder than `root`, spelled relative to `root`.
function enclosingTopLevel(root) {
  const run = git(root, ['rev-parse', '--show-cdup']);
  const upward = run.status === 0 ? run.stdout.trim() : '';
  return upward ? path.resolve(root, upward) : undefined;
}

function walk(directory, files, isIgnored) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (isIgnored?.(absolute)) continue;
    if (entry.isDirectory()) {
      if (!skippedDirectories.has(entry.name)) walk(absolute, files, isIgnored);
    } else if (entry.isFile() && !isEnvFileName(entry.name)) files.push(absolute);
  }
  return files;
}

function isEnvFileName(name) {
  return /^\.env(?:\..+)?$/i.test(name);
}

function isSkippedPath(root, absolute) {
  return path
    .relative(root, absolute)
    .split(path.sep)
    .some((segment) => skippedDirectories.has(segment));
}

// { files, tracked, topLevelFiles }: files are absolute; tracked says whether they come from git; topLevelFiles are
// the files directly in the git top-level above `root`, which a monorepo keeps its Dockerfile and compose files in.
function listProjectFiles(root, isIgnored) {
  const files = trackedFiles(root, '.');
  if (!files) return { files: walk(root, [], isIgnored), tracked: false, topLevelFiles: [] };
  const top = enclosingTopLevel(root);
  const topLevelFiles = top ? (trackedFiles(top, ':(glob)*') ?? []) : [];
  const exclusions = new Set();
  const selectedFiles = files.filter((file) => {
    if (!isIgnored?.(file)) return !isSkippedPath(root, file);
    // Coalesce ignored siblings when a whole directory is excluded, keeping Git's argument list short.
    let excluded = file;
    while (excluded !== root && isIgnored(path.dirname(excluded))) excluded = path.dirname(excluded);
    exclusions.add(':(exclude,literal)' + path.relative(root, excluded).split(path.sep).join('/'));
    return false;
  });
  return {
    files: selectedFiles,
    tracked: true,
    topLevelFiles: topLevelFiles.filter((file) => !isIgnored?.(file)),
    exclusions,
  };
}

// Tracked text files that contain one of the token formats, found by git's native search (binary files are skipped).
// Undefined outside git.
function searchTrackedText(root, pattern, exclusions = []) {
  const run = git(root, ['grep', '-I', '-l', '-z', '-E', '-e', pattern, '--', '.', ...exclusions]);
  if (run.status === 1) return new Set();
  return run.status === 0 ? new Set(splitNames(root, run)) : undefined;
}

module.exports = { listProjectFiles, searchTrackedText, isEnvFileName, isSkippedPath };
