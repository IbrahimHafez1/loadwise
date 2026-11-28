// One workspace folder's scans. Performance, reliability and accessibility come from the
// incremental `perf -p <config> --watch --json` process when the folder has one config to follow;
// maintainability, security, templates and the polyglot rules rerun after each change, debounced.
// The folder's inputs are chosen the way `loadwise check` chooses them. Rapid changes coalesce into
// one scan of the newest state, and a change during a scan aborts the stale child.
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import type { ExecFileOptionsWithStringEncoding } from 'node:child_process';
import { promisify } from 'node:util';
import { startPerfWatch } from './perf-watch.js';
import { hasFileWithSuffix, markupSuffixes, polyglotSuffixes, sourceSuffixes } from './workspace-files.js';
import { isMarkupFile } from '../accessibility/markup-files.js';
import { listenForEditorRefresh } from '../performance/editor-signal.js';
import { hasInfrastructureFiles } from '../security/files/index.js';
import { configlessSources, coveringConfig, hasWorkspaceSources } from '../shared/workspaces.js';
import type { PerfWatchHandle } from './perf-watch.js';
import type { Finding } from '../shared/types.js';

/** The `loadwise` settings of one workspace folder. */
export interface LoadwiseSettings {
  enabled: boolean;
  /** TypeScript or JavaScript project config, relative to the folder. */
  project: string;
  /** Absolute path of another bin/loadwise.js. */
  cli: string;
  severity: string;
  codeLens: boolean;
}

/** The last findings of one checker run. */
export interface CheckerReport {
  source: string;
  findings: Finding[];
}

export interface ScanSessionOptions {
  root: string;
  name: string;
  defaultCli: string;
  settings(): LoadwiseSettings;
  log(text: string): void;
  logError(text: string): void;
  /** The reports changed: republish the folder's diagnostics. */
  onReports(): void;
  /** A scan started or finished. */
  onStatus(): void;
}

export interface ScanSession {
  schedule(options?: { restart?: boolean; filesAddedOrRemoved?: boolean }): void;
  scanNow(): Promise<void>;
  reports(): Iterable<CheckerReport>;
  isScanning(): boolean;
  /** The process id of the running incremental watcher, if any. */
  watcherPid(): number | undefined;
  dispose(): void;
}

/** What the server lists for one checker run on a folder. */
interface ScanTask {
  id: string;
  source: string;
  args: string[] | null;
  /** Starts the incremental watcher on this project instead of running `args` once. */
  watchProject?: string;
  /** Keeps only the findings in markup files, because the watcher shows the rest. */
  markupOnly?: boolean;
}

/** The `-p` input of the source checkers, and whether the incremental watcher can follow it. */
interface SourceTarget {
  project: string;
  watchable: boolean;
}

/** The incremental watcher of one folder; `pending` is set until its first report. */
interface ActivePerfWatch {
  key: string;
  pending: boolean;
  handle?: PerfWatchHandle;
}

/** Which inputs the folder has; walking the tree is slow, so it is redone only when files come or go. */
interface FolderInputs {
  hasSource: boolean;
  hasPolyglot: boolean;
  hasMarkup: boolean;
}

/** What `loadwise check` scans in a folder without a config of its own. */
interface ConfiglessInputs {
  /** Workspace packages, plain JavaScript beside a package.json, or an ancestor config: `-p .` finds them. */
  hasSources: boolean;
  /** Dockerfiles, workflows and other files the security checker reads without a config. */
  hasInfrastructure: boolean;
}

/** A failed child process: `execFile` rejects with an Error that also carries the exit code and output. */
interface ExecFailure {
  message: string;
  code: unknown;
  stdout: string | undefined;
  stderr: string | undefined;
}

