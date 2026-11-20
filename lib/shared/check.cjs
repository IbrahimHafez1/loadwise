'use strict';

// `loadwise check`: runs the selected pillars in parallel, then prints their reports and merges their exit codes.
const fs = require('node:fs');
const path = require('node:path');
const { parseArgs } = require('node:util');
const { loadSettings } = require('./config.cjs');
const { selectPillars } = require('./pillars.cjs');
const { parseMinImpact } = require('./impact-levels.cjs');
const { extractBaselineFlags, resolveBaselineFile } = require('./baseline.cjs');
const { resolveFormat, renderReports } = require('./formats/index.cjs');

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
      format: { type: 'string' },
      'include-contextual': { type: 'boolean' },
      staged: { type: 'boolean' },
      'changed-since': { type: 'string' },
      'fail-on': { type: 'string' },
      'min-impact': { type: 'string' },
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
  parseMinImpact(values['min-impact']);
  if (values.staged && values['changed-since'] !== undefined) {
    throw new Error('Choose either --staged or --changed-since.');
  }
  const format = resolveFormat(values);
  const directory = path.resolve(positionals[0] ?? '.');
  if (!fs.statSync(directory, { throwIfNoEntry: false })?.isDirectory())
    throw new Error('Expected a project directory.');
  if (baselineOptions.baseline && baselineOptions.writeBaseline) {
    throw new Error('Choose either --baseline or --write-baseline.');
  }
  if (baselineOptions.writeBaseline && (values.staged || values['changed-since'] !== undefined)) {
    throw new Error('--write-baseline records every finding; it cannot be combined with --staged or --changed-since.');
  }
  const settings = loadSettings({ directory, explicit: values.config, ignore: values.ignore });
  // --only and --skip beat the config's default selection.
  const choice =
    values.only === undefined && values.skip === undefined ? { only: settings.checkers?.join(',') } : values;
  return { values, format, directory, selected: selectPillars(choice), settings, baselineOptions };
}

// Every checker gets the same absolute baseline file, so each fills its own section of it.
function baselineArgs({ baseline, writeBaseline }, directory) {
  const flag = writeBaseline ? '--write-baseline' : '--baseline';
  const option = writeBaseline ?? baseline;
  return option ? [flag, resolveBaselineFile(option, directory)] : [];
}

// The flags every checker accepts with the same meaning.
// Structured formats are built here from each checker's JSON report.
function sharedArgs(values, format, settings, baselineOptions, directory) {
  return [
    ...(settings.filename ? ['--loadwise-config', settings.filename] : []),
    ...baselineArgs(baselineOptions, directory),
    ...(format === 'text' ? [] : ['--json']),
    ...(values['include-contextual'] ? ['--include-contextual'] : []),
    ...(values.staged ? ['--staged'] : []),
    ...(values['changed-since'] !== undefined ? ['--changed-since', values['changed-since']] : []),
    ...(values['fail-on'] !== undefined ? ['--fail-on', values['fail-on']] : []),
    ...(values['min-impact'] !== undefined ? ['--min-impact', values['min-impact']] : []),
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

// Writing a baseline rewrites the one shared file, so the checkers must not do it at the same time.
async function runInSequence(selected, optionsFor) {
  const runs = [];
  for (const pillar of selected) runs.push(await pillar.run(optionsFor(pillar)));
  return runs;
}

function runInParallel(selected, optionsFor) {
  return Promise.all(selected.map((pillar) => pillar.run(optionsFor(pillar))));
}

async function runCheck(args, usage) {
  const { values, format, directory, selected, settings, baselineOptions } = parseCheckArgs(args);
  if (values.help) {
    console.log(usage);
    return 0;
  }
  // Relative paths keep the fix commands the checkers print short and runnable from the same folder.
  const relative = (target) => path.relative(process.cwd(), target).split(path.sep).join('/') || '.';
  const flags = sharedArgs(values, format, settings, baselineOptions, directory);
  const optionsFor = (pillar) => ({ directory, flags: [...flags, ...ignoreArgs(pillar, values.ignore)], relative });
  const runs = baselineOptions.writeBaseline
    ? await runInSequence(selected, optionsFor)
    : await runInParallel(selected, optionsFor);
  if (format === 'text') {
    selected.forEach((pillar, index) => printSection(pillar.title, runs[index]));
  } else {
    for (const run of runs) process.stderr.write(run?.stderr ?? '');
    const reports = selected.map((pillar, index) => parsedReport(runs[index]));
    if (format === 'json') {
      console.log(
        JSON.stringify(Object.fromEntries(selected.map((pillar, index) => [pillar.jsonKey, reports[index]])), null, 2),
      );
    } else {
      const entries = selected.map((pillar, index) => ({
        pillar: pillar.jsonKey,
        root: pillar.findingRoot(directory),
        report: reports[index],
      }));
      const output = renderReports(format, entries);
      if (output) console.log(output);
    }
  }
  return combinedExitCode(runs);
}

module.exports = { runCheck };
