// `loadwise check`: runs the selected pillars in parallel, then prints their reports and merges their exit codes.
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { loadSettings } from './config.js';
import { selectPillars, runPillars } from './pillars.js';
import { parseMinImpact } from './impact-levels.js';
import { extractBaselineFlags, resolveBaselineFile } from './baseline.js';
import { resolveFormat, renderReports } from './formats/index.js';
import type { Finding } from './types.js';
import type { BaselineFlagOptions } from './types/baseline.js';
import type { ChildRun, CheckerReport, PillarDefinition, PillarRunOptions } from './types/checker-run.js';
import type { OutputFormat, ReportEntry } from './types/report-formats.js';
import type { LoadwiseSettings } from './types/settings.js';
import { discoverWorkspaces, projectConfig } from './workspaces.js';
import { writeReviewHandoff } from './review-delivery.js';

/** The values `loadwise check` reads from its command line. */
interface CheckValues {
  help?: boolean;
  json?: boolean;
  review?: boolean;
  format?: string;
  online?: boolean;
  'include-contextual'?: boolean;
  staged?: boolean;
  'changed-since'?: string;
  'fail-on'?: string;
  'min-impact'?: string;
  only?: string;
  skip?: string;
  config?: string;
  ignore: string[];
  workspace: string[];
}

type CheckOptions = ReturnType<typeof parseCheckArgs>;
type CheckRun = ChildRun | undefined;

const invalidInputCode = 2;
const thresholdMetCode = 1;