const run = promisify(execFile);
const debounceMs = 650;
const maxReportBytes = 64 * 1024 * 1024;
const perf = 'loadwise perf';
const maint = 'loadwise maint';
const sec = 'loadwise sec';
// The server's own scans must not ask the running editors to refresh again.
const scanEnv = { ...process.env, LOADWISE_EDITOR_SCAN: '1' };

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function execFailureOf(error: unknown): ExecFailure {
  if (!(error instanceof Error)) throw error;
  return {
    message: error.message,
    code: 'code' in error ? error.code : undefined,
    stdout: 'stdout' in error && typeof error.stdout === 'string' ? error.stdout : undefined,
    stderr: 'stderr' in error && typeof error.stderr === 'string' ? error.stderr : undefined,
  };
}

function exists(file: string): Promise<boolean> {
  return fs.access(file).then(
    () => true,
    () => false,
  );
}

async function firstExisting(root: string, names: readonly string[]): Promise<string | undefined> {
  for (const name of names) if (await exists(path.join(root, name))) return name;
}

async function readFindings(
  script: string,
  args: readonly string[],
  cwd: string,
  signal: AbortSignal,
): Promise<Finding[]> {
  const options: ExecFileOptionsWithStringEncoding = {
    cwd,
    signal,
    windowsHide: true,
    maxBuffer: maxReportBytes,
    encoding: 'utf8',
    env: scanEnv,
  };
  let stdout: string;
  try {
    ({ stdout } = await run(process.execPath, [script, ...args, '--json'], options));
  } catch (error) {
    const failure = execFailureOf(error);
    // Exit code 1 means findings met the exit threshold; the report is still complete.
    if (failure.code !== 1) throw new Error(failure.stderr?.trim() || failure.message, { cause: error });
    stdout = failure.stdout ?? '';
  }
  const report: { findings?: unknown } = JSON.parse(stdout);
  if (!Array.isArray(report.findings)) throw new Error('Checker returned an invalid findings report.');
  return report.findings;
}

// A project setting is used only when it stays inside the folder and cannot be read as a flag.
function explicitProject(root: string, setting: string): string {
  const trimmed = setting.trim();
  if (!trimmed || trimmed.startsWith('-')) return '';
  const relative = path.relative(root, path.resolve(root, trimmed));
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) return '';
  return relative;
}

// Like `loadwise check`: a tsconfig.json beside a jsconfig.json is passed as the folder, so the
// JavaScript only the jsconfig covers is scanned too. The watcher follows one config, so that
// folder gets full scans instead.
async function configTarget(root: string, setting: string): Promise<SourceTarget | undefined> {
  const explicit = explicitProject(root, setting);
  if (explicit) return { project: explicit, watchable: true };
  const own = await firstExisting(root, ['tsconfig.json', 'jsconfig.json']);
  if (own === 'tsconfig.json' && (await exists(path.join(root, 'jsconfig.json')))) {
    return { project: '.', watchable: false };
  }
  return own ? { project: own, watchable: true } : undefined;
}

// These walk the tree synchronously, so they run only for a folder without a config, once per
// change of its files.
function probeConfiglessInputs(root: string): ConfiglessInputs {
  const hasSources = Boolean(hasWorkspaceSources(root) || configlessSources(root) || coveringConfig(root));
  return { hasSources, hasInfrastructure: !hasSources && hasInfrastructureFiles(root) };
}

function accessibilityArgs(project: string | undefined, inputs: FolderInputs): string[] | null {
  if (project) return ['a11y', '-p', project];
  // Without a config the checker reads the markup files alone.
  return inputs.hasMarkup ? ['a11y', '-p', '.'] : null;
}

