import { parseMinImpact } from '../shared/impact-levels.js';
import { loadSettings } from '../shared/config.js';
import { extractBaselineFlags } from '../shared/baseline.js';
import type { PolyglotScan } from './polyglot.js';
import { formatImpact } from './impact.js';
import { notifyEditor } from './notify-editor.js';
import { runAgentCommand } from '../shared/agent-init.js';
import { parseCommand, readJsonFile, showHelp } from './cli-arguments.js';
import { printResult, scanFilter } from './cli-output.js';
import { projectDirectory, relativeToCwd, sourcePolicy, workspaceTarget } from './cli-policy.js';
import { checkCode } from './cli-scan.js';

async function checkPlan(args: readonly string[]): Promise<number> {
  const { values, positionals } = parseCommand(args, { json: { type: 'boolean' } });
  if (values.help) return showHelp();
  if (positionals.length !== 1) throw new Error('Pass exactly one executed query plan to plan.');
  const result = (await import('./plans.js')).inspectPlan(readJsonFile(positionals[0], 'Plan'));
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
  const result = (await import('./traces.js')).inspectTraces(document, { threshold });
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

// `pillar` picks the rule set: `loadwise perf polyglot` or `loadwise rel polyglot`.
async function runPolyglot(
  args: readonly string[],
  pillar: 'performance' | 'reliability' = 'performance',
): Promise<number> {
  const { values, positionals } = parseCommand(args, {
    json: { type: 'boolean' },
    'min-impact': { type: 'string' },
    'loadwise-config': { type: 'string' },
  });
  if (values.help) return showHelp();
  parseMinImpact(values['min-impact']);
  if (!positionals.length) throw new Error('Pass at least one file or directory to polyglot.');
  const result = await (await import('./polyglot.js')).checkPolyglot(positionals, pillar);
  const settings = loadSettings({ directory: process.cwd(), explicit: values['loadwise-config'] });
  // The polyglot scan reports skippedFiles as a count, which printing never reads but the JSON
  // output keeps.
  const printable: Omit<PolyglotScan, 'skippedFiles'> = result;
  const code = await printResult(printable, { ...values, ignore: [], settings, sourcePillar: pillar });
  notifyEditor(positionals.length === 1 ? positionals[0] : process.cwd());
  return code;
}

async function main(args: readonly string[]): Promise<number> {
  // Resolve subcommand dependencies only after selecting the command.
  switch (args[0]) {
    case 'editor':
      throw new Error('`loadwise perf editor` was removed. Use the language server, `loadwise lsp`, in your editor.');
    case 'agent':
      return runAgentCommand(args.slice(1));
    case 'migrations':
    case 'contracts':
      console.error(`Note: \`loadwise perf ${args[0]}\` is now \`loadwise rel ${args[0]}\`.`);
      return (await import('../reliability/cli.js')).main(args);
    case 'db':
      return (await import('./db/cli.js')).run(args.slice(1));
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

export { main, runPolyglot, sourcePolicy, workspaceTarget, projectDirectory, scanFilter, relativeToCwd };
