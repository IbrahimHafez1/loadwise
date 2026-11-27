// The checkers `loadwise check` can run, in report order. Each runs as a child process of the loadwise CLI, so it keeps
// its own process-wide state and output. A new checker registers by adding one entry here.
import path from 'node:path';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { allowedHeapMegabytes, childHeapFlags, isHeapExhaustion } from './heap-limit.js';
import { coveringConfig, discoverWorkspaces, projectConfig, plainJavaScriptSources } from './workspaces.js';
import type { Finding } from './types.js';
import type { PillarName } from './types/pillar-name.js';
import type { ChildRun, PillarDefinition, PillarRunOptions } from './types/checker-run.js';
import { cachedRun } from './scan-cache.js';
import { isRecord } from './is-record.js';
import { rulesByPillar } from './rule-registry.js';
import { hasInfrastructureFiles } from '../security/files/index.js';
import { hasFrontendSourcesInWorkspaces } from '../accessibility/frontend-detect.js';

/** The reports of the source checkers when one child ran them together. */
interface SharedRun {
  reports: Partial<Record<PillarName, ChildRun | undefined>>;
}

/** The checkers that can share one type-checked Program through `--with`. */
const sourcePillarNames: ReadonlySet<string> = new Set(['perf', 'rel', 'sec', 'a11y']);

interface FindingsReport {
  findings: Finding[];
  [detail: string]: unknown;
}

function isFindingsReport(value: unknown): value is FindingsReport {
  return isRecord(value) && Array.isArray(value.findings);
}

/** What the source checkers print together under `--with`: one run per selected checker. */
type SharedEnvelope = Partial<Record<PillarName, ChildRun>>;

function isChildRun(value: unknown): value is ChildRun {
  return (
    isRecord(value) &&
    typeof value.code === 'number' &&
    typeof value.stdout === 'string' &&
    (value.stderr === undefined || typeof value.stderr === 'string')
  );
}

function isSharedEnvelope(value: unknown, keys: readonly PillarName[]): value is SharedEnvelope {
  return isRecord(value) && keys.every((key) => isChildRun(value[key]));
}

// "performance and security", or "performance, reliability and security".
function titleList(names: readonly string[]): string {
  const titles = names.map((name) => pillars.find((pillar) => pillar.name === name)?.title.toLowerCase() ?? name);
  return titles.length < 2 ? titles.join('') : `${titles.slice(0, -1).join(', ')} and ${titles[titles.length - 1]}`;
}

const cli = path.resolve(import.meta.dirname, '../../bin/loadwise.js');
const invalidInputCode = 2;

// An unchanged project replays the stored report; see scan-cache.cjs for what invalidates it.
function runChecker(args: readonly string[], cwd = process.cwd()): Promise<ChildRun> {
  return cachedRun(args, cwd, () => spawnChecker(args, cwd));
}

// Names the checker a child ran, for messages about it.
function checkerLabel(args: readonly string[]): string {
  const withIndex = args.indexOf('--with');
  if (withIndex >= 0) return `${titleList([args[0], ...(args[withIndex + 1] ?? '').split(',')])} checkers`;
  const pillar = pillars.find(({ name }) => name === args[0]);
  return `${pillar ? pillar.title.toLowerCase() : args[0]} checker`;
}

function heapExhaustionMessage(args: readonly string[], heapFlags: readonly string[]): string {
  return (
    `The ${checkerLabel(args)} ran out of memory (allowed ${allowedHeapMegabytes(heapFlags)} MB). ` +
    'Raise the limit with NODE_OPTIONS=--max-old-space-size=<megabytes> and run again.\n'
  );
}

