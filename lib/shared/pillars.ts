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
import { knownRules } from '../performance/rule-ids.js';
import { knownRules as knownRulesRuleIds } from '../maintainability/rule-ids.js';
import { securityRules } from '../security/rule-ids.js';
import { hasInfrastructureFiles } from '../security/files/index.js';

/** The reports of perf and sec when one child ran both. */
interface SharedRun {
  reports: Partial<Record<PillarName, ChildRun | undefined>>;
}

interface FindingsReport {
  findings: Finding[];
  [detail: string]: unknown;
}

/** What perf and sec print together under `--with sec`. */
interface SharedEnvelope {
  performance: ChildRun;
  security: ChildRun;
}

const cli = path.resolve(import.meta.dirname, '../../bin/loadwise.js');
const invalidInputCode = 2;

// An unchanged project replays the stored report; see scan-cache.cjs for what invalidates it.
function runChecker(args: readonly string[], cwd = process.cwd()): Promise<ChildRun> {
  return cachedRun(args, cwd, () => spawnChecker(args, cwd));
}

// Names the checker a child ran, for messages about it.
function checkerLabel(args: readonly string[]): string {
  if (args.includes('--with')) return 'performance and security checkers';
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

// With --changed-since, API contract breaks join the performance report: the same deploy-safety
// gate as migrations.
async function withContractChecks(
  perfRun: ChildRun | undefined,
  { directory, contractFlags }: PillarRunOptions,
): Promise<ChildRun | undefined> {
  if (!contractFlags) return perfRun;
  const contracts = await runChecker(
    ['perf', 'contracts', ...contractFlags, '--report-root', process.cwd()],
    directory,
  );
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
    perfReport = perfRun.stdout.trim() ? JSON.parse(perfRun.stdout) : { findings: [] };
    contractReport = JSON.parse(contracts.stdout);
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

function runPerformance({ directory, flags, workspaces, relative }: PillarRunOptions): Promise<ChildRun | undefined> {
  const workspaceFlags = workspaces.flatMap((selector: string) => ['--workspace', selector]);
  const config = ownProject(directory);
  if (config && !workspaces.length) return runChecker(['perf', '-p', relative(config), ...flags]);
  // A monorepo root has no config of its own; perf then checks each package's config. A folder
  // inside a package is checked with the ancestor config that covers it, and reports only its own
  // files.
  if (
    workspaces.length ||
    discoverWorkspaces(directory).packages.length ||
    plainJavaScriptSources(directory) ||
    coveringConfig(directory)
  ) {
    return runChecker(['perf', '-p', relative(directory), ...workspaceFlags, ...flags]);
  }
  console.error(
    `Note: no tsconfig.json or jsconfig.json in ${directory}, and no workspace package has one; skipped the performance checker.`,
  );
  return Promise.resolve(undefined);
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
    ruleIds: () => knownRules,
    findingRoot: () => process.cwd(),
    async run(options: PillarRunOptions) {
      return withContractChecks(await runPerformance(options), options);
    },
  },
  {
    name: 'maint',
    title: 'Maintainability',
    jsonKey: 'maintainability',
    ruleIds: () => knownRulesRuleIds,
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
    ruleIds: () => new Set(securityRules),
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

// perf and sec read the same project, so when both are selected one child type-checks it once and
// prints both reports as { performance: { code, stdout }, security: { code, stdout } }. Resolves to
// one run per selected pillar.
async function runPillars(
  selected: readonly PillarDefinition[],
  options: (pillar: PillarDefinition) => PillarRunOptions,
): Promise<(ChildRun | undefined)[]> {
  const perf = selected.find(({ name }) => name === 'perf');
  const security = selected.find(({ name }) => name === 'sec');
  if (!perf || !security) return Promise.all(selected.map((pillar) => pillar.run(options(pillar))));
  const perfOptions = options(perf);
  const secOptions = options(security);
  const sharedRun = runSharedSourceCheck(perfOptions, secOptions);
  const runs = await Promise.all(
    selected.map((pillar) =>
      pillar.name === 'perf' || pillar.name === 'sec' ? sharedRun : pillar.run(options(pillar)),
    ),
  );
  return runs.map((run, index) => (run && 'reports' in run ? run.reports[selected[index].jsonKey] : run));
}

async function runSharedSourceCheck(perfOptions: PillarRunOptions, secOptions: PillarRunOptions): Promise<SharedRun> {
  const { directory, flags, relative, workspaces } = perfOptions;
  const config = ownProject(directory);
  if (
    !workspaces.length &&
    !config &&
    !discoverWorkspaces(directory).packages.length &&
    !plainJavaScriptSources(directory) &&
    !coveringConfig(directory)
  ) {
    const fileSecurity = runFileSecurity(secOptions);
    const skipped = fileSecurity ? 'the source checks' : 'the performance and security checkers';
    console.error(`Note: no tsconfig.json or jsconfig.json in ${directory}; skipped ${skipped}.`);
    const [performance, security] = await Promise.all([withContractChecks(undefined, perfOptions), fileSecurity]);
    return { reports: { performance, security } };
  }
  const workspaceFlags = workspaces.flatMap((selector: string) => ['--workspace', selector]);
  const sharedFlags = [...flags];
  const secFlags = secOptions.flags;
  for (let index = 0; index < secFlags.length; index++) {
    if (secFlags[index] === '--ignore') sharedFlags.push('--ignore', secFlags[++index]);
  }
  const run = await runChecker([
    'perf',
    '-p',
    relative(config && !workspaces.length ? config : directory),
    ...workspaceFlags,
    '--with',
    'sec',
    ...sharedFlags,
    ...(secOptions.online ? ['--online'] : []),
  ]);
  const failed: ChildRun = { code: run.code === 0 ? invalidInputCode : run.code, stdout: '', stderr: run.stderr };
  let envelope: SharedEnvelope;
  try {
    envelope = JSON.parse(run.stdout);
  } catch {
    return { reports: { performance: failed, security: { ...failed, stderr: '' } } };
  }
  // The child's warnings belong to the run once, so they print with the first report.
  return {
    reports: {
      performance: await withContractChecks({ ...envelope.performance, stderr: run.stderr }, perfOptions),
      security: { ...envelope.security, stderr: '' },
    },
  };
}

export { pillarNames, pillars, registeredRuleIds, selectPillars, runPillars, runChecker };
