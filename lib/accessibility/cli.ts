// `loadwise a11y ...`: the accessibility checker. Source checks run the shared perf engine with only the
// accessibility analyzer; markup files outside the program are read beside it.
import { extractBaselineFlags } from '../shared/baseline.js';
import { checkCode } from '../performance/cli-scan.js';
import { printResult } from '../performance/cli-output.js';
import { accessibilityCommand } from '../performance/source-pillars.js';

async function main(args: readonly string[]): Promise<number> {
  const { args: sourceArgs, ...baselineOptions } = extractBaselineFlags(args);
  return checkCode(sourceArgs, printResult, baselineOptions, accessibilityCommand);
}

export { main };
