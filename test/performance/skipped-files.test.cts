import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { analyzeSources, performanceAnalyzers } from '../../lib/performance/projects.cjs';
import type { SourceFile } from 'typescript';
import type { SourceAnalyzer } from '../../lib/performance/types/source-analyzer.cjs';
import type { Finding, ProgramAdapter, RulePolicy, ScanResult, SkippedFile } from '../../lib/shared/types.cjs';
import { fileOf } from '../types/finding-fix.cjs';
import type * as NativeRuntime from '../../lib/performance/native-runtime.cjs';

const bin = path.resolve(__dirname, '../../bin/loadwise.cjs');
const [major, minor] = process.versions.node.split('.').map(Number);
let nativeSkip = major < 22 || (major === 22 && minor < 13) ? 'native requires Node 22.13+' : false;
try {
  if (!nativeSkip) {
    const nativeRuntime: typeof NativeRuntime = require('../../lib/performance/native-runtime.cjs');
    nativeRuntime.executable();
  }
} catch {
  nativeSkip = 'optional native compiler is absent';
}
const findingFile =
  'export function check(keys: string[], raw: string) { const ids: string[] = JSON.parse(raw); return keys.map(key => ids.includes(key)); }';

function createProject(context: TestContext) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'loadwise-skipped-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, 'flag.ts'), findingFile);
  fs.writeFileSync(path.join(directory, 'clean.ts'), 'export const message = "ok";');
  fs.writeFileSync(path.join(directory, 'broken.ts'), 'export const broken = ;');
  fs.writeFileSync(
    path.join(directory, 'tsconfig.json'),
    '{"compilerOptions":{"target":"ES2022","strict":true},"files":["flag.ts","clean.ts","broken.ts"]}',
  );
  return directory;
}

// The JSON of a scan that skipped files.
interface SkippedFilesReport {
  findings: Finding[];
  skippedFiles: SkippedFile[];
}

function run(directory: string, command: string, args: readonly string[]) {
  return spawnSync(process.execPath, [bin, command, ...args], { cwd: directory, encoding: 'utf8' });
}

for (const command of ['perf', 'sec']) {
  test(`${command} skips a file with a syntax error, lists it and exits 2`, (context) => {
    const directory = createProject(context);
    const result = run(directory, command, [
      '-p',
      'tsconfig.json',
      '--json',
      ...(command === 'perf' ? ['--engine', 'js'] : []),
    ]);
    const report: SkippedFilesReport = JSON.parse(result.stdout);
    assert.equal(result.status, 2, result.stderr);
    assert.equal(report.skippedFiles.length, 1);
    assert.equal(report.skippedFiles[0].file, 'broken.ts');
    assert.match(report.skippedFiles[0].reason, /broken\.ts\(1,\d+\)/);
    assert.match(result.stderr, /Note: .*broken\.ts.* Skipped that file, which does not parse\./);
    if (command === 'perf')
      assert.deepEqual(
        report.findings.map((finding: Finding) => finding.file),
        ['flag.ts'],
      );
  });
}

test('the finding of a valid file is reported in the text output next to a skipped file', (context) => {
  const directory = createProject(context);
  const result = run(directory, 'perf', ['-p', 'tsconfig.json', '--engine', 'js']);
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stdout, /flag\.ts/);
  assert.match(result.stderr, /broken\.ts/);
});

test('an analyzer that throws skips only that file and is named in a note', (context) => {
  const directory = createProject(context);
  const [performance] = performanceAnalyzers;
  const failing: SourceAnalyzer = {
    pillar: 'performance',
    analyzeFile(program: ProgramAdapter, source: SourceFile, policy?: RulePolicy) {
      if (path.basename(source.fileName) === 'clean.ts') throw new Error('rule exploded');
      return performance.analyzeFile(program, source, policy);
    },
  };
  const notes: string[] = [];
  const originalError = console.error;
  console.error = (message: string) => notes.push(message);
  let result: ScanResult | undefined;
  try {
    result = analyzeSources({
      project: path.join(directory, 'tsconfig.json'),
      files: [],
      analyzers: [failing],
    });
  } finally {
    console.error = originalError;
  }
  assert.ok(result, 'the scan finishes');
  assert.ok(result.skippedFiles, 'the scan lists skipped files');
  assert.deepEqual(
    result.findings.map((finding) => path.basename(fileOf(finding))),
    ['flag.ts'],
  );
  assert.deepEqual(
    result.skippedFiles
      .map(({ file, reason }) => [path.basename(file), reason])
      .filter(([file]) => file === 'clean.ts'),
    [['clean.ts', 'rule exploded']],
  );
  assert.ok(notes.some((note) => /clean\.ts failed \(rule exploded\)/.test(note)));
});

test('--write-baseline with a skipped file still writes the baseline and exits 2', (context) => {
  const directory = createProject(context);
  const baselineFile = path.join(directory, 'baseline.json');
  const result = run(directory, 'perf', ['-p', 'tsconfig.json', '--engine', 'js', '--write-baseline', baselineFile]);
  assert.equal(result.status, 2, result.stderr);
  assert.ok(fs.existsSync(baselineFile), result.stderr);
  assert.match(fs.readFileSync(baselineFile, 'utf8'), /flag\.ts/);
});

test('the native engine reports a valid file next to a skipped one and exits 2', { skip: nativeSkip }, (context) => {
  const directory = createProject(context);
  const result = run(directory, 'perf', ['-p', 'tsconfig.json', '--json', '--engine', 'native']);
  const report: SkippedFilesReport = JSON.parse(result.stdout);
  assert.equal(result.status, 2, result.stderr);
  assert.deepEqual(
    report.findings.map((finding: Finding) => finding.file),
    ['flag.ts'],
  );
  assert.deepEqual(
    report.skippedFiles.map((skipped: SkippedFile) => skipped.file),
    ['broken.ts'],
  );
});
