import { parseMinImpact } from '../shared/impact-levels.cjs';
import { loadSettings } from '../shared/config.cjs';
import { extractBaselineFlags } from '../shared/baseline.cjs';
import type { PolyglotScan } from './polyglot.cjs';
import { formatImpact } from './impact.cjs';
import { notifyEditor } from './notify-editor.cjs';
import { runAgentCommand } from '../shared/agent-init.cjs';
import type * as EditorSetup from './editor-setup.cjs';
import { parseCommand, readJsonFile, showHelp } from './cli-arguments.cjs';
import { printResult, scanFilter, selectFindings } from './cli-output.cjs';
import { projectDirectory, relativeToCwd, sourcePolicy, workspaceTarget } from './cli-policy.cjs';
import { checkCode, loadSqlParser } from './cli-scan.cjs';

async function checkPlan(args: readonly string[]): Promise<number> {
  const { values, positionals } = parseCommand(args, { json: { type: 'boolean' } });
  if (values.help) return showHelp();
  if (positionals.length !== 1) throw new Error('Pass exactly one executed query plan to plan.');
  const result = (await import('./plans.cjs')).inspectPlan(readJsonFile(positionals[0], 'Plan'));
  if (values.json) console.log(JSON.stringify(result, null, 2));
  else {
    for (const { path, ruleId, message, ...metrics } of result.findings) {
      console.log(`${path} [${ruleId}] ${message} ${JSON.stringify(metrics)}`);
    }
    console.log(`${result.engine} execution plan, ${result.findings.length} finding(s).`);
  }
  return result.findings.length ? 1 : 0;
}

async function checkTraces(args: readonly string[]): Promise<number> {
  const { values, positionals } = parseCommand(args, {
    json: { type: 'boolean' },
    threshold: { type: 'string', default: '5' },
  });
  if (values.help) return showHelp();
  if (positionals.length !== 1) throw new Error('Pass exactly one OTLP JSON file to traces.');
  const threshold = Number(values.threshold);
  if (!/^\d+$/.test(values.threshold) || !Number.isSafeInteger(threshold) || threshold < 2) {
    throw new Error('--threshold must be an integer of at least 2.');
  }
  const document = readJsonFile(positionals[0], 'Trace');
  const result = (await import('./traces.cjs')).inspectTraces(document, { threshold });
  const { findings, scannedSpans, eligibleDbSpans } = result;
  if (values.json) console.log(JSON.stringify(result, null, 2));
  else {
    for (const finding of findings) {
      console.log(
        `${finding.traceId} parent ${finding.parentSpanId || '(root)'} [${finding.ruleId}] ${finding.message}`,
      );
      const impact = formatImpact(finding.impact);
      if (impact) console.log(`  ${impact}`);
    }
    console.log(
      `${eligibleDbSpans} distinct eligible DB span(s) across ${scannedSpans} input span(s), ${findings.length} finding(s).`,
    );
  }
  return findings.length ? 1 : 0;
}

async function runEditor(args: readonly string[]): Promise<number> {
  if (args[0] === 'init' && args.length === 1) {
    const editorSetup: typeof EditorSetup = require('./editor-setup.cjs');
    const setup = editorSetup.setupEditor(process.cwd());
    console.log((setup.changed ? 'Configured ' : 'Already configured: ') + setup.filename);
    console.log(
      'Open or reopen the trusted folder in VS Code or Cursor and allow automatic tasks once. Terminal source scans refresh the active watcher.',
    );
    return 0;
  }
  if (args[0] !== 'watch') throw new Error('Usage: loadwise perf editor init  |  editor watch [-p tsconfig.json]');
  const { values, positionals } = parseCommand(args.slice(1), { project: { type: 'string', short: 'p' } });
  if (values.help) return showHelp();
  if (positionals.length) throw new Error('editor watch accepts only an optional -p project config.');
  await loadSqlParser();
  (await import('./editor-watch.cjs')).watchEditor(process.cwd(), values.project, (inputs) =>
    checkCode(inputs, selectFindings),
  );
  return 0;
}

async function runPolyglot(args: readonly string[]): Promise<number> {
  const { values, positionals } = parseCommand(args, {
    json: { type: 'boolean' },
    'min-impact': { type: 'string' },
    'loadwise-config': { type: 'string' },
  });
  if (values.help) return showHelp();
  parseMinImpact(values['min-impact']);
  if (!positionals.length) throw new Error('Pass at least one file or directory to polyglot.');
  const result = await (await import('./polyglot.cjs')).checkPolyglot(positionals);
  const settings = loadSettings({ directory: process.cwd(), explicit: values['loadwise-config'] });
  // The polyglot scan reports skippedFiles as a count, which printing never reads but the JSON
  // output keeps.
  const printable: Omit<PolyglotScan, 'skippedFiles'> = result;
  const code = printResult(printable, { ...values, ignore: [], settings });
  notifyEditor(positionals.length === 1 ? positionals[0] : process.cwd());
  return code;
}

async function main(args: readonly string[]): Promise<number> {
  // Resolve subcommand dependencies only after selecting the command.
  switch (args[0]) {
    case 'editor':
      return runEditor(args.slice(1));
    case 'agent':
      return runAgentCommand(args.slice(1));
    case 'migrations':
      return (await import('./migrations/cli.cjs')).run(args.slice(1));
    case 'contracts':
      return (await import('./contracts/cli.cjs')).run(args.slice(1));
    case 'db':
      return (await import('./db/cli.cjs')).run(args.slice(1));
    case 'traces':
      return checkTraces(args.slice(1));
    case 'plan':
      return checkPlan(args.slice(1));
    case 'polyglot':
      return runPolyglot(args.slice(1));
  }
  const { args: sourceArgs, ...baselineOptions } = extractBaselineFlags(args);
  return checkCode(sourceArgs, printResult, baselineOptions);
}

export { main, sourcePolicy, workspaceTarget, projectDirectory, scanFilter, relativeToCwd };
