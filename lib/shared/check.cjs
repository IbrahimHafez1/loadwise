'use strict';

// `loadwise check`: runs the selected pillars in parallel, then prints their reports and merges their exit codes.
const fs = require('node:fs');
const path = require('node:path');
const { parseArgs } = require('node:util');
const { loadSettings } = require('./config.cjs');
const { selectPillars } = require('./pillars.cjs');

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
      only: { type: 'string' },
      skip: { type: 'string' },
      config: { type: 'string' },
      ignore: { type: 'string', multiple: true, default: [] },
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
  const settings = loadSettings({ directory, explicit: values.config, ignore: values.ignore });
  // --only and --skip beat the config's default selection.
  const choice =
    values.only === undefined && values.skip === undefined ? { only: settings.checkers?.join(',') } : values;
  return { values, directory, selected: selectPillars(choice), settings };
}

// The flags every checker accepts with the same meaning.
function sharedArgs(values, settings) {
  return [
    ...(settings.filename ? ['--loadwise-config', settings.filename] : []),
    ...(values.json ? ['--json'] : []),
    ...(values['include-contextual'] ? ['--include-contextual'] : []),
    ...(values.staged ? ['--staged'] : []),
    ...(values['changed-since'] !== undefined ? ['--changed-since', values['changed-since']] : []),
    ...(values['fail-on'] !== undefined ? ['--fail-on', values['fail-on']] : []),
  ];
}

// Each checker validates --ignore against its own rule ids.
function ignoreArgs(pillar, ignored) {
  const own = pillar.ruleIds();
  return ignored.filter((ruleId) => own.has(ruleId)).flatMap((ruleId) => ['--ignore', ruleId]);
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
  const { values, directory, selected, settings } = parseCheckArgs(args);
  if (values.help) {
    console.log(usage);
    return 0;
  }
  // Relative paths keep the fix commands the checkers print short and runnable from the same folder.
  const relative = (target) => path.relative(process.cwd(), target).split(path.sep).join('/') || '.';
  const flags = sharedArgs(values, settings);
  const runs = await Promise.all(
    selected.map((pillar) =>
      pillar.run({ directory, flags: [...flags, ...ignoreArgs(pillar, values.ignore)], relative }),
    ),
  );
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
