// @ts-check
// Caches whole checker reports keyed by everything that can change them, so rescanning an unchanged project replays
// the stored output. Analysis crosses files, so a per-file cache would be unsafe; any input change misses.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { writeFileAtomic } from './atomic-write.cjs';
import { defaultCacheDirectory } from '../security/deps/osv.cjs';
import type { ChildRun } from './types/checker-run.cjs';

const formatVersion = 1;
const maxEntries = 20;
const gitListBuffer = 1 << 28;
const cacheableCommands = new Set(['check', 'perf', 'maint', 'sec']);
// Subcommands that read live state (databases, advisories) or write files.
const uncachedSubcommands = new Set(['deps', 'db', 'migrations', 'fix']);
// Flags that edit files, watch, depend on git history or the network, or write side files.
const uncachedFlags = new Set([
  '--fix',
  '--watch',
  '--staged',
  '--changed-since',
  '--write-baseline',
  '--online',
  '--review',
]);
// No checker reads these, so they are listed by size alone instead of being read.
const binaryExtensions = new Set(
  '.png .jpg .jpeg .gif .webp .ico .bmp .pdf .zip .gz .tgz .7z .woff .woff2 .ttf .eot .otf .mp3 .mp4 .mov .webm .wasm'.split(
    ' ',
  ),
);

// Exit 2 covers invalid input, crashes and scans that skipped files; none of them is a finished
// report to replay.
const cacheableExitCodes = new Set([0, 1]);

const stats = { hits: 0, misses: 0, bypasses: 0 };
let toolFingerprint: string | undefined;

function sha1(content: string | Buffer): string {
  return crypto.createHash('sha1').update(content).digest('hex');
}

// Editing loadwise itself must invalidate every entry; sizes and mtimes of its sources are enough
// for that.
function listSources(directory: string, files: string[] = []): string[] {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) listSources(absolute, files);
    else if (entry.name.endsWith('.cjs')) files.push(absolute);
  }
  return files;
}

function loadwiseFingerprint(): string {
  if (toolFingerprint) return toolFingerprint;
  const root = path.resolve(__dirname, '../..');
  const { version }: { version: string } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const sources = [
    ...listSources(path.join(root, 'lib')),
    ...listSources(path.join(root, 'bin')),
    ...listSources(path.join(root, 'polyglot')),
    ...listSources(path.join(root, 'editor')),
  ].sort();
  const lines = sources.map((file) => {
    const { size, mtimeMs } = fs.statSync(file);
    return `${path.relative(root, file)}\0${size}\0${mtimeMs}`;
  });
  toolFingerprint = sha1(`${version}\n${lines.join('\n')}`);
  return toolFingerprint;
}

function isCacheable(args: readonly string[]): boolean {
  if (process.env.LOADWISE_NO_CACHE === '1') return false;
  if (!cacheableCommands.has(args[0])) return false;
  if (uncachedSubcommands.has(args[1])) return false;
  return !args.some((arg) => uncachedFlags.has(arg.split('=')[0]));
}

function git(directory: string, gitArgs: readonly string[]): string | undefined {
  const run = spawnSync('git', ['-C', directory, ...gitArgs], {
    encoding: 'utf8',
    maxBuffer: gitListBuffer,
    windowsHide: true,
  });
  return run.status === 0 ? run.stdout : undefined;
}

// node_modules is ignored by git, but installing or removing a package changes the types the
// checkers see. Package managers rewrite these files on every install, so their size and time stand
// in for the whole tree.
const installMarkers = [
  'node_modules',
  'node_modules/.package-lock.json',
  'node_modules/.yarn-state.yml',
  'node_modules/.modules.yaml',
  'node_modules/.pnpm/lock.yaml',
];