function parseCheckArgs(args: readonly string[]) {
  // Each checker takes --fix, so `loadwise --fix` is a natural guess; point it to the fix command instead of a parser error.
  if (args.includes('--fix')) {
    throw new Error(
      'check never changes files. From the project folder, run `loadwise fix --yes` for automatic edits or `loadwise fix --all` to also apply edits marked for review; add checker names to limit either, as in `loadwise fix --all performance`.',
    );
  }
  const { args: checkArgs, ...baselineOptions } = extractBaselineFlags(args);
  const { values, positionals } = parseArgs({
    args: checkArgs,
    allowPositionals: true,
    options: {
      help: { type: 'boolean', short: 'h' },
      json: { type: 'boolean' },
      review: { type: 'boolean' },
      format: { type: 'string' },
      online: { type: 'boolean' },
      'include-contextual': { type: 'boolean' },
      staged: { type: 'boolean' },
      'changed-since': { type: 'string' },
      'fail-on': { type: 'string' },
      'min-impact': { type: 'string' },
      only: { type: 'string' },
      skip: { type: 'string' },
      config: { type: 'string' },
      ignore: { type: 'string', multiple: true, default: [] },
      workspace: { type: 'string', multiple: true, default: [] },
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
  // Reliability rules were part of perf before it had its own checker, so a list written then lost them.
  if (choice === values || !settings.checkers?.includes('perf') || settings.checkers.includes('rel')) {
    return { values, format, directory, selected: selectPillars(choice), settings, baselineOptions };
  }
  console.error(
    `Note: "checkers" in ${settings.filename} lists perf but not rel; floating promises, races, timeouts and other reliability rules now run under rel. Add "rel" to keep them.`,
  );
  return { values, format, directory, selected: selectPillars(choice), settings, baselineOptions };
}

// Every checker gets the same absolute baseline file, so each fills its own section of it.
function baselineArgs({ baseline, writeBaseline }: BaselineFlagOptions, directory: string): string[] {
  const flag = writeBaseline ? '--write-baseline' : '--baseline';
  const option = writeBaseline ?? baseline;
  return option ? [flag, resolveBaselineFile(option, directory)] : [];
}

// The flags every checker accepts with the same meaning.
// Structured formats are built here from each checker's JSON report.
function sharedArgs(
  values: CheckValues,
  format: OutputFormat,
  settings: LoadwiseSettings,
  baselineOptions: BaselineFlagOptions,
  directory: string,
): string[] {
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
function ignoreArgs(pillar: PillarDefinition, ignored: readonly string[]): string[] {
  if (!ignored.length) return [];
  const own = pillar.ruleIds();
  return ignored.filter((ruleId: string) => own.has(ruleId)).flatMap((ruleId: string) => ['--ignore', ruleId]);
}

function contractArgs(values: CheckValues, format: OutputFormat, settings: LoadwiseSettings): string[] | undefined {
  if (!values['changed-since']) return undefined;
  return [
    '--changed-since',
    values['changed-since'],
    ...(format === 'text' ? [] : ['--json']),
    ...(settings.filename ? ['--loadwise-config', settings.filename] : []),
    ...(values['min-impact'] ? ['--min-impact', values['min-impact']] : []),
    ...values.ignore.flatMap((ruleId: string) => ['--ignore', ruleId]),
    ...values.workspace.flatMap((selector: string) => ['--workspace', selector]),
  ];
}

// Exit 2 means the checker could not run (invalid input, crash: no report) or ran, printed its
// report and also skipped files it could not analyze. Only the second has a report with findings,
// and it must be kept.
function parsedReport(run: CheckRun): CheckerReport | null {
  if (!run || !run.stdout.trim() || ![0, thresholdMetCode, invalidInputCode].includes(run.code)) return null;
  let report: CheckerReport | null;
  try {
    report = JSON.parse(run.stdout);
  } catch (error) {
    if (run.code === invalidInputCode) return null;
    throw error;
  }
  return run.code === invalidInputCode && !Array.isArray(report?.findings) ? null : report;
}

// A selected checker that ran but left nothing to show: it crashed, ran out of memory or rejected
// its input.
function producedNoResult(run: CheckRun, format: OutputFormat): boolean {
  if (!run || [0, thresholdMetCode].includes(run.code)) return false;
  return format === 'text' ? !run.stdout.trim() : !parsedReport(run);
}

function printSection(title: string, run: CheckRun, format: OutputFormat): void {
  if (!run) return;
  console.log(`== ${title} ==`);
  const noResultNote = `No result: the ${title.toLowerCase()} checker failed (exit code ${run.code}); see the notes below.\n`;
  process.stdout.write(producedNoResult(run, format) ? noResultNote : run.stdout || 'Nothing to check.\n');
  process.stderr.write(run.stderr);
}

// Structured output has no room for a note, so a checker with a null report is named on stderr.
function noteMissingResults(
  selected: readonly PillarDefinition[],
  runs: readonly CheckRun[],
  format: OutputFormat,
): void {
  selected.forEach((pillar: PillarDefinition, index: number) => {
    if (producedNoResult(runs[index], format)) {
      process.stderr.write(`${pillar.title} checker produced no result (exit code ${runs[index]?.code}).\n`);
    }
  });
}

function combinedExitCode(runs: readonly CheckRun[]): number {
  const codes = runs.flatMap((run) => (run ? [run.code] : []));
  if (codes.some((code) => code !== 0 && code !== thresholdMetCode)) return invalidInputCode;
  return codes.includes(thresholdMetCode) ? thresholdMetCode : 0;
}

// Writing a baseline rewrites the one shared file, so the checkers must not do it at the same time.
async function runInSequence(
  selected: readonly PillarDefinition[],
  optionsFor: (pillar: PillarDefinition) => PillarRunOptions,
): Promise<CheckRun[]> {
  const runs: CheckRun[] = [];
  for (const pillar of selected) runs.push(await pillar.run(optionsFor(pillar)));
  return runs;
}

async function scanCheck({
  values,
  format,
  directory,
  selected,
  settings,
  baselineOptions,
}: CheckOptions): Promise<CheckRun[]> {
  // Relative paths keep the fix commands the checkers print short and runnable from the same
  // folder.
  const relative = (target: string): string => path.relative(process.cwd(), target).split(path.sep).join('/') || '.';
  const flags = sharedArgs(values, format, settings, baselineOptions, directory);
  const contractFlags = contractArgs(values, format, settings);
  const optionsFor = (pillar: PillarDefinition): PillarRunOptions => ({
    directory,
    contractFlags,
    flags: [...flags, ...ignoreArgs(pillar, values.ignore)],
    online: pillar.name === 'sec' && values.online,
    workspaces: values.workspace,
    relative,
  });
  return baselineOptions.writeBaseline
    ? await runInSequence(selected, optionsFor)
    : await runPillars(selected, optionsFor);
}

async function scanForFixes(checkers?: readonly string[]): Promise<Finding[]> {
  const options = parseCheckArgs(checkers ? ['--json', '--only', checkers.join(',')] : ['--json']);
  if (options.selected.some(({ name }) => name !== 'maint') && !projectConfig(options.directory)) {
    const { packages, withoutConfig } = discoverWorkspaces(options.directory);
    if (packages.length && withoutConfig.length) {
      throw new Error(
        'Workspace packages are missing a source config: ' +
          withoutConfig.map(({ name }) => name).join(', ') +
          '. No fixes applied.',
      );
    }
  }
  const runs = await scanCheck(options);
  for (const run of runs) process.stderr.write(run?.stderr ?? '');
  return options.selected.flatMap((pillar, index) => {
    if (!runs[index] && pillar.optional) return [];
    if (!runs[index] && !projectConfig(options.directory)) {
      throw new Error(
        `No tsconfig.json or jsconfig.json in ${options.directory}, so the ${pillar.title} checker cannot run. Run loadwise fix from the project folder. No fixes applied.`,
      );
    }
    const report = parsedReport(runs[index]);
    if (!report || !Array.isArray(report.findings) || ![0, 1].includes(runs[index]?.code ?? invalidInputCode)) {
      throw new Error(`The ${pillar.title} scan did not complete. No fixes applied.`);
    }
    return report.findings.map((finding: Finding) => ({ ...finding, checker: pillar.name }));
  });
}

async function runCheck(
  args: readonly string[],
  usage?: string,
  formatReports: typeof renderReports = renderReports,
): Promise<number> {
  const options = parseCheckArgs(args);
  const { values, format, directory, selected } = options;
  if (values.help) {
    console.log(usage);
    return 0;
  }
  const runs = await scanCheck(options);
  const parsedReports = format === 'text' ? [] : runs.map((run) => parsedReport(run));
  const reports = selected.map((pillar, index): [string, ChildRun | CheckerReport | null] => [
    pillar.jsonKey,
    format === 'text' ? (runs[index] ?? null) : parsedReports[index],
  ]);
  const report = Object.fromEntries(reports);
  if (format === 'text') {
    selected.forEach((pillar, index) => printSection(pillar.title, runs[index], format));
  } else {
    for (const run of runs) process.stderr.write(run?.stderr ?? '');
    noteMissingResults(selected, runs, format);
    if (format === 'json') {
      console.log(JSON.stringify(report, null, 2));
    } else {
      const entries = selected.map((pillar, index): ReportEntry => ({
        pillar: pillar.jsonKey,
        root: pillar.findingRoot(directory),
        repositoryDirectory: directory,
        report: parsedReports[index],
      }));
      const output = formatReports(format, entries);
      if (output) console.log(output);
    }
  }
  const exitCode = combinedExitCode(runs);
  if (values.review)
    await writeReviewHandoff(directory, 'check', {
      format: format === 'text' ? 'text' : 'json',
      args,
      report,
      exitCode,
      notes: Object.fromEntries(selected.map((pillar, index) => [pillar.jsonKey, runs[index]?.stderr || ''])),
    });
  return exitCode;
}

export { runCheck, scanForFixes };
