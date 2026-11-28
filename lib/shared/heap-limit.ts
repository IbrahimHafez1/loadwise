// Node's default old-space limit is about 4 GB, which a 25,000-file monorepo scan exceeds (it peaked at 8.6 GB).
// The checkers get a larger limit derived from the machine unless the user already chose one.
import os from 'node:os';
import v8 from 'node:v8';
import { spawn } from 'node:child_process';

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

// The flags to pass a child node process: the user's own execArgv limit, nothing when NODE_OPTIONS
// sets one (the child inherits it), otherwise the machine-derived limit.
function childHeapFlags(nodeOptions = process.env.NODE_OPTIONS, execArgv = process.execArgv) {
  const inherited = execArgv.filter((flag) => heapFlagPattern.test(flag));
  if (inherited.length) return inherited;
  if (userSetHeapLimit(nodeOptions, [])) return [];
  return [`${heapFlagName}=${recommendedHeapMegabytes()}`];
}

// The limit a child was allowed, which an out-of-memory message reports. Command-line flags beat
// NODE_OPTIONS.
function allowedHeapMegabytes(flags: readonly string[], nodeOptions = process.env.NODE_OPTIONS) {
  const candidates = [...(nodeOptions ?? '').split(/\s+/), ...flags];
  const given = candidates.filter((flag) => heapFlagPattern.test(flag) && /=\d+/.test(flag)).pop();
  return given ? Number(/=(\d+)/.exec(given)?.[1]) : defaultHeapMegabytes();
}

// An in-process command only re-spawns when it runs on the default limit, the user chose none and a
// larger one fits.
function shouldRespawnWithLargerHeap(env = process.env) {
  if (env[respawnMarker] === '1' || userSetHeapLimit(env.NODE_OPTIONS, process.execArgv)) return false;
  return recommendedHeapMegabytes() > defaultHeapMegabytes();
}

// Editors and process managers signal only the process they started. Without forwarding, stopping a
// `--watch` run would leave the re-spawned watcher running, holding its output pipes open forever.
const forwardedSignals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;

// Sets process.exitCode once the child exits.
function respawnWithLargerHeap(scriptPath: string, args: readonly string[]): void {
  // The child inherits process.env; copying it here would read every variable, connection strings
  // included.
  process.env[respawnMarker] = '1';
  const child = spawn(
    process.execPath,
    [`${heapFlagName}=${recommendedHeapMegabytes()}`, ...process.execArgv, scriptPath, ...args],
    { stdio: 'inherit', windowsHide: true },
  );
  const forward = (signal: NodeJS.Signals) => child.kill(signal);
  for (const signal of forwardedSignals) process.on(signal, forward);
  child.on('error', (error) => {
    for (const signal of forwardedSignals) process.off(signal, forward);
    process.stderr.write(`loadwise: could not restart with a larger heap: ${error.message}\n`);
    process.exitCode = 2;
  });
  child.on('exit', (code) => {
    for (const signal of forwardedSignals) process.off(signal, forward);
    process.exitCode = code ?? 2;
  });
}

const heapExhaustionPattern = /(heap|javascript) out of memory/i;
// V8 aborts the process on heap exhaustion: exit 134 on POSIX, a signal or a native crash code
// elsewhere, and a raw dump on stderr. Exit codes 0 to 2 are the checkers' own.
interface ChildExit {
  code: number | null;
  signal?: string | null;
  stderr: string;
}

function isHeapExhaustion({ code, signal, stderr }: ChildExit) {
  const diedAbnormally = Boolean(signal) || code === null || ![0, 1, 2].includes(code);
  return diedAbnormally && heapExhaustionPattern.test(stderr);
}

export {
  allowedHeapMegabytes,
  childHeapFlags,
  isHeapExhaustion,
  recommendedHeapMegabytes,
  respawnWithLargerHeap,
  shouldRespawnWithLargerHeap,
  userSetHeapLimit,
};
