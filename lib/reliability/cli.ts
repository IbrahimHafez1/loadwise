// `loadwise rel ...`: the reliability checker. Source checks run the shared perf engine and report the
// reliability findings; migrations, contracts and polyglot keep their own scanners.
import { extractBaselineFlags } from '../shared/baseline.js';
import { checkCode } from '../performance/cli-scan.js';
import { printResult } from '../performance/cli-output.js';
import { reliabilityCommand } from '../performance/source-pillars.js';

async function main(args: readonly string[]): Promise<number> {
  // Resolve subcommand dependencies only after selecting the command.
  switch (args[0]) {
    case 'migrations':
      return (await import('../performance/migrations/cli.js')).run(args.slice(1));
    case 'contracts':
      return (await import('../performance/contracts/cli.js')).run(args.slice(1));
    case 'polyglot':
      return (await import('../performance/cli.js')).runPolyglot(args.slice(1), 'reliability');
  }
  const { args: sourceArgs, ...baselineOptions } = extractBaselineFlags(args);
  return checkCode(sourceArgs, printResult, baselineOptions, reliabilityCommand);
}

export { main };
