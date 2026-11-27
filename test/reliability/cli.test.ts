// `loadwise rel` shares the performance source pass but owns its own findings, baseline section and fix commands.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import type { Finding } from '../../lib/shared/types.js';

interface SourceReport {
  findings: Finding[];
  baselineHidden?: number;
  baselineStale?: number;
}

interface BaselineDocument {
  version: number;
  pillars: Record<string, { findings: unknown[] }>;
}

const bin = path.resolve(import.meta.dirname, '../../bin/loadwise.js');
// One performance finding (sync fs in an async function) and one reliability finding (fetch without a timeout).
const handlerSource = [
  "import { readFileSync } from 'node:fs';",
  'export async function handle() {',
  "  const response = await fetch('https://a.test/x');",
  "  return [response, readFileSync('logo.png')];",
  '}',
  '',
].join('\n');
const tsconfig = JSON.stringify({
  compilerOptions: { target: 'ES2022', module: 'NodeNext', lib: ['ES2022', 'DOM'], types: [] },
  include: ['*.ts'],
});

function project(context: TestContext): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'loadwise-rel-cli-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, 'tsconfig.json'), tsconfig);
  fs.writeFileSync(path.join(directory, 'service.ts'), handlerSource);
  return directory;
}

function loadwise(directory: string, ...args: string[]) {
  const run = spawnSync(process.execPath, [bin, ...args], { cwd: directory, encoding: 'utf8', timeout: 120000 });
  return { code: run.status, stdout: run.stdout, stderr: run.stderr };
}

function ruleIds(report: SourceReport): string[] {
  return report.findings.map(({ ruleId }) => ruleId);
}

test('rel and perf split one source pass by pillar, and check reports the same findings', (context) => {
  const directory = project(context);
  const reliability = loadwise(directory, 'rel', '--json');
  assert.equal(reliability.code, 1, reliability.stderr);
  const performance = loadwise(directory, 'perf', '--json');
  assert.equal(performance.code, 1, performance.stderr);
  const relReport: SourceReport = JSON.parse(reliability.stdout);
  assert.deepEqual(ruleIds(relReport), ['http-call-without-timeout']);
  assert.deepEqual(ruleIds(JSON.parse(performance.stdout)), ['node-sync-fs-in-async']);
  const combined = JSON.parse(loadwise(directory, 'check', '--only', 'perf,rel', '--json').stdout);
  assert.deepEqual(Object.keys(combined), ['performance', 'reliability']);
  assert.deepEqual(
    combined.reliability.findings.map(({ id }: Finding) => id),
    relReport.findings.map(({ id }) => id),
  );
});

test('rel text output names the reliability fix command', (context) => {
  const directory = project(context);
  const run = loadwise(directory, 'rel');
  assert.equal(run.code, 1, run.stderr);
  assert.match(run.stdout, /\[http-call-without-timeout #[0-9a-f]{12}\]/);
  assert.match(run.stdout, /Fix all: npx loadwise rel .*--fix --only [0-9a-f]{12}\n/);
});

test('rel --help lists its own commands', (context) => {
  const run = loadwise(project(context), 'rel', '--help');
  assert.equal(run.code, 0, run.stderr);
  for (const command of ['rel migrations', 'rel contracts', 'rel polyglot']) {
    assert.match(run.stdout, new RegExp(`loadwise ${command} `));
  }
});

test('rel --ignore accepts any registered rule and rejects unknown ones', (context) => {
  const directory = project(context);
  assert.equal(loadwise(directory, 'rel', '--ignore', 'http-call-without-timeout').code, 0);
  assert.equal(loadwise(directory, 'rel', '--ignore', 'node-sync-fs-in-async').code, 1);
  const unknown = loadwise(directory, 'rel', '--ignore', 'no-such-rule');
  assert.equal(unknown.code, 2);
  assert.match(unknown.stderr, /Unknown source rule: no-such-rule/);
});

test('a baseline written before the reliability pillar still hides moved findings without going stale', (context) => {
  const directory = project(context);
  assert.equal(loadwise(directory, 'check', '--only', 'perf,rel', '--write-baseline').code, 0);
  const baselineFile = path.join(directory, 'loadwise-baseline.json');
  const document: BaselineDocument = JSON.parse(fs.readFileSync(baselineFile, 'utf8'));
  assert.equal(document.pillars.reliability.findings.length, 1);
  // Before the split, the performance section recorded the moved rule's entry.
  document.pillars.performance.findings.push(...document.pillars.reliability.findings);
  delete document.pillars.reliability;
  fs.writeFileSync(baselineFile, JSON.stringify(document));

  const reliability: SourceReport = JSON.parse(loadwise(directory, 'rel', '--baseline', '--json').stdout);
  assert.deepEqual([reliability.findings.length, reliability.baselineHidden], [0, 1]);
  const performance: SourceReport = JSON.parse(loadwise(directory, 'perf', '--baseline', '--json').stdout);
  assert.deepEqual([performance.findings.length, performance.baselineHidden, performance.baselineStale], [0, 1, 0]);
});

test('perf --fix --only still applies a moved rule, with a note naming rel', (context) => {
  const directory = project(context);
  const [finding] = JSON.parse(loadwise(directory, 'rel', '--json').stdout).findings;
  const fix = loadwise(directory, 'perf', '--fix', '--only', finding.id, '--json', '--no-format', '--no-comments');
  assert.equal(fix.code, 0, fix.stderr);
  assert.match(
    fix.stderr,
    /now belong to the reliability checker; fixing them anyway\. Use `loadwise rel --fix --only`/,
  );
  assert.deepEqual(JSON.parse(fix.stdout).applied, [finding.id]);
  assert.notEqual(fs.readFileSync(path.join(directory, 'service.ts'), 'utf8'), handlerSource);
  assert.deepEqual(ruleIds(JSON.parse(loadwise(directory, 'rel', '--json').stdout)), []);
});
