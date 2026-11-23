// @ts-check
'use strict';

// Node's default old-space limit is about 4 GB, which a 25,000-file monorepo scan exceeds (it peaked at 8.6 GB).
// The checkers get a larger limit derived from the machine unless the user already chose one.
const os = require('node:os');
const v8 = require('node:v8');

const bytesPerMegabyte = 1024 * 1024;
const heapFractionOfMemory = 0.6;
const minHeapMegabytes = 4096;
const maxHeapMegabytes = 16384;
const heapFlagName = '--max-old-space-size';
// Node accepts the underscore spelling of V8 flags too.
const heapFlagPattern = /(^|\s)--max[-_]old[-_]space[-_]size(=|\s|$)/;
const respawnMarker = 'LOADWISE_HEAP_RESPAWNED';

function defaultHeapMegabytes() {
  return Math.floor(v8.getHeapStatistics().heap_size_limit / bytesPerMegabyte);
}

function recommendedHeapMegabytes(totalMemoryBytes = os.totalmem(), defaultMegabytes = defaultHeapMegabytes()) {
  const fraction = Math.floor((totalMemoryBytes / bytesPerMegabyte) * heapFractionOfMemory);
  return Math.max(defaultMegabytes, Math.min(maxHeapMegabytes, Math.max(minHeapMegabytes, fraction)));
}

function userSetHeapLimit(nodeOptions = process.env.NODE_OPTIONS, execArgv = process.execArgv) {
  return heapFlagPattern.test(nodeOptions ?? '') || execArgv.some((flag) => heapFlagPattern.test(flag));
}

// The flags to pass a child node process: the user's own execArgv limit, nothing when NODE_OPTIONS sets one
// (the child inherits it), otherwise the machine-derived limit.
function childHeapFlags(nodeOptions = process.env.NODE_OPTIONS, execArgv = process.execArgv) {
  const inherited = execArgv.filter((flag) => heapFlagPattern.test(flag));
  if (inherited.length) return inherited;
  if (userSetHeapLimit(nodeOptions, [])) return [];
  return [`${heapFlagName}=${recommendedHeapMegabytes()}`];
}

// The limit a child was allowed, which an out-of-memory message reports. Command-line flags beat NODE_OPTIONS.
function allowedHeapMegabytes(flags, nodeOptions = process.env.NODE_OPTIONS) {
  const candidates = [...(nodeOptions ?? '').split(/\s+/), ...flags];
  const given = candidates.filter((flag) => heapFlagPattern.test(flag) && /=\d+/.test(flag)).pop();
  return given ? Number(given.match(/=(\d+)/)[1]) : defaultHeapMegabytes();
}

// An in-process command only re-spawns when it runs on the default limit, the user chose none and a larger one fits.
function shouldRespawnWithLargerHeap(env = process.env) {
  if (env[respawnMarker] === '1' || userSetHeapLimit(env.NODE_OPTIONS, process.execArgv)) return false;
  return recommendedHeapMegabytes() > defaultHeapMegabytes();
}

function respawnWithLargerHeap(scriptPath, args) {
  const { spawnSync } = require('node:child_process');
  // The child inherits process.env; copying it here would read every variable, connection strings included.
  process.env[respawnMarker] = '1';
  const run = spawnSync(
    process.execPath,
    [`${heapFlagName}=${recommendedHeapMegabytes()}`, ...process.execArgv, scriptPath, ...args],
    { stdio: 'inherit' },
  );
  return run.status ?? 2;
}

const heapExhaustionPattern = /(heap|javascript) out of memory/i;
// V8 aborts the process on heap exhaustion: exit 134 on POSIX, a signal or a native crash code elsewhere, and a raw
// dump on stderr. Exit codes 0 to 2 are the checkers' own.
function isHeapExhaustion({ code, signal, stderr }) {
  const diedAbnormally = Boolean(signal) || ![0, 1, 2].includes(code);
  return diedAbnormally && heapExhaustionPattern.test(stderr);
}

module.exports = {
  allowedHeapMegabytes,
  childHeapFlags,
  isHeapExhaustion,
  recommendedHeapMegabytes,
  respawnWithLargerHeap,
  shouldRespawnWithLargerHeap,
  userSetHeapLimit,
};