function spawnChecker(args: readonly string[], cwd: string): Promise<ChildRun> {
  return new Promise<ChildRun>((resolve) => {
    // The parent owns the review and its scope, including when several checkers run in child
    // processes.
    const heapFlags = childHeapFlags();
    const child = spawn(process.execPath, [...heapFlags, cli, ...args], {
      cwd,
      windowsHide: true,
      env: { ...process.env, LOADWISE_AGENT: '0' },
    });
    const maxOutputBytes = 64 * 1024 * 1024;
    let stdout = '';
    let stderr = '';
    let overflowed = false;
    child.stdout.setEncoding('utf8').on('data', (text: string) => {
      if (stdout.length + text.length > maxOutputBytes) {
        overflowed = true;
        child.kill('SIGKILL');
        return;
      }
      stdout += text;
    });
    child.stderr.setEncoding('utf8').on('data', (text: string) => {
      if (stderr.length + text.length <= maxOutputBytes) stderr += text;
    });
    child.on('error', (error: Error) =>
      resolve({ code: invalidInputCode, stdout, stderr: stderr + error.message + '\n' }),
    );
    child.on('close', (code, signal) => {
      if (overflowed) {
        resolve({ code: invalidInputCode, stdout: '', stderr: 'Checker output exceeded buffer limit.\n' });
        return;
      }
      if (isHeapExhaustion({ code, signal, stderr })) {
        resolve({ code: invalidInputCode, stdout: '', stderr: heapExhaustionMessage(args, heapFlags) });
        return;
      }
      resolve({ code: code ?? invalidInputCode, stdout, stderr });
    });
  });
}

// With --changed-since, API contract breaks join the reliability report: the same deploy-safety
// gate as migrations.
async function withContractChecks(
  perfRun: ChildRun | undefined,
  { directory, contractFlags }: PillarRunOptions,
): Promise<ChildRun | undefined> {
  if (!contractFlags) return perfRun;
  const contracts = await runChecker(['rel', 'contracts', ...contractFlags, '--report-root', process.cwd()], directory);
  if (!perfRun) return contracts;
  const code = [perfRun.code, contracts.code].includes(invalidInputCode)
    ? invalidInputCode
    : Math.max(perfRun.code, contracts.code);
  const stderr = perfRun.stderr + contracts.stderr;
  if (contracts.code === invalidInputCode) return { ...perfRun, code, stderr };
  if (!contractFlags.includes('--json')) return { code, stdout: perfRun.stdout + contracts.stdout, stderr };
  let perfReport: FindingsReport;
  let contractReport: FindingsReport;
  try {
    const parsedPerf: unknown = perfRun.stdout.trim() ? JSON.parse(perfRun.stdout) : { findings: [] };
    const parsedContract: unknown = JSON.parse(contracts.stdout);
    if (!isFindingsReport(parsedPerf) || !isFindingsReport(parsedContract)) {
      throw new Error('Malformed JSON report.');
    }
    perfReport = parsedPerf;
    contractReport = parsedContract;
  } catch {
    return {
      code: invalidInputCode,
      stdout: '',
      stderr: stderr || 'Checker produced invalid JSON output.\n',
    };
  }
  return {
    code,
    stdout: JSON.stringify({ ...perfReport, findings: [...perfReport.findings, ...contractReport.findings] }),
    stderr,
  };
}

// What `-p` names for the folder's own config. A tsconfig.json beside a jsconfig.json is passed as
// the folder, so the checker also scans the JavaScript only the jsconfig covers.
function ownProject(directory: string) {
  const config = projectConfig(directory);
  if (!config || path.basename(config) !== 'tsconfig.json') return config;
  return fs.existsSync(path.join(directory, 'jsconfig.json')) ? directory : config;
}