// Checkers may read ancestor configs and repository-level files, so the whole repository is the
// input set. Undefined outside git, where no cache is used.
function inputFingerprint(cwd: string): string | undefined {
  const topLevel = git(cwd, ['rev-parse', '--show-toplevel'])?.trim();
  if (!topLevel) return undefined;
  const listing = git(topLevel, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']);
  if (listing === undefined) return undefined;
  const names = [...new Set(listing.split('\0').filter(Boolean))].sort();
  const hash = crypto.createHash('sha256').update(topLevel);
  for (const name of names) hash.update(`\0${name}\0${fileHash(path.join(topLevel, name))}`);
  for (const directory of new Set([topLevel, path.resolve(cwd)])) {
    for (const marker of installMarkers) {
      const stat = fs.statSync(path.join(directory, marker), { throwIfNoEntry: false });
      if (stat) hash.update(`\0${directory}\0${marker}\0${stat.size}\0${stat.mtimeMs}`);
    }
  }
  return hash.digest('hex');
}

const maxHashedFileBytes = 16 * 1024 * 1024;

function fileHash(absolute: string): string {
  try {
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) return `symlink:${sha1(fs.readlinkSync(absolute))}`;
    if (!stat.isFile()) return `special:${stat.mode}`;
    if (binaryExtensions.has(path.extname(absolute).toLowerCase()) || stat.size > maxHashedFileBytes) {
      return `size:${stat.size}:${stat.mtimeMs}`;
    }
    return sha1(fs.readFileSync(absolute));
  } catch {
    // Deleted tracked files, submodule folders and unreadable entries still count as distinct
    // states.
    return 'missing';
  }
}

function cacheKey(args: readonly string[], cwd: string): string | undefined {
  const inputs = inputFingerprint(cwd);
  if (!inputs) return undefined;
  const environment = Object.keys(process.env)
    .filter((name) => name.startsWith('LOADWISE_') && name !== 'LOADWISE_NO_CACHE')
    .sort()
    .map((name) => `${name}=${process.env[name]}`);
  // A config file named in the args may live outside the repository.
  const namedFiles = args.map((arg) => {
    const candidate = arg.startsWith('-') && arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : arg;
    if (!candidate) return '';
    const absolute = path.resolve(cwd, candidate);
    return fs.lstatSync(absolute, { throwIfNoEntry: false })?.isFile() ? fileHash(absolute) : '';
  });
  const parts = [formatVersion, loadwiseFingerprint(), path.resolve(cwd), args, namedFiles, environment, inputs];
  return crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

function cacheDirectory() {
  return path.join(defaultCacheDirectory(), 'scan-results');
}

function isStoredRun(value: unknown): value is ChildRun {
  return (
    typeof value === 'object' &&
    value !== null &&
    'code' in value &&
    typeof value.code === 'number' &&
    'stdout' in value &&
    typeof value.stdout === 'string' &&
    'stderr' in value &&
    typeof value.stderr === 'string'
  );
}

function readEntry(filename: string): ChildRun | undefined {
  try {
    const entry: unknown = JSON.parse(fs.readFileSync(filename, 'utf8'));
    if (!isStoredRun(entry)) return undefined;
    const now = new Date();
    // Touching a reused entry keeps it among the newest, so pruning drops the least recently used.
    fs.utimesSync(filename, now, now);
    return entry;
  } catch {
    return undefined;
  }
}

// A cache that cannot be written only costs speed, so failures here must not fail the check.
function writeEntry(filename: string, run: ChildRun): void {
  try {
    fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    writeFileAtomic(filename, JSON.stringify({ code: run.code, stdout: run.stdout, stderr: run.stderr }), 0o600);
    prune(path.dirname(filename));
  } catch {
    // Ignored on purpose; see above.
  }
}

function prune(directory: string): void {
  const entries = fs
    .readdirSync(directory)
    .filter((name) => name.endsWith('.json'))
    .map((name) => {
      const filename = path.join(directory, name);
      return { filename, modified: fs.statSync(filename, { throwIfNoEntry: false })?.mtimeMs ?? 0 };
    })
    .sort((first, second) => second.modified - first.modified);
  for (const { filename } of entries.slice(maxEntries)) fs.rmSync(filename, { force: true });
}

// Replays a stored { code, stdout, stderr } for identical inputs, otherwise runs and stores reports
// that completed.
async function cachedRun(args: readonly string[], cwd: string, run: () => Promise<ChildRun>): Promise<ChildRun> {
  const key = isCacheable(args) ? cacheKey(args, cwd) : undefined;
  if (!key) {
    stats.bypasses++;
    return run();
  }
  const filename = path.join(cacheDirectory(), `${key}.json`);
  const stored = readEntry(filename);
  if (stored) {
    stats.hits++;
    return stored;
  }
  stats.misses++;
  const result = await run();
  if (cacheableExitCodes.has(result.code)) writeEntry(filename, result);
  return result;
}

export { cachedRun, stats };
