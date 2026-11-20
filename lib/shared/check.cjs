'use strict';

// `loadwise check`: runs the selected pillars in parallel, then prints their reports and merges their exit codes.
const fs = require('node:fs');
const path = require('node:path');
const { parseArgs } = require('node:util');
const { selectPillars, runPillars, runChecker } = require('./pillars.cjs');

const invalidInputCode = 2;
const thresholdMetCode = 1;

function parseCheckArgs(args) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      help: { type: 'boolean', short: 'h' },
      json: { type: 'boolean' },
      online: { type: 'boolean' },
      'include-contextual': { type: 'boolean' },
      staged: { type: 'boolean' },
      'changed-since': { type: 'string' },
      'fail-on': { type: 'string' },
      only: { type: 'string' },
      skip: { type: 'string' },
    },
  });
  if (positionals.length > 1) throw new Error('check accepts at most one directory.');
  if (values['fail-on'] !== undefined && !['all', 'contract'].includes(values['fail-on'])) {
    throw new Error('--fail-on must be all or contract.');
  }
  if (values.staged && values['changed-since'] !== undefined) {
    throw new Error('Choose either --staged or --changed-since.');
  }
  const selected = selectPillars(values);
  const directory = path.resolve(positionals[0] ?? '.');
  if (!fs.statSync(directory, { throwIfNoEntry: false })?.isDirectory())
    throw new Error('Expected a project directory.');
  return { values, directory, selected };
}

// The flags every checker accepts with the same meaning.
function sharedArgs(values) {
  return [
    ...(values.json ? ['--json'] : []),
    ...(values['include-contextual'] ? ['--include-contextual'] : []),
    ...(values.staged ? ['--staged'] : []),
    ...(values['changed-since'] !== undefined ? ['--changed-since', values['changed-since']] : []),
    ...(values['fail-on'] !== undefined ? ['--fail-on', values['fail-on']] : []),
  ];
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

// `--online` adds the lockfile's known-vulnerability findings to the security report; they come from `sec deps`,
// which the checkers' shared source run does not include.
async function addDependencyRun(security, { values, directory, relative }) {
  // Changed-line scoping does not apply to a lockfile.
  const flags = [
    ...(values.json ? ['--json'] : []),
    ...(values['include-contextual'] ? ['--include-contextual'] : []),
    ...(values['fail-on'] !== undefined ? ['--fail-on', values['fail-on']] : []),
  ];
  const run = await runChecker(['sec', 'deps', '--online', relative(directory), ...flags]);
  const code = [security?.code, run.code].includes(invalidInputCode)
    ? invalidInputCode
    : Math.max(security?.code ?? 0, run.code);
  const stderr = (security?.stderr ?? '') + run.stderr;
  if (!values.json)
    return { code, stderr, stdout: (security?.stdout ?? '') + (run.code === invalidInputCode ? '' : run.stdout) };
  if (run.code === invalidInputCode) return { code, stderr, stdout: security?.stdout ?? '' };
  const report = security?.stdout.trim() ? JSON.parse(security.stdout) : { scannedFiles: 0, findings: [] };
  const dependencies = JSON.parse(run.stdout);
  const contextualFindingCount = (report.contextualFindingCount ?? 0) + (dependencies.contextualFindingCount ?? 0);
  report.findings.push(...dependencies.findings);
  if (contextualFindingCount) report.contextualFindingCount = contextualFindingCount;
  return { code, stderr, stdout: JSON.stringify(report, null, 2) };
}

async function runCheck(args, usage) {
  const { values, directory, selected } = parseCheckArgs(args);
  if (values.help) {
    console.log(usage);
    return 0;
  }
  // Relative paths keep the fix commands the checkers print short and runnable from the same folder.
  const relative = (target) => path.relative(process.cwd(), target).split(path.sep).join('/') || '.';
  const options = { directory, flags: sharedArgs(values), relative };
  const runs = await runPillars(selected, options);
  const securityIndex = selected.findIndex(({ name }) => name === 'sec');
  if (securityIndex >= 0 && values.online) {
    runs[securityIndex] = await addDependencyRun(runs[securityIndex], { values, directory, relative });
  } else if (securityIndex >= 0 && selected.length > 1 && selected.some(({ name }) => name === 'perf')) {
    // The shared perf and security run never reaches `loadwise sec`, which prints this note itself.
    require('../security/deps/cli.cjs').noteOffline(directory);
  }
  if (values.json) {
    for (const run of runs) process.stderr.write(run?.stderr ?? '');
    const report = Object.fromEntries(selected.map((pillar, index) => [pillar.jsonKey, parsedReport(runs[index])]));
    console.log(JSON.stringify(report, null, 2));
  } else {
    selected.forEach((pillar, index) => printSection(pillar.title, runs[index]));
  }
  return combinedExitCode(runs);
}

module.exports = { runCheck };
