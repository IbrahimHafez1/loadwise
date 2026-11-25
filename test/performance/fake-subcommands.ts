// Preloaded with --require: stands in for the migrations and db command modules so dispatch is
// tested on its own. The hook sees both require() and import(), so it works however the CLI loads
// them.
import { registerHooks } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const libraryRoot = path.resolve(import.meta.dirname, '../../lib/performance');
const fakes = new Map(
  ['migrations', 'db'].map((command) => [pathToFileURL(path.join(libraryRoot, command, 'cli.js')).href, command]),
);

registerHooks({
  load(url, context, nextLoad) {
    const command = fakes.get(url);
    if (command === undefined) return nextLoad(url, context);
    process.stderr.write('fake loaded: ' + command + '\n');
    const source = `export async function run(argv) {
  console.log(JSON.stringify({ command: ${JSON.stringify(command)}, argv }));
  return 3;
}`;
    return { format: 'module', shortCircuit: true, source };
  },
});
