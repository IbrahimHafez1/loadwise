'use strict';

// Caches whole checker reports keyed by everything that can change them, so rescanning an unchanged project replays
// the stored output. Analysis crosses files, so a per-file cache would be unsafe; any input change misses.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { writeFileAtomic } = require('./atomic-write.cjs');
const { defaultCacheDirectory } = require('../security/deps/osv.cjs');

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

const stats = { hits: 0, misses: 0, bypasses: 0 };
let toolFingerprint;

function sha1(content) {
  return crypto.createHash('sha1').update(content).digest('hex');
}

// Editing loadwise itself must invalidate every entry; sizes and mtimes of its sources are enough for that.
function listSources(directory, files = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) listSources(absolute, files);
    else if (entry.name.endsWith('.cjs')) files.push(absolute);
  }
  return files;
}

function loadwiseFingerprint() {
  if (toolFingerprint) return toolFingerprint;
  const root = path.resolve(__dirname, '../..');
  const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const sources = [...listSources(path.join(root, 'lib')), ...listSources(path.join(root, 'bin'))].sort();
  const lines = sources.map((file) => {
    const { size, mtimeMs } = fs.statSync(file);
    return `${path.relative(root, file)}\0${size}\0${mtimeMs}`;
  });
  toolFingerprint = sha1(`${version}\n${lines.join('\n')}`);
  return toolFingerprint;
}

function isCacheable(args) {
  if (process.env.LOADWISE_NO_CACHE === '1') return false;
  if (!cacheableCommands.has(args[0])) return false;
  if (uncachedSubcommands.has(args[1])) return false;
  return !args.some((arg) => uncachedFlags.has(arg.split('=')[0]));
}

function git(directory, gitArgs) {
  const run = spawnSync('git', ['-C', directory, ...gitArgs], {
    encoding: 'utf8',
    maxBuffer: gitListBuffer,
    windowsHide: true,
  });
  return run.status === 0 ? run.stdout : undefined;
}

// Checkers may read ancestor configs and repository-level files, so the whole repository is the input set.
// Undefined outside git, where no cache is used.
function inputFingerprint(cwd) {
  const topLevel = git(cwd, ['rev-parse', '--show-toplevel'])?.trim();
  if (!topLevel) return undefined;
  const listing = git(topLevel, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']);
  if (listing === undefined) return undefined;
  const names = [...new Set(listing.split('\0').filter(Boolean))].sort();
  const hash = crypto.createHash('sha256').update(topLevel);
  for (const name of names) hash.update(`\0${name}\0${fileHash(path.join(topLevel, name))}`);
  return hash.digest('hex');
}

function fileHash(absolute) {
  try {
    if (binaryExtensions.has(path.extname(absolute).toLowerCase())) return `size:${fs.statSync(absolute).size}`;
    return sha1(fs.readFileSync(absolute));
  } catch {
    // Deleted tracked files, submodule folders and unreadable entries still count as distinct states.
    return 'missing';
  }
}

function cacheKey(args, cwd) {
  const inputs = inputFingerprint(cwd);
  if (!inputs) return undefined;
  const environment = Object.keys(process.env)
    .filter((name) => name.startsWith('LOADWISE_') && name !== 'LOADWISE_NO_CACHE')
    .sort()
    .map((name) => `${name}=${process.env[name]}`);
  // A config file named in the args may live outside the repository.
  const namedFiles = args.map((arg) => {
    const absolute = path.resolve(cwd, arg);
    return fs.statSync(absolute, { throwIfNoEntry: false })?.isFile() ? fileHash(absolute) : '';
  });
  const parts = [formatVersion, loadwiseFingerprint(), path.resolve(cwd), args, namedFiles, environment, inputs];
  return crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

function cacheDirectory() {
  return path.join(defaultCacheDirectory(), 'scan-results');
}

function readEntry(filename) {
  try {
    const entry = JSON.parse(fs.readFileSync(filename, 'utf8'));
    const now = new Date();
    // Touching a reused entry keeps it among the newest, so pruning drops the least recently used.
    fs.utimesSync(filename, now, now);
    return entry;
  } catch {
    return undefined;
  }
}

// A cache that cannot be written only costs speed, so failures here must not fail the check.
function writeEntry(filename, run) {
  try {
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    writeFileAtomic(filename, JSON.stringify({ code: run.code, stdout: run.stdout, stderr: run.stderr }));
    prune(path.dirname(filename));
  } catch {
    // Ignored on purpose; see above.
  }
}

function prune(directory) {
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

// Replays a stored { code, stdout, stderr } for identical inputs, otherwise runs and stores reports that completed.
async function cachedRun(args, cwd, run) {
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
  if (result.code === 0 || result.code === 1) writeEntry(filename, result);
  return result;
}

module.exports = { cachedRun, stats };
