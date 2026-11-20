'use strict';

const { spawn } = require('node:child_process');

// Runs `warden-backend -p <config> --watch --json`. The TypeScript watch compiler re-analyzes only what changed,
// including edits from git, other editors or code generators, and prints one compact JSON report per line.
function startPerfWatch({ script, project, cwd, env, onFindings, onError, onExit }) {
  const child = spawn('node', [script, '-p', project, '--watch', '--json'], {
    cwd,
    env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let pending = '';
  let stopped = false;
  function readReport(line) {
    let report;
    try {
      report = JSON.parse(line);
    } catch (error) {
      onError(new Error('Watch mode printed an unreadable report: ' + error.message));
      return;
    }
    if (Array.isArray(report?.findings)) onFindings(report.findings);
    else onError(new Error('Watch mode returned an invalid findings report.'));
  }
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    pending += chunk;
    let newline;
    while ((newline = pending.indexOf('\n')) !== -1) {
      const line = pending.slice(0, newline).trim();
      pending = pending.slice(newline + 1);
      if (line) readReport(line);
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (text) => {
    if (text.trim()) onError(new Error(text.trim()));
  });
  function finish(error) {
    if (stopped) return;
    stopped = true;
    onExit(error);
  }
  child.on('error', finish);
  child.on('exit', (code, signal) => finish(new Error('Watch mode exited with ' + (signal ?? 'code ' + code) + '.')));
  return {
    stop() {
      stopped = true;
      child.kill();
    },
  };
}

module.exports = { startPerfWatch };
