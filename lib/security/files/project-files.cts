// Lists the files of a project for the file checks: tracked files when it is in a git repository,
// so ignored .env files are never read, otherwise a directory walk that never opens .env files.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { SpawnSyncReturns } from 'node:child_process';
import { isBuildOutputFolder } from '../../shared/build-output.cjs';
import type { PathPredicate, ProjectFiles } from '../types/project-files.cjs';

const skippedDirectories = new Set(['.git', '.next', '.nuxt', '.turbo', '.venv', 'node_modules']);
const gitListBuffer = 1 << 28;

function git(directory: string, args: readonly string[]) {
  return spawnSync('git', ['-C', directory, ...args], {
    encoding: 'utf8',
    maxBuffer: gitListBuffer,
    windowsHide: true,
  });
}

function splitNames(directory: string, run: SpawnSyncReturns<string>) {
  return run.stdout
    .split('\0')
    .filter(Boolean)
    .map((name) => path.resolve(directory, name));
}

// Paths are listed relative to `directory`, so they stay in the spelling the caller used for it.
function trackedFiles(directory: string, pathspec: string) {
  const run = git(directory, ['ls-files', '-z', '--cached', '--', pathspec]);
  return run.status === 0 ? splitNames(directory, run) : undefined;
}

// The git top-level when it is a different folder than `root`, spelled relative to `root`.
function enclosingTopLevel(root: string) {
  const run = git(root, ['rev-parse', '--show-cdup']);
  const upward = run.status === 0 ? run.stdout.trim() : '';
  return upward ? path.resolve(root, upward) : undefined;
}

function isSkippedFolder(root: string, relativeFolder: string) {
  return skippedDirectories.has(path.posix.basename(relativeFolder)) || isBuildOutputFolder(root, relativeFolder);
}

function walk(root: string, directory: string, files: string[], isIgnored?: PathPredicate) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (isIgnored?.(absolute)) continue;
    if (entry.isDirectory()) {
      if (!isSkippedFolder(root, path.relative(root, absolute).split(path.sep).join('/')))
        walk(root, absolute, files, isIgnored);
    } else if (entry.isFile() && !isEnvFileName(entry.name)) files.push(absolute);
  }
  return files;
}

function isEnvFileName(name: string) {
  return /^\.env(?:\..+)?$/i.test(name);
}

// Whether a folder holding the file is skipped; the file's own name is not a folder.
function isSkippedPath(root: string, absolute: string) {
  const segments = path.relative(root, absolute).split(path.sep).slice(0, -1);
  return segments.some((_, index) => isSkippedFolder(root, segments.slice(0, index + 1).join('/')));
}

// { files, tracked, topLevelFiles }: files are absolute; tracked says whether they come from git;
// topLevelFiles are the files directly in the git top-level above `root`, which a monorepo keeps
// its Dockerfile and compose files in.
function listProjectFiles(root: string, isIgnored?: PathPredicate): ProjectFiles {
  const files = trackedFiles(root, '.');
  if (!files) return { files: walk(root, root, [], isIgnored), tracked: false, topLevelFiles: [] };
  const top = enclosingTopLevel(root);
  const topLevelFiles = top ? (trackedFiles(top, ':(glob)*') ?? []) : [];
  const exclusions = new Set<string>();
  const selectedFiles = files.filter((file) => {
    if (!isIgnored?.(file)) return !isSkippedPath(root, file);
    // Coalesce ignored siblings when a whole directory is excluded, keeping Git's argument list
    // short.
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

// Tracked text files that contain one of the token formats, found by git's native search (binary
// files are skipped). Undefined outside git.
function searchTrackedText(root: string, pattern: string, exclusions: Iterable<string> = []) {
  const run = git(root, ['grep', '-I', '-l', '-z', '-E', '-e', pattern, '--', '.', ...exclusions]);
  if (run.status === 1) return new Set<string>();
  return run.status === 0 ? new Set(splitNames(root, run)) : undefined;
}

export { listProjectFiles, searchTrackedText, isEnvFileName, isSkippedPath };
