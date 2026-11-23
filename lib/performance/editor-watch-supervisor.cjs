'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { fork } = require('node:child_process');

const installPollMs = 1000;
const installSettleMs = 700;
const installRetryMs = 3000;
const maxInstallRetries = 3;

function superviseEditor(root, explicitConfig) {
  // Keep the installed path, including a package-manager symlink, so a replacement resolves to the new checkout.
  const script = path.resolve(process.argv[1]);
  const installed = path.join(root, 'node_modules', '@loadwise', 'cli', 'bin', 'loadwise.cjs');
  const cli = fs.existsSync(installed) && fs.realpathSync(installed) === fs.realpathSync(script) ? installed : script;
  const markers = new Set([cli, path.join(path.dirname(path.dirname(cli)), 'package.json')]);
  let worker,
    timer,
    retries = maxInstallRetries,
    restarting = false,
    stopped = false;

  function launch() {
    if (stopped || !fs.existsSync(cli)) return;
    restarting = false;
    worker = fork(cli, ['perf', 'editor', 'watch', ...(explicitConfig ? ['-p', explicitConfig] : [])], {
      cwd: root,
      env: { ...process.env, BACKEND_CHECKERS_EDITOR_SCAN: '1', BACKEND_CHECKERS_EDITOR_WORKER: '1' },
      execArgv: [],
      windowsHide: true,
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });
    const child = worker;
    child.on('error', (error) => {
      console.error(error.message);
      if (!child.pid) finished(2);
    });
    // On Windows a manually disconnected IPC channel can outlive the child's exit event.
    child.once('exit', finished);
    function finished(code) {
      worker = undefined;
      if (stopped) return;
      if (restarting) {
        if (!timer) launch();
      } else if (code !== 0) {
        // A package manager can publish its manifest and entry point before its runtime files.
        if (retries > 0) {
          retries--;
          timer = setTimeout(restart, installRetryMs);
        } else console.error('Editor worker exited. Waiting for a checker package update.');
      } else {
        stop();
      }
    }
  }

  function terminateWorker(target) {
    if (!target) return;
    if (target.connected) target.disconnect();
    const killTimer = setTimeout(() => {
      if (target.exitCode === null && target.signalCode === null) target.kill('SIGKILL');
    }, 3000);
    killTimer.unref();
  }

  function restart() {
    timer = undefined;
    restarting = true;
    if (worker) {
      terminateWorker(worker);
    } else launch();
  }

  function installationChanged(current, previous) {
    // watchFile reports an initial all-zero stat for an optional package that is not installed.
    if (!current.nlink && !previous.nlink) return;
    retries = maxInstallRetries;
    restarting = true;
    clearTimeout(timer);
    timer = setTimeout(restart, installSettleMs);
  }

  function stop() {
    stopped = true;
    clearTimeout(timer);
    for (const marker of markers) fs.unwatchFile(marker, installationChanged);
    if (worker) terminateWorker(worker);
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }

  // Poll only these entry points. Filesystem watches on the old inode can go silent after a dependency is replaced.
  for (const marker of markers) fs.watchFile(marker, { interval: installPollMs }, installationChanged);
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  launch();
}

module.exports = { superviseEditor };
