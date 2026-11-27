import fs from 'node:fs';
import path from 'node:path';
import { createRequire, isBuiltin } from 'node:module';
import ts from 'typescript';

if (!process.argv[2]) {
  throw new Error('Usage: node scripts/vendor-native.js <path-to-typescript-package>');
}
const source = path.resolve(process.argv[2]);
const destination = path.resolve(import.meta.dirname, '../lib/performance/vendor/typescript');
const manifest = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8'));
if (manifest.name !== 'typescript' || manifest.version !== '7.1.0-beta') {
  throw new Error('Expected the published typescript@7.1.0-beta package.');
}
const entryPoints = ['./sync', './ast', './ast/is', './ast/utils', './fs'];
const entryFiles = entryPoints.map((entry) => manifest.exports?.[entry]);
if (!entryFiles.every((entryFile) => typeof entryFile === 'string')) {
  throw new Error(`Expected exports for ${entryPoints.join(', ')} in the typescript package.`);
}
// Only after the source is confirmed, so a wrong path leaves the current vendored copy in place.
fs.rmSync(destination, { recursive: true, force: true });
const files = new Set(['package.json', 'LICENSE', 'NOTICE.txt', 'vendor/vscode-jsonrpc/License.txt']);
for (const entryFile of entryFiles) files.add(path.normalize(entryFile));

// TypeScript's binding ships ESM, with CommonJS used by its JSON-RPC dependency.
// Follow static imports in both syntaxes, preserving the original file bytes.
for (const relative of files) {
  const original = path.join(source, relative);
  if (relative.endsWith('.js')) {
    const resolver = createRequire(original);
    const imports = ts.preProcessFile(fs.readFileSync(original, 'utf8'), true, true).importedFiles;
    for (const { fileName } of imports) {
      if (isBuiltin(fileName)) continue;
      const dependency = path.relative(source, resolver.resolve(fileName));
      if (dependency.startsWith('..') || path.isAbsolute(dependency)) throw new Error('External import: ' + fileName);
      files.add(dependency);
    }
  }
  const target = path.join(destination, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(original, target);
}
console.log(`Copied ${files.size} upstream files from ${manifest.name}@${manifest.version}.`);