function scanTasks(
  target: SourceTarget | undefined,
  watching: boolean,
  inputs: FolderInputs,
  configless: ConfiglessInputs | undefined,
): ScanTask[] {
  const project = target?.project;
  const sourceArgs = (command: string) => (project ? [command, '-p', project] : null);
  const hasMaintainabilityInput = Boolean(project) || inputs.hasSource;
  const securityArgs = project ? sourceArgs('sec') : configless?.hasInfrastructure ? ['sec', '-p', '.'] : null;
  return [
    { id: perf, source: perf, args: sourceArgs('perf'), watchProject: watching ? project : undefined },
    // The watcher reports reliability and accessibility with performance, under the perf label whose fix commands still apply them.
    { id: perf + '-reliability', source: perf, args: watching ? null : sourceArgs('rel') },
    // The watcher reads only the TypeScript program, so templates still need a scan of their own.
    watching
      ? {
          id: perf + '-accessibility',
          source: perf,
          args: inputs.hasMarkup ? sourceArgs('a11y') : null,
          markupOnly: true,
        }
      : { id: perf + '-accessibility', source: perf, args: accessibilityArgs(project, inputs) },
    { id: maint, source: maint, args: hasMaintainabilityInput ? ['maint', '.'] : null },
    { id: sec, source: sec, args: securityArgs },
    { id: perf + '-polyglot', source: perf, args: inputs.hasPolyglot ? ['perf', 'polyglot', '.'] : null },
    { id: perf + '-polyglot-reliability', source: perf, args: inputs.hasPolyglot ? ['rel', 'polyglot', '.'] : null },
    { id: sec + '-polyglot', source: sec, args: inputs.hasPolyglot ? ['sec', 'polyglot', '.'] : null },
  ];
}

