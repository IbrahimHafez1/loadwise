'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '../..');
const bin = path.join(root, 'bin/loadwise.cjs');
const [major, minor] = process.versions.node.split('.').map(Number);
let nativeSkip = major < 22 || (major === 22 && minor < 13) ? 'native requires Node 22.13+' : false;
try {
  if (!nativeSkip) require('../../lib/performance/native-runtime.cjs').executable();
} catch {
  nativeSkip = 'optional native compiler is absent';
}

const source = [
  'export function check(keys: string[], payload: string) {',
  '  const ids: string[] = JSON.parse(payload);',
  '  return keys.map((key) => ids.includes(key));',
  '}',
].join('\n');

function scan(context, engine, compilerOptions, include) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'loadwise-emit-options-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const files = {
    'src/index.ts': source,
    'scripts/tool.ts': source,
    'tsconfig.json': JSON.stringify({ compilerOptions, include }),
  };
  for (const [name, contents] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(directory, name)), { recursive: true });
    fs.writeFileSync(path.join(directory, name), contents);
  }
  const result = spawnSync(process.execPath, [bin, 'perf', '--engine', engine, '-p', 'tsconfig.json', '--json'], {
    cwd: directory,
    encoding: 'utf8',
  });
  assert.ok([0, 1].includes(result.status), result.stderr);
  return JSON.parse(result.stdout);
}

for (const engine of ['js', 'native']) {
  const skip = engine === 'native' ? nativeSkip : false;
  test(`${engine} engine scans files outside rootDir`, { skip }, (context) => {
    const report = scan(context, engine, { rootDir: 'src', outDir: 'dist', strict: true }, ['src', 'scripts']);
    assert.equal(report.scannedFiles, 2);
    assert.ok(report.findings.length > 0);
  });

  test(`${engine} engine scans emitDeclarationOnly without declaration`, { skip }, (context) => {
    const report = scan(context, engine, { emitDeclarationOnly: true, strict: true }, ['src']);
    assert.ok(report.findings.some((finding) => finding.file.endsWith('src/index.ts')));
  });
}
