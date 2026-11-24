import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import type { Finding } from '../../lib/shared/types.cjs';
import type { CliJsonReport } from '../types/polyglot-report.cjs';

const bin = path.resolve(__dirname, '../../bin/loadwise.cjs');
const deepFunction = [
  'function label(values, mode) {',
  '  if (!values.length) {',
  '    return "none";',
  '  } else {',
  '    let text = "";',
  '    for (const value of values) {',
  '      if (mode === "loud") {',
  '        text += "?";',
  '        if (value > 0) text += "!";',
  '      }',
  '      text += ".";',
  '    }',
  '    return text;',
  '  }',
  '}',
  'module.exports = { label };',
].join('\n');
const brokenSource = 'export const = ;';

function git(root: string, ...args: string[]) {
  const result = spawnSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
}

function tempDirectory(context: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loadwise-maint-skipped-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function run(root: string, ...args: string[]) {
  return spawnSync(process.execPath, [bin, 'maint', ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, LOADWISE_AGENT: '0' },
    timeout: 120000,
  });
}

test('maint --write-baseline with a skipped file still writes the baseline and exits 2', (context) => {
  const root = tempDirectory(context);
  fs.writeFileSync(path.join(root, 'app.js'), deepFunction + '\n');
  fs.writeFileSync(path.join(root, 'broken.ts'), brokenSource);
  const baselineFile = path.join(root, 'baseline.json');
  const result = run(root, '.', '--write-baseline', baselineFile);
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /broken\.ts.*Skipped that file, which does not parse/);
  assert.ok(fs.existsSync(baselineFile), result.stderr);
  assert.match(fs.readFileSync(baselineFile, 'utf8'), /app\.js/);
});

function changedRepo(context: TestContext) {
  const root = tempDirectory(context);
  git(root, 'init', '-q');
  fs.writeFileSync(path.join(root, 'package.json'), '{}');
  fs.writeFileSync(path.join(root, 'app.js'), 'module.exports = {};\n');
  fs.writeFileSync(path.join(root, 'broken.ts'), 'export const fine = 1;\n');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'base');
  fs.writeFileSync(path.join(root, 'app.js'), deepFunction + '\n');
  fs.writeFileSync(path.join(root, 'broken.ts'), brokenSource + '\n');
  return root;
}

function assertSkippedChangedFile(result: SpawnSyncReturns<string>) {
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /broken\.ts.*Skipped that file, which does not parse/);
  const report: CliJsonReport = JSON.parse(result.stdout);
  assert.deepEqual(
    report.skippedFiles.map((skipped) => skipped.file),
    ['broken.ts'],
  );
  assert.ok(
    report.findings.some((finding: Finding) => finding.file === 'app.js'),
    result.stdout,
  );
}

test('maint --staged reports findings next to a skipped changed file and exits 2', (context) => {
  const root = changedRepo(context);
  git(root, 'add', 'app.js', 'broken.ts');
  assertSkippedChangedFile(run(root, '--staged', '--json', '.'));
});

test('maint --changed-since reports findings next to a skipped changed file and exits 2', (context) => {
  const root = changedRepo(context);
  assertSkippedChangedFile(run(root, '--changed-since', 'HEAD', '--json', '.'));
});