// `command` is perf, rel or a11y, which run the same source check.
function runSourceChecker(
  command: 'perf' | 'rel' | 'a11y',
  { directory, flags, workspaces, relative }: PillarRunOptions,
): Promise<ChildRun | undefined> {
  const workspaceFlags = workspaces.flatMap((selector: string) => ['--workspace', selector]);
  const config = ownProject(directory);
  if (config && !workspaces.length) return runChecker([command, '-p', relative(config), ...flags]);
  // A monorepo root has no config of its own; the checker then checks each package's config. A
  // folder inside a package is checked with the ancestor config that covers it, and reports only its
  // own files.
  if (
    workspaces.length ||
    discoverWorkspaces(directory).packages.length ||
    plainJavaScriptSources(directory) ||
    coveringConfig(directory)
  ) {
    return runChecker([command, '-p', relative(directory), ...workspaceFlags, ...flags]);
  }
  console.error(
    `Note: no tsconfig.json or jsconfig.json in ${directory}, and no workspace package has one; skipped the ${titleList([command])} checker.`,
  );
  return Promise.resolve(undefined);
}

const noFrontendNote = (directory: string): string =>
  `Note: no frontend sources (JSX, HTML, Vue, Svelte or Angular templates) in ${directory}; skipped the accessibility checker.`;

// A project of plain markup has no tsconfig.json; the checker then reads its markup files alone.
function runAccessibilityChecker(options: PillarRunOptions): Promise<ChildRun | undefined> {
  if (!hasFrontendSourcesInWorkspaces(options.directory, options.workspaces)) {
    console.error(noFrontendNote(options.directory));
    return Promise.resolve(undefined);
  }
  const { directory, flags, workspaces, relative } = options;
  const workspaceFlags = workspaces.flatMap((selector: string) => ['--workspace', selector]);
  const config = ownProject(directory);
  if (config && !workspaces.length) return runChecker(['a11y', '-p', relative(config), ...flags]);
  return runChecker(['a11y', '-p', relative(directory), ...workspaceFlags, ...flags]);
}

function runSecurityDependencies({ directory, flags, relative }: PillarRunOptions): Promise<ChildRun> {
  // Lockfile findings cover the pinned versions, regardless of which source lines changed.
  const dependencyFlags: string[] = [];
  for (let index = 0; index < flags.length; index++) {
    if (flags[index] === '--staged') continue;
    if (flags[index] === '--changed-since') index++;
    else dependencyFlags.push(flags[index]);
  }
  return runChecker(['sec', 'deps', '--online', relative(directory), ...dependencyFlags]);
}

function runFileSecurity(options: PillarRunOptions): Promise<ChildRun | undefined> | undefined {
  const { directory, relative, flags, online, workspaces } = options;
  if (hasInfrastructureFiles(directory)) {
    const workspaceFlags = workspaces.flatMap((selector: string) => ['--workspace', selector]);
    return runChecker(['sec', '-p', relative(directory), ...workspaceFlags, ...flags, ...(online ? ['--online'] : [])]);
  }
  if (online) return runSecurityDependencies(options);
}

// findingRoot is the folder the checker's finding paths are relative to. Each run receives {
// directory, flags, relative } and resolves to the child's { code, stdout, stderr }, or to
// undefined when the pillar does not apply to the directory.
const pillars: PillarDefinition[] = [
  {
    name: 'perf',
    title: 'Performance',
    jsonKey: 'performance',
    ruleIds: () => rulesByPillar.performance.knownRules,
    findingRoot: () => process.cwd(),
    run: (options: PillarRunOptions) => runSourceChecker('perf', options),
  },
  {
    name: 'rel',
    title: 'Reliability',
    jsonKey: 'reliability',
    ruleIds: () => rulesByPillar.reliability.knownRules,
    findingRoot: () => process.cwd(),
    async run(options: PillarRunOptions) {
      return withContractChecks(await runSourceChecker('rel', options), options);
    },
  },
  {
    name: 'maint',
    title: 'Maintainability',
    jsonKey: 'maintainability',
    ruleIds: () => rulesByPillar.maintainability.knownRules,
    findingRoot: (directory: string) => directory,
    run: ({ directory, flags, workspaces, relative }) =>
      runChecker([
        'maint',
        relative(directory),
        ...workspaces.flatMap((selector: string) => ['--workspace', selector]),
        ...flags,
      ]),
  },
  {
    name: 'sec',
    title: 'Security',
    jsonKey: 'security',
    ruleIds: () => rulesByPillar.security.knownRules,
    findingRoot: () => process.cwd(),
    run({ directory, flags, relative, workspaces, online }) {
      const config = ownProject(directory);
      const onlineFlags = online ? ['--online'] : [];
      if (config && !workspaces.length) return runChecker(['sec', '-p', relative(config), ...flags, ...onlineFlags]);
      if (
        workspaces.length ||
        discoverWorkspaces(directory).packages.length ||
        plainJavaScriptSources(directory) ||
        coveringConfig(directory)
      ) {
        const workspaceFlags = workspaces.flatMap((selector: string) => ['--workspace', selector]);
        return runChecker(['sec', '-p', relative(directory), ...workspaceFlags, ...flags, ...onlineFlags]);
      }
      const fileSecurity = runFileSecurity({ directory, flags, relative, online, workspaces });
      if (fileSecurity) return fileSecurity;
      console.error(`Note: no tsconfig.json or jsconfig.json in ${directory}; skipped the security checker.`);
      return Promise.resolve(undefined);
    },
  },
  {
    name: 'a11y',
    title: 'Accessibility',
    jsonKey: 'accessibility',
    optional: true,
    ruleIds: () => rulesByPillar.accessibility.knownRules,
    findingRoot: () => process.cwd(),
    run: (options: PillarRunOptions) => runAccessibilityChecker(options),
  },
];

