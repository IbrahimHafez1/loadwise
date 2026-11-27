import { quoteArgument } from './shell-argument.js';
import type { FixCommandValues } from './types/source-report.js';

// The same inputs make `--fix --only` rescan what was reported, so the ids it is given still match.
function fixAllCommand(
  command: string,
  project: string | undefined,
  files: readonly string[],
  values: FixCommandValues,
): string {
  const inputs: string[] = [];
  if (project !== undefined) inputs.push('-p', project);
  for (const name of values.workspace) inputs.push('--workspace', name);
  if (values.policy) inputs.push('--policy', values.policy);
  if (values['loadwise-config']) inputs.push('--loadwise-config', values['loadwise-config']);
  if (command === 'perf' || command === 'rel') {
    if (values.schema) inputs.push('--schema', values.schema);
    const engine = values.with !== undefined ? 'js' : values.native ? 'native' : values.engine;
    if (engine) inputs.push('--engine', engine);
  }
  inputs.push(...files.map((file) => (file.startsWith('-') ? './' + file : file)));
  return [`npx loadwise ${command}`, ...inputs.map(quoteArgument)].join(' ');
}

export { fixAllCommand };
