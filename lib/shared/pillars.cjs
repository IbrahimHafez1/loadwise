'use strict';

// The checkers `loadwise check` can run, in report order. Each runs as a child process of the loadwise CLI, so it keeps
// its own process-wide state and output. A new checker registers by adding one entry here.
const path = require('node:path');
const { spawn } = require('node:child_process');
const { discoverWorkspaces, projectConfig } = require('./workspaces.cjs');

const cli = path.resolve(__dirname, '../../bin/loadwise.cjs');
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

// Each run receives { directory, flags, relative } and resolves to the child's { code, stdout, stderr }, or to
// undefined when the pillar does not apply to the directory.
const pillars = [
  {
    name: 'perf',
    title: 'Performance',
    jsonKey: 'performance',
    run({ directory, flags, workspaces, relative }) {
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
    },
  },
  {
    name: 'maint',
    title: 'Maintainability',
    jsonKey: 'maintainability',
    run: ({ directory, flags, workspaces, relative }) =>
      runChecker([
        'maint',
        relative(directory),
        ...workspaces.flatMap((selector) => ['--workspace', selector]),
        ...flags,
      ]),
  },
];

// Names accepted by --only and --skip whose checker has not shipped yet.
const unavailablePillars = new Map([['sec', 'security checks are not available yet']]);

const pillarNames = [...pillars.map(({ name }) => name), ...unavailablePillars.keys()];

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
    for (const name of chosen) if (unavailablePillars.has(name)) throw new Error(unavailablePillars.get(name));
    if (!chosen.size) throw new Error('--only needs at least one name.');
    return pillars.filter(({ name }) => chosen.has(name));
  }
  const skipped = skip === undefined ? new Set() : namesIn(skip, '--skip');
  const selected = pillars.filter(({ name }) => !skipped.has(name));
  if (!selected.length) throw new Error('--skip leaves nothing to check.');
  return selected;
}

module.exports = { unavailablePillars, selectPillars };