const pillarNames: readonly string[] = pillars.map(({ name }) => name);

function namesIn(list: string, flag: string): Set<string> {
  const names = new Set(
    list
      .split(',')
      .map((name: string) => name.trim())
      .filter(Boolean),
  );
  for (const name of names) {
    if (!pillarNames.includes(name)) throw new Error(`Unknown ${flag} name "${name}"; use ${pillarNames.join(', ')}.`);
  }
  return names;
}

// Resolves --only and --skip to the registered pillars to run, in report order.
function selectPillars({ only, skip }: { only?: string; skip?: string }): PillarDefinition[] {
  if (only !== undefined && skip !== undefined) throw new Error('Choose either --only or --skip.');
  if (only !== undefined) {
    const chosen = namesIn(only, '--only');
    if (!chosen.size) throw new Error('--only needs at least one name.');
    return pillars.filter(({ name }) => chosen.has(name));
  }
  const skipped = skip === undefined ? new Set<string>() : namesIn(skip, '--skip');
  const selected = pillars.filter(({ name }) => !skipped.has(name));
  if (!selected.length) throw new Error('--skip leaves nothing to check.');
  return selected;
}

// Every rule id of every registered pillar, which is what the config file and --ignore may name.
function registeredRuleIds() {
  return new Set(pillars.flatMap((pillar) => [...pillar.ruleIds()]));
}

// perf, rel and sec read the same project, so when two or more are selected one child type-checks it
// once and prints every report as { performance: { code, stdout }, reliability: ..., security: ... }.
// Resolves to one run per selected pillar.
async function runPillars(
  selected: readonly PillarDefinition[],
  options: (pillar: PillarDefinition) => PillarRunOptions,
): Promise<(ChildRun | undefined)[]> {
  const shared = selected.filter(
    (pillar) =>
      sourcePillarNames.has(pillar.name) &&
      (pillar.name !== 'a11y' || hasFrontendSourcesInWorkspaces(options(pillar).directory, options(pillar).workspaces)),
  );
  if (shared.length < 2) return Promise.all(selected.map((pillar) => pillar.run(options(pillar))));
  const sharedRun = runSharedSourceCheck(shared, options);
  const runs = await Promise.all(
    selected.map((pillar) => (shared.includes(pillar) ? sharedRun : pillar.run(options(pillar)))),
  );
  return runs.map((run, index) => (run && 'reports' in run ? run.reports[selected[index].jsonKey] : run));
}

