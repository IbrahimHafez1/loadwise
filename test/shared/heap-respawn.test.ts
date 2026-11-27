import { spawn } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { shouldRespawnWithLargerHeap } from '../../lib/shared/heap-limit.js';

const root = path.resolve(import.meta.dirname, '../..');
const bin = path.join(root, 'bin/loadwise.js');
const watchTimeoutMs = 60000;

// Windows has no catchable SIGTERM, and a machine whose default heap is already large never re-spawns.
const skip =
  process.platform === 'win32' || !shouldRespawnWithLargerHeap()
    ? 'needs POSIX signals and a re-spawned checker'
    : false;

test('stopping a re-spawned watch run also stops the watcher it started', { skip }, async (context) => {
  // Its own process group, so a failed wait or a regression cannot leave the watcher holding this test process open.
  const child = spawn(process.execPath, [bin, 'perf', '--watch', '-p', 'examples/tsconfig.json'], {
    cwd: root,
    detached: true,
  });
  context.after(() => {
    try {
      process.kill(-Number(child.pid), 'SIGKILL');
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error;
    }
  });
  let stdout = '';
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('watch produced no result')), watchTimeoutMs);
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (!/file\(s\) checked/.test(stdout)) return;
      clearTimeout(timer);
      resolve();
    });
  });
  child.kill('SIGTERM');
  // 'close' waits for every holder of the output pipes, so an orphaned watcher would keep it from firing.
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('the re-spawned watcher kept running')), watchTimeoutMs);
    child.on('close', () => {
      clearTimeout(timer);
      resolve();
    });
  });
});
