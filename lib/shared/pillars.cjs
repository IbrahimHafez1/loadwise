'use strict';

// The checkers `loadwise check` can run, in report order. Each runs as a child process of the loadwise CLI, so it keeps
// its own process-wide state and output. A new checker registers by adding one entry here.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const cli = path.resolve(__dirname, '../../bin/loadwise.cjs');
const projectConfigs = ['tsconfig.json', 'jsconfig.json'];
const invalidInputCode = 2;

function runChecker(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], { windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (text) => (stdout += text));
    child.stderr.setEncoding('utf8').on('data', (text) => (stderr += text));
    child.on('error', (error) => resolve({ code: invalidInputCode, stdout, stderr: stderr + error.message + '\n' }));
    child.on('close', (code) => resolve({ code: code ?? invalidInputCode, stdout, stderr }));
  });
}

function projectConfig(directory) {
  return projectConfigs
    .map((name) => path.join(directory, name))
    .find((filename) => fs.statSync(filename, { throwIfNoEntry: false })?.isFile());
}

// Each run receives { directory, flags, relative } and resolves to the child's { code, stdout, stderr }, or to
// undefined when the pillar does not apply to the directory.
const pillars = [
  {
    name: 'perf',
    title: 'Performance',
    jsonKey: 'performance',
    run({ directory, flags, relative }) {
      const config = projectConfig(directory);
      if (config) return runChecker(['perf', '-p', relative(config), ...flags]);
      console.error(`Note: no ${projectConfigs.join(' or ')} in ${directory}; skipped the performance checker.`);
      return Promise.resolve(undefined);
    },
  },
  {
    name: 'maint',
    title: 'Maintainability',
    jsonKey: 'maintainability',
    run: ({ directory, flags, relative }) => runChecker(['maint', relative(directory), ...flags]),
  },
  {
    name: 'sec',
    title: 'Security',
    jsonKey: 'security',
    run({ directory, flags, relative }) {
      const config = projectConfig(directory);
      if (config) return runChecker(['sec', '-p', relative(config), ...flags]);
      console.error(`Note: no ${projectConfigs.join(' or ')} in ${directory}; skipped the security checker.`);
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

// perf and sec read the same project, so when both are selected one child type-checks it once and prints both reports
// as { performance: { code, stdout }, security: { code, stdout } }. Resolves to one run per selected pillar.
async function runPillars(selected, options) {
  const names = selected.map(({ name }) => name);
  if (!names.includes('perf') || !names.includes('sec'))
    return Promise.all(selected.map((pillar) => pillar.run(options)));
  const sharedRun = runSharedSourceCheck(options);
  const runs = await Promise.all(
    selected.map((pillar) => (pillar.name === 'perf' || pillar.name === 'sec' ? sharedRun : pillar.run(options))),
  );
  return runs.map((run, index) => (run && run.reports ? run.reports[selected[index].jsonKey] : run));
}

async function runSharedSourceCheck({ directory, flags, relative }) {
  const config = projectConfig(directory);
  if (!config) {
    console.error(
      `Note: no ${projectConfigs.join(' or ')} in ${directory}; skipped the performance and security checkers.`,
    );
    return undefined;
  }
  const run = await runChecker(['perf', '-p', relative(config), '--with', 'sec', ...flags]);
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
      performance: { ...envelope.performance, stderr: run.stderr },
      security: { ...envelope.security, stderr: '' },
    },
  };
}

module.exports = { selectPillars, runPillars, runChecker };