function createScanSession(options: ScanSessionOptions): ScanSession {
  const { root, name } = options;
  const disposed = new AbortController();
  const reports = new Map<string, CheckerReport>();
  let revision = 0;
  let scannedRevision = -1;
  let running: Promise<void> | undefined;
  let timer: NodeJS.Timeout | undefined;
  let activeScan: AbortController | undefined;
  let scanning = false;
  let restartRequested = false;
  let perfWatch: ActivePerfWatch | undefined;
  // Set when the watcher dies; full rescans take over until a config change restarts it.
  let watchUnavailable = false;
  let inputs: Promise<FolderInputs> | undefined;
  let configless: ConfiglessInputs | undefined;
  // Scans finished in a terminal ask the editor to refresh through the shared signal folder.
  const refreshListener = listenForEditorRefresh(root, () => schedule());

  function log(id: string, text: string): void {
    options.log(name + ' / ' + id + ' — ' + text);
  }
  function logError(id: string, text: string): void {
    options.logError(name + ' / ' + id + ' — ' + text);
  }
  function show(id: string, source: string, findings: Finding[]): void {
    reports.set(id, { source, findings });
    log(id, findings.length + ' finding(s)');
    options.onReports();
    options.onStatus();
  }
  function clear(id: string): void {
    if (reports.delete(id)) options.onReports();
  }
  function stopWatch(): void {
    perfWatch?.handle?.stop();
    perfWatch = undefined;
  }
  function ensureWatch(script: string, project: string, restart: boolean): void {
    const key = script + '\0' + project;
    if (perfWatch?.key === key && !restart) return;
    stopWatch();
    const current: ActivePerfWatch = { key, pending: true };
    current.handle = startPerfWatch({
      script,
      project,
      cwd: root,
      env: scanEnv,
      onFindings(findings: Finding[]) {
        if (perfWatch !== current) return;
        current.pending = false;
        show(perf, perf, findings);
      },
      onError(error: Error) {
        if (perfWatch !== current) return;
        // A config or project error produces no report; stop showing the scan as in progress.
        current.pending = false;
        logError(perf, error.message);
        options.onStatus();
      },
      onExit(error: Error) {
        if (perfWatch !== current) return;
        perfWatch = undefined;
        watchUnavailable = true;
        logError(perf, error.message + ' Falling back to full rescans after each change.');
        schedule();
      },
    });
    perfWatch = current;
    log(perf, 'watching ' + project + ' incrementally (process ' + current.handle.pid + ')');
    options.onStatus();
  }
  async function probeInputs(): Promise<FolderInputs> {
    const [hasSource, hasPolyglot, hasMarkup] = await Promise.all([
      hasFileWithSuffix(root, sourceSuffixes),
      hasFileWithSuffix(root, polyglotSuffixes),
      hasFileWithSuffix(root, markupSuffixes),
    ]);
    return { hasSource, hasPolyglot, hasMarkup };
  }
  async function sourceTarget(setting: string): Promise<SourceTarget | undefined> {
    const target = await configTarget(root, setting);
    if (target) return target;
    configless ??= probeConfiglessInputs(root);
    return configless.hasSources ? { project: '.', watchable: false } : undefined;
  }
  async function runTask(task: ScanTask, script: string, restart: boolean, scanSignal: AbortSignal) {
    if (!task.args) return clear(task.id);
    if (!path.isAbsolute(script)) throw new Error('The loadwise.cli setting must be an absolute path.');
    if (task.watchProject !== undefined) return ensureWatch(script, task.watchProject, restart);
    const findings = await readFindings(script, task.args, root, scanSignal);
    if (scanSignal.aborted || disposed.signal.aborted) return;
    show(
      task.id,
      task.source,
      task.markupOnly ? findings.filter(({ file }) => file !== undefined && isMarkupFile(file)) : findings,
    );
  }
  async function scan(version: number, scanSignal: AbortSignal): Promise<void> {
    const restart = restartRequested;
    restartRequested = false;
    if (restart) watchUnavailable = false;
    const settings = options.settings();
    if (!settings.enabled) {
      stopWatch();
      for (const id of reports.keys()) clear(id);
      return;
    }
    const target = await sourceTarget(settings.project);
    const watching = Boolean(target?.watchable) && !watchUnavailable;
    if (!watching) stopWatch();
    inputs ??= probeInputs();
    const tasks = scanTasks(target, watching, await inputs, configless);
    const script = settings.cli || options.defaultCli;
    for (const task of tasks) {
      if (disposed.signal.aborted || version !== revision) return;
      try {
        await runTask(task, script, restart, scanSignal);
      } catch (error) {
        if (disposed.signal.aborted || version !== revision) return;
        clear(task.id);
        logError(task.id, messageOf(error));
      }
    }
  }
  async function runScan(): Promise<void> {
    const version = revision;
    if (disposed.signal.aborted || version === scannedRevision) return;
    scannedRevision = version;
    activeScan = new AbortController();
    scanning = true;
    options.onStatus();
    try {
      await scan(version, activeScan.signal);
    } catch (error) {
      if (!disposed.signal.aborted && version === revision) options.logError(name + ' — ' + messageOf(error));
    } finally {
      activeScan = undefined;
      scanning = false;
      options.onStatus();
    }
  }
  function start(): Promise<void> {
    clearTimeout(timer);
    // A stale scan is aborted by schedule(); wait for it to wind down, then scan the newest state
    // once.
    const previous = running;
    const current: Promise<void> = (previous ?? Promise.resolve()).then(runScan).finally(() => {
      if (running === current) running = undefined;
    });
    running = current;
    return current;
  }
  function schedule({ restart = false, filesAddedOrRemoved = false } = {}): void {
    if (disposed.signal.aborted) return;
    restartRequested ||= restart;
    if (restart || filesAddedOrRemoved) {
      inputs = undefined;
      configless = undefined;
    }
    revision++;
    clearTimeout(timer);
    activeScan?.abort();
    // A config change makes the running watcher stale too; the debounced follow-up starts a fresh
    // one.
    if (restart) stopWatch();
    timer = setTimeout(start, debounceMs);
  }
  return {
    schedule,
    scanNow() {
      schedule({ restart: true });
      return start();
    },
    reports: () => reports.values(),
    isScanning: () => scanning || Boolean(perfWatch?.pending),
    watcherPid: () => perfWatch?.handle?.pid,
    dispose() {
      clearTimeout(timer);
      disposed.abort();
      activeScan?.abort();
      stopWatch();
      refreshListener.close();
    },
  };
}

export { createScanSession };
