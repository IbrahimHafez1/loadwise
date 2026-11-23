'use strict';

// The checkers `loadwise check` can run, in report order. Each runs as a child process of the loadwise CLI, so it keeps
// its own process-wide state and output. A new checker registers by adding one entry here.
const path = require('node:path');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const { allowedHeapMegabytes, childHeapFlags, isHeapExhaustion } = require('./heap-limit.cjs');
const { coveringConfig, discoverWorkspaces, projectConfig, plainJavaScriptSources } = require('./workspaces.cjs');

const cli = path.resolve(__dirname, '../../bin/loadwise.cjs');
const invalidInputCode = 2;

// An unchanged project replays the stored report; see scan-cache.cjs for what invalidates it.
function runChecker(args, cwd = process.cwd()) {
  return require('./scan-cache.cjs').cachedRun(args, cwd, () => spawnChecker(args, cwd));
}

// Names the checker a child ran, for messages about it.
function checkerLabel(args) {
  if (args.includes('--with')) return 'performance and security checkers';
  const pillar = pillars.find(({ name }) => name === args[0]);
  return `${pillar ? pillar.title.toLowerCase() : args[0]} checker`;
}

function heapExhaustionMessage(args, heapFlags) {
  return (
    `The ${checkerLabel(args)} ran out of memory (allowed ${allowedHeapMegabytes(heapFlags)} MB). ` +
    'Raise the limit with NODE_OPTIONS=--max-old-space-size=<megabytes> and run again.\n'
  );
}

