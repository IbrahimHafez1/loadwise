'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { promisify } = require('node:util');
const execFile = promisify(require('node:child_process').execFile);

const ignoredDirectories = new Set([
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.next',
  '.nuxt',
  '.venv',
  'venv',
  '__pycache__',
  '.cache',
  '.turbo',
  'target',
  'vendor',
  '.worktrees',
]);
const nativePerformanceSource = /\.(?:py|go|java|cs|rs)$/i;
const otherMaintainabilitySource = /\.(?:rb|php|kts?|c|cc|cpp|cxx|h|hh|hpp|hxx)$/i;
const debounceMs = 500;

function exists(file) {
  return fs.access(file).then(
    () => true,
    () => false,
  );
}

async function firstExisting(root, names) {
  for (const name of names) if (await exists(path.join(root, name))) return name;
}

function companion(root) {
  try {
    const manifest = require.resolve('maintainability-check/package.json', { paths: [root] });
    return path.join(path.dirname(manifest), 'bin', 'maintainability-check.cjs');
  } catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND') throw error;
  }
}

async function maintainability(cli, root, signal) {
  let stdout;
  try {
    ({ stdout } = await execFile(process.execPath, [cli, '.', '--json'], {
      cwd: root,
      signal,
      windowsHide: true,
      maxBuffer: 64 * 1024 * 1024,
    }));
  } catch (error) {
    if (error.code !== 1) throw new Error(error.stderr?.trim() || error.message, { cause: error });
    stdout = error.stdout;
  }
  return JSON.parse(stdout).findings;
}

function watchEditor(root, explicitConfig, checkCode) {
  if (!process.send || process.env.BACKEND_CHECKERS_EDITOR_WORKER !== '1') {
    return require('./editor-watch-supervisor.cjs').superviseEditor(root, explicitConfig, companion(root));
  }
  const { watchTree } = require('./recursive-watch.cjs');
  const { isSourceInput } = require('./source-inputs.cjs');
  const { formatFinding } = require('./editor-report.cjs');
  const jsFiles = new Set();
  const polyglotFiles = new Set();
  const otherSources = new Set();
  const cli = companion(root);
  const controller = new AbortController();
  let ready = false;
  let running = false;
  let dirty = false;
  let timer;
  let scanController;
  if (!cli)
    console.error('Running performance checks. Install maintainability-check in this project to include its findings.');

  async function scan() {
    running = true;
    dirty = false;
    const scanSignal = (scanController = new AbortController()).signal;
    const fileCache = new Map();
    console.log('Backend Checkers: scan started');
    async function report(source, scanSource) {
      try {
        const findings = await scanSource();
        for (const finding of findings) {
          const marker = formatFinding(root, source, finding, fileCache);
          if (marker) console.log(marker);
        }
      } catch (error) {
        if (!controller.signal.aborted && !scanSignal.aborted)
          console.error(source + ' scan failed: ' + error.message.replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, ' '));
      }
    }
    try {
      const config = explicitConfig ?? (await firstExisting(root, ['tsconfig.json', 'jsconfig.json']));
      if (!scanSignal.aborted && (config || jsFiles.size)) {
        await report('backend-perf-check', () =>
          checkCode(config ? ['-p', config] : Array.from(jsFiles, (file) => path.resolve(root, file))),
        );
      }
      if (!scanSignal.aborted && polyglotFiles.size) {
        await report(
          'backend-perf-check',
          async () => (await require('./polyglot.cjs').checkPolyglot([root])).findings,
        );
      }
      if (!scanSignal.aborted) {
        await report('backend-perf-check', () => require('./migrations/cli.cjs').checkProjectMigrations({ root }));
      }
      if (
        !scanSignal.aborted &&
        cli &&
        (jsFiles.size ||
          polyglotFiles.size ||
          otherSources.size ||
          (await exists(path.join(root, 'maintainability.config.json'))))
      ) {
        await report('maintainability-check', () => maintainability(cli, root, scanSignal));
      }
    } finally {
      console.log('Backend Checkers: scan finished');
      running = false;
      scanController = undefined;
      if (dirty && !timer && !controller.signal.aborted) schedule();
    }
  }
  function runScheduled() {
    timer = undefined;
    if (!running) void scan();
  }
  function schedule() {
    dirty = true;
    if (!ready || controller.signal.aborted) return;
    // The in-flight scan is stale: stop its child, the follow-up starts one debounce after the last change.
    scanController?.abort();
    clearTimeout(timer);
    timer = setTimeout(runScheduled, debounceMs);
  }
  const watcher = watchTree(root, (relative, stat) => {
    if (relative.split(path.sep).some((segment) => ignoredDirectories.has(segment))) return true;
    return stat?.isFile() && /(?:\.min\.(?:[cm]?js|css)|\.map|\.tsbuildinfo)$/i.test(relative);
  });
  watcher.on('all', (event, file) => {
    if (!['add', 'unlink', 'change'].includes(event)) return;
    const files = isSourceInput(file)
      ? jsFiles
      : nativePerformanceSource.test(file)
        ? polyglotFiles
        : otherMaintainabilitySource.test(file)
          ? otherSources
          : undefined;
    if (files) {
      if (event === 'unlink') files.delete(file);
      else files.add(file);
    }
    if (
      files ||
      /\.json$|\.(?:sql|prisma)$|\.d\.[cm]?ts$|(?:^|[/\\])\.gitignore$/i.test(file) ||
      (cli && event !== 'change')
    )
      schedule();
  });
  watcher.once('ready', () => {
    ready = true;
    schedule();
  });
  const refresh = require('./editor-signal.cjs').listenForEditorRefresh(root, schedule);
  function stop() {
    clearTimeout(timer);
    controller.abort();
    scanController?.abort();
    void watcher.close();
    refresh.close();
    process.off('disconnect', stop);
    if (process.connected) process.disconnect();
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
  watcher.on('error', (error) => {
    console.error(error.message);
    process.exitCode = 2;
    stop();
  });
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  process.once('disconnect', stop);
  if (!process.connected) stop();
}

module.exports = { watchEditor };