// Without a source config only the parts that need none still run: security's file checks, reliability's API
// contract checks and accessibility's markup files.
async function runWithoutSourceConfig(
  shared: readonly PillarDefinition[],
  options: (pillar: PillarDefinition) => PillarRunOptions,
  directory: string,
): Promise<SharedRun> {
  const security = shared.find(({ name }) => name === 'sec');
  const fileSecurity = security && runFileSecurity(options(security));
  const needsConfig = shared.filter(({ name }) => name !== 'a11y').map(({ name }) => name);
  const skipped = fileSecurity ? 'the source checks' : `the ${titleList(needsConfig)} checkers`;
  console.error(`Note: no tsconfig.json or jsconfig.json in ${directory}; skipped ${skipped}.`);
  const runs = await Promise.all(
    shared.map((pillar) => {
      if (pillar.name === 'sec') return fileSecurity;
      if (pillar.name === 'rel') return withContractChecks(undefined, options(pillar));
      if (pillar.name === 'a11y') return runAccessibilityChecker(options(pillar));
      return undefined;
    }),
  );
  return { reports: Object.fromEntries(shared.map((pillar, index) => [pillar.jsonKey, runs[index]])) };
}

async function runSharedSourceCheck(
  shared: readonly PillarDefinition[],
  options: (pillar: PillarDefinition) => PillarRunOptions,
): Promise<SharedRun> {
  // The child that runs the shared pass is a perf-engine command; security's own command does not take --with.
  const primary = shared.find(({ name }) => name !== 'sec') ?? shared[0];
  const others = shared.filter((pillar) => pillar !== primary);
  const primaryOptions = options(primary);
  const { directory, flags, relative, workspaces } = primaryOptions;
  const config = ownProject(directory);
  if (
    !workspaces.length &&
    !config &&
    !discoverWorkspaces(directory).packages.length &&
    !plainJavaScriptSources(directory) &&
    !coveringConfig(directory)
  ) {
    return runWithoutSourceConfig(shared, options, directory);
  }
  const workspaceFlags = workspaces.flatMap((selector: string) => ['--workspace', selector]);
  // Each pillar's options carry only its own --ignore ids, so the shared child receives all of them.
  const sharedFlags = [...flags];
  for (const other of others) {
    const otherFlags = options(other).flags;
    for (let index = 0; index < otherFlags.length; index++) {
      if (otherFlags[index] === '--ignore') sharedFlags.push('--ignore', otherFlags[++index]);
    }
  }
  const security = shared.find(({ name }) => name === 'sec');
  const run = await runChecker([
    primary.name,
    '-p',
    relative(config && !workspaces.length ? config : directory),
    ...workspaceFlags,
    '--with',
    others.map(({ name }) => name).join(','),
    ...sharedFlags,
    ...(security && options(security).online ? ['--online'] : []),
  ]);
  const keys = shared.map(({ jsonKey }) => jsonKey);
  const failed: ChildRun = { code: run.code === 0 ? invalidInputCode : run.code, stdout: '', stderr: run.stderr };
  let envelope: SharedEnvelope;
  try {
    const parsed: unknown = JSON.parse(run.stdout);
    if (!isSharedEnvelope(parsed, keys)) throw new Error('Malformed shared envelope.');
    envelope = parsed;
  } catch {
    return {
      reports: Object.fromEntries(keys.map((key, index) => [key, index ? { ...failed, stderr: '' } : failed])),
    };
  }
  // The child's warnings belong to the run once, so they print with the first report.
  const reports = await Promise.all(
    shared.map(async (pillar, index): Promise<ChildRun | undefined> => {
      const report = envelope[pillar.jsonKey];
      if (!report) return undefined;
      const own: ChildRun = { ...report, stderr: index ? '' : run.stderr };
      return pillar.name === 'rel' ? withContractChecks(own, options(pillar)) : own;
    }),
  );
  return { reports: Object.fromEntries(keys.map((key, index) => [key, reports[index]])) };
}

export { pillarNames, pillars, registeredRuleIds, selectPillars, runPillars, runChecker };
