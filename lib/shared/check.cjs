'use strict';

// `loadwise check`: runs the selected pillars in parallel, then prints their reports and merges their exit codes.
const fs = require('node:fs');
const path = require('node:path');
const { parseArgs } = require('node:util');
const { selectPillars } = require('./pillars.cjs');
const { extractBaselineFlags, resolveBaselineFile } = require('./baseline.cjs');

const invalidInputCode = 2;
const thresholdMetCode = 1;

function parseCheckArgs(args) {
  const { args: checkArgs, ...baselineOptions } = extractBaselineFlags(args);
  const { values, positionals } = parseArgs({
    args: checkArgs,
    allowPositionals: true,
    options: {
      help: { type: 'boolean', short: 'h' },
      json: { type: 'boolean' },
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
  if (baselineOptions.baseline && baselineOptions.writeBaseline) {
    throw new Error('Choose either --baseline or --write-baseline.');
  }
  if (baselineOptions.writeBaseline && (values.staged || values['changed-since'] !== undefined)) {
    throw new Error('--write-baseline records every finding; it cannot be combined with --staged or --changed-since.');
  }
  return { values, directory, selected, baselineOptions };
}

// The flags every checker accepts with the same meaning.
// Every checker gets the same absolute baseline file, so each fills its own section of it.
function baselineArgs({ baseline, writeBaseline }, directory) {
  const flag = writeBaseline ? '--write-baseline' : '--baseline';
  const option = writeBaseline ?? baseline;
  return option ? [flag, resolveBaselineFile(option, directory)] : [];
}

function sharedArgs(values, baselineOptions, directory) {
  return [
    ...baselineArgs(baselineOptions, directory),
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

// Writing a baseline rewrites the one shared file, so the checkers must not do it at the same time.
async function runInSequence(selected, options) {
  const runs = [];
  for (const pillar of selected) runs.push(await pillar.run(options));
  return runs;
}

function runInParallel(selected, options) {
  return Promise.all(selected.map((pillar) => pillar.run(options)));
}

async function runCheck(args, usage) {
  const { values, directory, selected, baselineOptions } = parseCheckArgs(args);
  if (values.help) {
    console.log(usage);
    return 0;
  }
  // Relative paths keep the fix commands the checkers print short and runnable from the same folder.
  const relative = (target) => path.relative(process.cwd(), target).split(path.sep).join('/') || '.';
  const options = { directory, flags: sharedArgs(values, baselineOptions, directory), relative };
  const runs = baselineOptions.writeBaseline
    ? await runInSequence(selected, options)
    : await runInParallel(selected, options);
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
