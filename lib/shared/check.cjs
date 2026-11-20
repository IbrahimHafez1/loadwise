'use strict';

// `loadwise check`: runs both checkers in parallel child processes, so each keeps its own process-wide state and
// output, then prints both reports and merges their exit codes.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { parseArgs } = require('node:util');

const cli = path.resolve(__dirname, '../../bin/loadwise.cjs');
const projectConfigs = ['tsconfig.json', 'jsconfig.json'];
const invalidInputCode = 2;
const thresholdMetCode = 1;

function parseCheckArgs(args) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      help: { type: 'boolean', short: 'h' },
      json: { type: 'boolean' },
      'include-contextual': { type: 'boolean' },
      staged: { type: 'boolean' },
      'changed-since': { type: 'string' },
      'fail-on': { type: 'string' },
    },
  });
  if (positionals.length > 1) throw new Error('check accepts at most one directory.');
  if (values['fail-on'] !== undefined && !['all', 'contract'].includes(values['fail-on'])) {
    throw new Error('--fail-on must be all or contract.');
  }
  if (values.staged && values['changed-since'] !== undefined) {
    throw new Error('Choose either --staged or --changed-since.');
  }
  const directory = path.resolve(positionals[0] ?? '.');
  if (!fs.statSync(directory, { throwIfNoEntry: false })?.isDirectory())
    throw new Error('Expected a project directory.');
  return { values, directory };
}

// The flags both checkers accept with the same meaning.
function sharedArgs(values) {
  return [
    ...(values.json ? ['--json'] : []),
    ...(values['include-contextual'] ? ['--include-contextual'] : []),
    ...(values.staged ? ['--staged'] : []),
    ...(values['changed-since'] !== undefined ? ['--changed-since', values['changed-since']] : []),
    ...(values['fail-on'] !== undefined ? ['--fail-on', values['fail-on']] : []),
  ];
}

function projectConfig(directory) {
  return projectConfigs
    .map((name) => path.join(directory, name))
    .find((filename) => fs.statSync(filename, { throwIfNoEntry: false })?.isFile());
}

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

// A checker that was skipped, failed or had no changed files to check prints no report.
function parsedReport(run) {
  if (!run || run.code === invalidInputCode || !run.stdout.trim()) return null;
  return JSON.parse(run.stdout);
}

function printSection(title, run) {
  if (!run) return;
  console.log(`== ${title} ==`);
  process.stdout.write(run.stdout || 'Nothing to check.\n');
  process.stderr.write(run.stderr);
}

function combinedExitCode(runs) {
  const codes = runs.filter(Boolean).map(({ code }) => code);
  if (codes.some((code) => code !== 0 && code !== thresholdMetCode)) return invalidInputCode;
  return codes.includes(thresholdMetCode) ? thresholdMetCode : 0;
}

async function runCheck(args, usage) {
  const { values, directory } = parseCheckArgs(args);
  if (values.help) {
    console.log(usage);
    return 0;
  }
  const config = projectConfig(directory);
  if (!config) {
    console.error(`Note: no ${projectConfigs.join(' or ')} in ${directory}; skipped the performance checker.`);
  }
  const flags = sharedArgs(values);
  const [performance, maintainability] = await Promise.all([
    config ? runChecker(['perf', '-p', config, ...flags]) : undefined,
    runChecker(['maint', directory, ...flags]),
  ]);
  if (values.json) {
    for (const run of [performance, maintainability]) process.stderr.write(run?.stderr ?? '');
    const report = { performance: parsedReport(performance), maintainability: parsedReport(maintainability) };
    console.log(JSON.stringify(report, null, 2));
  } else {
    printSection('Performance', performance);
    printSection('Maintainability', maintainability);
  }
  return combinedExitCode([performance, maintainability]);
}

module.exports = { runCheck };
