'use strict';

// The checkers `loadwise check` can run, in report order. Each runs as a child process of the loadwise CLI, so it keeps
// its own process-wide state and output. A new checker registers by adding one entry here.
const path = require('node:path');
const { spawn } = require('node:child_process');
const { discoverWorkspaces, projectConfig } = require('./workspaces.cjs');

const cli = path.resolve(__dirname, '../../bin/loadwise.cjs');
const invalidInputCode = 2;

function runChecker(args, cwd = process.cwd()) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (text) => (stdout += text));
    child.stderr.setEncoding('utf8').on('data', (text) => (stderr += text));
    child.on('error', (error) => resolve({ code: invalidInputCode, stdout, stderr: stderr + error.message + '\n' }));
    child.on('close', (code) => resolve({ code: code ?? invalidInputCode, stdout, stderr }));
  });
}

// With --changed-since, API contract breaks join the performance report: the same deploy-safety gate as migrations.
async function withContractChecks(perfRun, { directory, flags }) {
  const changedSince = flags.indexOf('--changed-since');
  if (changedSince < 0) return perfRun;
  const contractFlags = [flags[changedSince], flags[changedSince + 1], ...flags.filter((flag) => flag === '--json')];
  const contracts = await runChecker(['perf', 'contracts', ...contractFlags], directory);
  if (!perfRun) return contracts;
  const code = [perfRun.code, contracts.code].includes(invalidInputCode)
    ? invalidInputCode
    : Math.max(perfRun.code, contracts.code);
  const stderr = perfRun.stderr + contracts.stderr;
  if (contracts.code === invalidInputCode) return { ...perfRun, code, stderr };
  if (!flags.includes('--json')) return { code, stdout: perfRun.stdout + contracts.stdout, stderr };
  const perfReport = perfRun.stdout.trim() ? JSON.parse(perfRun.stdout) : { findings: [] };
  const { findings } = JSON.parse(contracts.stdout);
  return { code, stdout: JSON.stringify({ ...perfReport, findings: [...perfReport.findings, ...findings] }), stderr };
}

function runPerformance({ directory, flags, workspaces, relative }) {
  const workspaceFlags = workspaces.flatMap((selector) => ['--workspace', selector]);
  const config = projectConfig(directory);
  if (config && !workspaces.length) return runChecker(['perf', '-p', relative(config), ...flags]);
  // A monorepo root has no config of its own; perf then checks each package's config.
  if (discoverWorkspaces(directory).packages.length) {
    return runChecker(['perf', '-p', relative(directory), ...workspaceFlags, ...flags]);
  }
  console.error(
    `Note: no tsconfig.json or jsconfig.json in ${directory}, and no workspace package has one; skipped the performance checker.`,
  );
  return Promise.resolve(undefined);
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
    run({ directory, flags, relative }) {
      const config = projectConfig(directory);
      if (config) return runChecker(['sec', '-p', relative(config), ...flags]);
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
  const sharedRun = runSharedSourceCheck({ ...perfOptions, secFlags: secOptions.flags });
  const runs = await Promise.all(
    selected.map((pillar) =>
      pillar.name === 'perf' || pillar.name === 'sec' ? sharedRun : pillar.run(options(pillar)),
    ),
  );
  return runs.map((run, index) => (run && run.reports ? run.reports[selected[index].jsonKey] : run));
}

async function runSharedSourceCheck({ directory, flags, relative, workspaces, secFlags }) {
  const config = projectConfig(directory);
  if (!config && !discoverWorkspaces(directory).packages.length) {
    console.error(
      `Note: no tsconfig.json or jsconfig.json in ${directory}; skipped the performance and security checkers.`,
    );
    return undefined;
  }
  const workspaceFlags = workspaces.flatMap((selector) => ['--workspace', selector]);
  const sharedFlags = [...flags];
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
      performance: await withContractChecks({ ...envelope.performance, stderr: run.stderr }, { directory, flags }),
      security: { ...envelope.security, stderr: '' },
    },
  };
}

module.exports = { pillarNames, pillars, registeredRuleIds, selectPillars, runPillars };
