import { spawn } from 'node:child_process';
import type { Finding } from '../shared/types.js';

interface PerfWatchOptions {
  script: string;
  project: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  onFindings(findings: Finding[]): void;
  onError(error: Error): void;
  onExit(error: Error): void;
}

interface PerfWatchReport {
  findings?: unknown;
}

export interface PerfWatchHandle {
  pid: number | undefined;
  stop(): void;
}

// Runs `loadwise perf -p <config> --watch --json`. The TypeScript watch compiler re-analyzes only
// what changed, including edits from git, other editors or code generators, and prints one compact
// JSON report per line.
function startPerfWatch({ script, project, cwd, env, onFindings, onError, onExit }: PerfWatchOptions): PerfWatchHandle {
  const child = spawn(process.execPath, [script, 'perf', '-p', project, '--watch', '--json'], {
    cwd,
    env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const maxPendingBytes = 64 * 1024 * 1024;
  let pending = '';
  let stopped = false;
  function readReport(line: string): void {
    let report: PerfWatchReport | null;
    try {
      report = JSON.parse(line);
    } catch (error) {
      onError(
        new Error(
          'Watch mode printed an unreadable report: ' + (error instanceof Error ? error.message : String(error)),
        ),
      );
      return;
    }
    if (report && Array.isArray(report.findings)) onFindings(report.findings);
    else onError(new Error('Watch mode returned an invalid findings report.'));
  }
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    if (child.killed) return;
    if (pending.length + chunk.length > maxPendingBytes) {
      pending = '';
      onError(new Error('Watch mode output exceeded maximum buffer size.'));
      child.kill('SIGKILL');
      return;
    }
    pending += chunk;
    let newline: number;
    while ((newline = pending.indexOf('\n')) !== -1) {
      const line = pending.slice(0, newline).trim();
      pending = pending.slice(newline + 1);
      if (line) readReport(line);
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (text: string) => {
    if (child.killed) return;
    if (text.trim()) onError(new Error(text.trim()));
  });
  function finish(error: Error): void {
    if (stopped) return;
    stopped = true;
    onExit(error);
  }
  child.on('error', finish);
  child.on('exit', (code, signal) => finish(new Error('Watch mode exited with ' + (signal ?? 'code ' + code) + '.')));
  return {
    pid: child.pid,
    stop() {
      if (stopped) return;
      stopped = true;
      child.kill();
      const killTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }, 2000);
      killTimer.unref();
    },
  };
}

export { startPerfWatch };
