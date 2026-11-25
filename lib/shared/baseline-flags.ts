import type { BaselineFlagOptions } from './types/baseline.js';

const baselineFlags = ['--baseline', '--write-baseline'];

// Both flags take an optional file. A following argument counts as that file only when it names a
// .json file, so
// `loadwise maint --baseline src` still reads `src` as the directory.
function extractBaselineFlags(args: readonly string[]): BaselineFlagOptions & { args: string[] } {
  const rest: string[] = [];
  const options: BaselineFlagOptions = {};
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    const flag = baselineFlags.find((name) => argument === name || argument.startsWith(name + '='));
    const afterTerminator = args.includes('--') && args.indexOf('--') < index;
    if (!flag || afterTerminator) {
      rest.push(argument);
      continue;
    }
    const key = flag === '--baseline' ? 'baseline' : 'writeBaseline';
    const next = args[index + 1];
    if (argument.startsWith(flag + '=')) {
      const file = argument.slice(flag.length + 1);
      if (!file) throw new Error(`${flag} requires a file path.`);
      options[key] = { file };
    } else if (next !== undefined && /\.json$/i.test(next) && !next.startsWith('-')) {
      options[key] = { file: next };
      index++;
    } else options[key] = {};
  }
  return { args: rest, ...options };
}

export { extractBaselineFlags };