function spawnChecker(args, cwd) {
  return new Promise((resolve) => {
    // The parent owns the review and its scope, including when several checkers run in child processes.
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
    child.stdout.setEncoding('utf8').on('data', (text) => {
      if (stdout.length + text.length > maxOutputBytes) {
        overflowed = true;
        child.kill('SIGKILL');
        return;
      }
      stdout += text;
    });
    child.stderr.setEncoding('utf8').on('data', (text) => {
      if (stderr.length + text.length <= maxOutputBytes) stderr += text;
    });
    child.on('error', (error) => resolve({ code: invalidInputCode, stdout, stderr: stderr + error.message + '\n' }));
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

// With --changed-since, API contract breaks join the performance report: the same deploy-safety gate as migrations.
async function withContractChecks(perfRun, { directory, contractFlags }) {
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
  const perfReport = perfRun.stdout.trim() ? JSON.parse(perfRun.stdout) : { findings: [] };
  const { findings } = JSON.parse(contracts.stdout);
  return { code, stdout: JSON.stringify({ ...perfReport, findings: [...perfReport.findings, ...findings] }), stderr };
}

// What `-p` names for the folder's own config. A tsconfig.json beside a jsconfig.json is passed as the folder, so
// the checker also scans the JavaScript only the jsconfig covers.
function ownProject(directory) {
  const config = projectConfig(directory);
  if (!config || path.basename(config) !== 'tsconfig.json') return config;
  return fs.existsSync(path.join(directory, 'jsconfig.json')) ? directory : config;
}

function runPerformance({ directory, flags, workspaces, relative }) {
  const workspaceFlags = workspaces.flatMap((selector) => ['--workspace', selector]);
  const config = ownProject(directory);
  if (config && !workspaces.length) return runChecker(['perf', '-p', relative(config), ...flags]);
  // A monorepo root has no config of its own; perf then checks each package's config. A folder inside a package
  // is checked with the ancestor config that covers it, and reports only its own files.
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

function runSecurityDependencies({ directory, flags, relative }) {
  // Lockfile findings cover the pinned versions, regardless of which source lines changed.
  const dependencyFlags = [];
  for (let index = 0; index < flags.length; index++) {
    if (flags[index] === '--staged') continue;
    if (flags[index] === '--changed-since') index++;
    else dependencyFlags.push(flags[index]);
  }
  return runChecker(['sec', 'deps', '--online', relative(directory), ...dependencyFlags]);
}

function runFileSecurity(options) {
  const { directory, relative, flags, online, workspaces } = options;
  if (require('../security/files/index.cjs').hasInfrastructureFiles(directory)) {
    const workspaceFlags = workspaces.flatMap((selector) => ['--workspace', selector]);
    return runChecker(['sec', '-p', relative(directory), ...workspaceFlags, ...flags, ...(online ? ['--online'] : [])]);
  }
  if (online) return runSecurityDependencies(options);
}

// findingRoot is the folder the checker's finding paths are relative to.
// Each run receives { directory, flags, relative } and resolves to the child's { code, stdout, stderr }, or to
// undefined when the pillar does not apply to the directory.
const pillars = [
  {
    name: 'perf',
    title: 'Performance',
    jsonKey: 'performance',
    ruleIds: () => require('../performance/rule-ids.cjs').knownRules,
    findingRoot: () => process.cwd(),
    async run(options) {
      return withContractChecks(await runPerformance(options), options);
    },
  },
  {
    name: 'maint',
    title: 'Maintainability',
    jsonKey: 'maintainability',
    ruleIds: () => require('../maintainability/rule-ids.cjs').knownRules,
    findingRoot: (directory) => directory,
    run: ({ directory, flags, workspaces, relative }) =>
      runChecker([
        'maint',
        relative(directory),
        ...workspaces.flatMap((selector) => ['--workspace', selector]),
        ...flags,
      ]),
  },
  {
    name: 'sec',
    title: 'Security',
    jsonKey: 'security',
    ruleIds: () => new Set(require('../security/rule-ids.cjs').securityRules),
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
        const workspaceFlags = workspaces.flatMap((selector) => ['--workspace', selector]);
        return runChecker(['sec', '-p', relative(directory), ...workspaceFlags, ...flags, ...onlineFlags]);
      }
      const fileSecurity = runFileSecurity({ directory, flags, relative, online, workspaces });
      if (fileSecurity) return fileSecurity;
      console.error(`Note: no tsconfig.json or jsconfig.json in ${directory}; skipped the security checker.`);
      return Promise.resolve(undefined);
    },
  },
];

const pillarNames = pillars.map(({ name }) => name);

function namesIn(list, flag) {
  const names = new Set(
    list
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean),
  );
  for (const name of names) {
    if (!pillarNames.includes(name)) throw new Error(`Unknown ${flag} name "${name}"; use ${pillarNames.join(', ')}.`);
  }
  return names;
}

// Resolves --only and --skip to the registered pillars to run, in report order.
function selectPillars({ only, skip }) {
  if (only !== undefined && skip !== undefined) throw new Error('Choose either --only or --skip.');
  if (only !== undefined) {
    const chosen = namesIn(only, '--only');
    if (!chosen.size) throw new Error('--only needs at least one name.');
    return pillars.filter(({ name }) => chosen.has(name));
  }
  const skipped = skip === undefined ? new Set() : namesIn(skip, '--skip');
  const selected = pillars.filter(({ name }) => !skipped.has(name));
  if (!selected.length) throw new Error('--skip leaves nothing to check.');
  return selected;
}

// Every rule id of every registered pillar, which is what the config file and --ignore may name.
function registeredRuleIds() {
  return new Set(pillars.flatMap((pillar) => [...pillar.ruleIds()]));
}

// perf and sec read the same project, so when both are selected one child type-checks it once and prints both reports
// as { performance: { code, stdout }, security: { code, stdout } }. Resolves to one run per selected pillar.
async function runPillars(selected, options) {
  const names = selected.map(({ name }) => name);
  if (!names.includes('perf') || !names.includes('sec'))
    return Promise.all(selected.map((pillar) => pillar.run(options(pillar))));
  const perf = selected.find(({ name }) => name === 'perf');
  const security = selected.find(({ name }) => name === 'sec');
  const perfOptions = options(perf);
  const secOptions = options(security);
  const sharedRun = runSharedSourceCheck(perfOptions, secOptions);
  const runs = await Promise.all(
    selected.map((pillar) =>
      pillar.name === 'perf' || pillar.name === 'sec' ? sharedRun : pillar.run(options(pillar)),
    ),
  );
  return runs.map((run, index) => (run && run.reports ? run.reports[selected[index].jsonKey] : run));
}

async function runSharedSourceCheck(perfOptions, secOptions) {
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
  const workspaceFlags = workspaces.flatMap((selector) => ['--workspace', selector]);
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
  const failed = { code: run.code === 0 ? invalidInputCode : run.code, stdout: '', stderr: run.stderr };
  let envelope;
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

module.exports = { pillarNames, pillars, registeredRuleIds, selectPillars, runPillars, runChecker };
