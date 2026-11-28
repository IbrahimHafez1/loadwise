// Which files of a workspace folder feed the checkers, and so which changes trigger a rescan.
import fs from 'node:fs/promises';
import path from 'node:path';
import { dismissalsPath } from './dismissals.js';

/** What a changed file means for the folder's scans. */
export type FileChangeKind = 'source' | 'config' | 'dismissals' | 'ignored';

const sourceSuffixes = new Set(
  'js jsx ts tsx mjs mts cjs cts py go java cs rs rb php kt kts c h cc cpp cxx hpp hh hxx'.split(' '),
);
const polyglotSuffixes = new Set(['py', 'go', 'java', 'cs', 'rs']);
const ignoredFolders = new Set(
  '.git node_modules dist build coverage .next .nuxt .venv venv __pycache__ target vendor'.split(' '),
);
// Inputs besides source files that change findings. A change restarts the incremental watcher as
// well.
const configPatterns = [
  /^schema\.prisma$/,
  /^package\.json$/,
  /^tsconfig.*\.json$/,
  /^jsconfig.*\.json$/,
  /^loadwise\.config\.json$/,
  /\.sql$/,
];

/** The globs the server asks the editor to watch. */
const watchedGlobs = [
  '**/*.{' + [...sourceSuffixes].join(',') + '}',
  '**/schema.prisma',
  '**/*.sql',
  '**/migrations/**',
  '**/package.json',
  '**/tsconfig*.json',
  '**/jsconfig*.json',
  '**/loadwise.config.json',
  '**/' + dismissalsPath.split(path.sep).join('/'),
];

function suffixOf(filename: string): string {
  return path.extname(filename).slice(1).toLowerCase();
}

function classifyChange(root: string, filename: string): FileChangeKind {
  const relative = path.relative(root, filename);
  if (relative === dismissalsPath) return 'dismissals';
  const segments = relative.split(path.sep);
  if (segments.some((segment) => ignoredFolders.has(segment))) return 'ignored';
  const name = path.basename(filename);
  if (configPatterns.some((pattern) => pattern.test(name)) || segments.slice(0, -1).includes('migrations'))
    return 'config';
  return sourceSuffixes.has(suffixOf(filename)) ? 'source' : 'ignored';
}

// Breadth first, so a match near the root ends the walk early.
async function hasFileWithSuffix(root: string, suffixes: ReadonlySet<string>): Promise<boolean> {
  const pending = [root];
  for (let index = 0; index < pending.length; index++) {
    let entries;
    try {
      entries = await fs.readdir(pending[index], { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isFile() && suffixes.has(suffixOf(entry.name))) return true;
      if (entry.isDirectory() && !ignoredFolders.has(entry.name)) pending.push(path.join(pending[index], entry.name));
    }
  }
  return false;
}

export { classifyChange, hasFileWithSuffix, polyglotSuffixes, sourceSuffixes, watchedGlobs };
