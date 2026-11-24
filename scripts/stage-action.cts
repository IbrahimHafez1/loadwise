import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { files } from '../package.json';

const source = path.resolve(__dirname, '..');
const runtime = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'loadwise-runtime-'));
const isSource = (entry: string): boolean => entry.endsWith('.cts');
// An entry starting with "!" excludes files from the package (npm's `files` syntax); the sources are
// excluded here by their extension, and only the compiled output is staged.
for (const entry of ['package.json', 'package-lock.json', ...files.filter((name) => !name.startsWith('!'))]) {
  const destination = path.join(runtime, entry);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.cpSync(path.join(source, entry), destination, { recursive: true, filter: (name) => !isSource(name) });
}
console.log(runtime);
