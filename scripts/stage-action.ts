import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

interface PackageManifest {
  files: string[];
}

const source = path.resolve(import.meta.dirname, '..');
const { files }: PackageManifest = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8'));
const runtime = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'loadwise-runtime-'));
const prebuilt = fs.existsSync(path.join(source, 'bin/github-action.js'));

const isImplementationSource = (entry: string): boolean => {
  const rel = path.relative(source, entry).split(path.sep).join('/');
  return entry.endsWith('.cts') || (entry.endsWith('.ts') && !entry.endsWith('.d.ts') && !rel.startsWith('examples/'));
};

if (prebuilt) {
  // An entry starting with "!" excludes files from the package (npm's `files` syntax); the
  // implementation sources are excluded here by extension, leaving only compiled output.
  for (const entry of ['package.json', 'package-lock.json', ...files.filter((name) => !name.startsWith('!'))]) {
    const destination = path.join(runtime, entry);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.cpSync(path.join(source, entry), destination, {
      recursive: true,
      filter: (name) => !isImplementationSource(name),
    });
  }
} else {
  const runtimeEntries = new Set([
    'package.json',
    'package-lock.json',
    'tsconfig.json',
    ...files.filter((name) => !name.startsWith('!')),
  ]);
  for (const entry of runtimeEntries) {
    const origin = path.join(source, entry);
    if (!fs.existsSync(origin)) continue;
    const destination = path.join(runtime, entry);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.cpSync(origin, destination, { recursive: true });
  }
}

console.log(runtime);
