import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Stats } from 'node:fs';
import type { Finding } from '../shared/types.js';
import type { LineCache } from './types/editor-report.js';
import { execFile as execFileNodeChildProcess } from 'node:child_process';
import { superviseEditor } from './editor-watch-supervisor.js';
import { watchTree } from './recursive-watch.js';
import { isSourceInput } from './source-inputs.js';
import { formatFinding } from './editor-report.js';
import { checkPolyglot } from './polyglot.js';
import { listenForEditorRefresh } from './editor-signal.js';
const execFile = promisify(execFileNodeChildProcess);

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

function exists(file: string): Promise<boolean> {
  return fs.access(file).then(
    () => true,
    () => false,
  );
}

async function firstExisting(root: string, names: readonly string[]): Promise<string | undefined> {
  for (const name of names) if (await exists(path.join(root, name))) return name;
}

// The maintainability checker ships in this package, so its findings always come from the same
// release.
const loadwiseCli = path.resolve(import.meta.dirname, '../../bin/loadwise.js');

async function maintainability(cli: string, root: string, signal: AbortSignal): Promise<Finding[]> {
  let stdout: string;
  try {
    ({ stdout } = await execFile(process.execPath, [cli, 'maint', '.', '--json'], {
      cwd: root,
      signal,
      windowsHide: true,
      maxBuffer: 64 * 1024 * 1024,
    }));
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    const stderr = 'stderr' in error && typeof error.stderr === 'string' ? error.stderr.trim() : '';
    if (!('code' in error) || error.code !== 1) throw new Error(stderr || error.message, { cause: error });
    stdout = 'stdout' in error && typeof error.stdout === 'string' ? error.stdout : '';
  }
  return JSON.parse(stdout).findings;
}

function watchEditor(
  root: string,
  explicitConfig: string | undefined,
  checkCode: (inputs: string[]) => Promise<Finding[]>,
  cli = loadwiseCli,
  hooks: { watchTree?: typeof watchTree; listenForEditorRefresh?: typeof listenForEditorRefresh } = {},
): void {
  if (!process.send || process.env.LOADWISE_EDITOR_WORKER !== '1') {
    return superviseEditor(root, explicitConfig);
  }
  const jsFiles = new Set<string>();
  const polyglotFiles = new Set<string>();
  const otherSources = new Set<string>();
  const controller = new AbortController();
  let ready = false;
  let running = false;
  let dirty = false;
  let timer: NodeJS.Timeout | undefined;
  let scanController: AbortController | undefined;

  async function scan() {
    running = true;
    dirty = false;
    const scanSignal = (scanController = new AbortController()).signal;
    const fileCache: LineCache = new Map();
    console.log('Loadwise: scan started');
    async function report(source: string, scanSource: () => Promise<Finding[]>) {
      try {
        const findings = await scanSource();
        for (const finding of findings) {
          const marker = formatFinding(root, source, finding, fileCache);
          if (marker) console.log(marker);
        }
      } catch (error) {
        if (!controller.signal.aborted && !scanSignal.aborted)
          console.error(
            source +
              ' scan failed: ' +
              (error instanceof Error ? error.message : String(error)).replaceAll(/[\p{Cc}\p{Zl}\p{Zp}]/gu, ' '),
          );
      }
    }
    try {
      const config = explicitConfig ?? (await firstExisting(root, ['tsconfig.json', 'jsconfig.json']));
      if (!scanSignal.aborted && (config || jsFiles.size)) {
        await report('loadwise perf', () =>
          checkCode(config ? ['-p', config] : Array.from(jsFiles, (file) => path.resolve(root, file))),
        );
      }
      if (!scanSignal.aborted && polyglotFiles.size) {
        await report('loadwise perf', async () => (await checkPolyglot([root])).findings);
      }
      if (!scanSignal.aborted) {
        await report('loadwise perf', async () => {
          const migrationsCli = await import('./migrations/cli.js');
          return migrationsCli.checkProjectMigrations({ root });
        });
      }
      if (!scanSignal.aborted && (jsFiles.size || polyglotFiles.size || otherSources.size)) {
        await report('loadwise maint', () => maintainability(cli, root, scanSignal));
      }
    } finally {
      console.log('Loadwise: scan finished');
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
    // The in-flight scan is stale: stop its child, the follow-up starts one debounce after the last
    // change.
    scanController?.abort();
    clearTimeout(timer);
    timer = setTimeout(runScheduled, debounceMs);
  }
  const watcher = (hooks.watchTree ?? watchTree)(root, (relative: string, stat?: Stats) => {
    if (relative.split(path.sep).some((segment) => ignoredDirectories.has(segment))) return true;
    return Boolean(stat?.isFile() && /(?:\.min\.(?:[cm]?js|css)|\.map|\.tsbuildinfo)$/i.test(relative));
  });
  watcher.on('all', (event: string, file: string) => {
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
    if (files || /\.json$|\.(?:sql|prisma)$|\.d\.[cm]?ts$|(?:^|[/\\])\.gitignore$/i.test(file) || event !== 'change')
      schedule();
  });
  watcher.once('ready', () => {
    ready = true;
    schedule();
  });
  const refresh = (hooks.listenForEditorRefresh ?? listenForEditorRefresh)(root, schedule);
  function stop() {
    clearTimeout(timer);
    controller.abort();
    scanController?.abort();
    void watcher.close();
    refresh.close();
    process.off('disconnect', stop);
    if (process.connected) process.disconnect?.();
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
  watcher.on('error', (error: Error) => {
    console.error(error.message);
    process.exitCode = 2;
    stop();
  });
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  process.once('disconnect', stop);
  if (!process.connected) stop();
}

export { watchEditor };
