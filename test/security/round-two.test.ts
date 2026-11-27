import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { parseSecReport } from './helpers.js';
import type { TestContext } from 'node:test';
import type { Finding } from '../../lib/shared/types.js';
import type { SecReport } from '../types/security.js';

interface BaselineFile {
  pillars: Record<string, { findings: Finding[] }>;
}

const cli = path.resolve(import.meta.dirname, '../../bin/loadwise.js');

function fixture(context: TestContext) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'loadwise-sec-round-two-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, 'tsconfig.json'), '{"files":["app.ts"]}');
  fs.writeFileSync(path.join(directory, 'app.ts'), 'export const app = true;\n');
  fs.writeFileSync(path.join(directory, 'Dockerfile'), 'FROM node:latest\nUSER node\n');
  return directory;
}

function run(directory: string, ...args: string[]) {
  const result = spawnSync(process.execPath, [cli, ...args], { cwd: directory, encoding: 'utf8' });
  assert.ifError(result.error);
  return result;
}

test('check writes security to the shared baseline and filters the same finding from a combined scan', (context) => {
  const directory = fixture(context);
  const write = run(directory, 'check', '--write-baseline');
  assert.equal(write.status, 0, write.stderr);
  const baseline: BaselineFile = JSON.parse(fs.readFileSync(path.join(directory, 'loadwise-baseline.json'), 'utf8'));
  assert.deepEqual(Object.keys(baseline.pillars), ['maintainability', 'performance', 'reliability', 'security']);
  assert.equal(baseline.pillars.security.findings[0].ruleId, 'dockerfile-unpinned-base-image');
  const read = run(directory, 'check', '--only', 'perf,sec', '--json', '--baseline');
  assert.equal(read.status, 0, read.stderr);
  const { security }: { security: SecReport } = JSON.parse(read.stdout);
  assert.equal(security.baselineHidden, 1);
  assert.deepEqual(security.findings, []);
});

test('security applies impact and config warning levels in standalone and combined reports', (context) => {
  const directory = fixture(context);
  fs.writeFileSync(
    path.join(directory, 'loadwise.config.json'),
    JSON.stringify({ rules: { 'dockerfile-unpinned-base-image': 'warn' } }),
  );
  for (const args of [['sec'], ['check', '--only', 'perf,sec']]) {
    const reported = run(directory, ...args, '--json');
    assert.equal(reported.status, 0, reported.stderr);
    const report = parseSecReport(reported.stdout);
    assert.equal((report.security ?? report).findings[0].impactLevel, 'low');
    const filtered = run(directory, ...args, '--json', '--min-impact', 'medium');
    assert.equal(filtered.status, 0, filtered.stderr);
    const result = parseSecReport(filtered.stdout);
    assert.deepEqual((result.security ?? result).findings, []);
  }
});

test('unattended security fixes leave ValidationPipe whitelisting for individual review', (context) => {
  const directory = fixture(context);
  const file = path.join(directory, 'app.ts');
  const source = "import { ValidationPipe } from '@nestjs/common';\nexport const pipe = new ValidationPipe();\n";
  fs.writeFileSync(file, source);
  const before = run(directory, 'sec', '--json');
  const finding = parseSecReport(before.stdout).findings.find(
    ({ ruleId }) => ruleId === 'nest-validation-without-whitelist',
  );
  assert.equal(finding?.fixable, true);
  const report = run(directory, 'sec');
  assert.equal(report.status, 1, report.stderr);
  assert.doesNotMatch(report.stdout, /^Fix all:/m);
  assert.ok(report.stdout.includes('--fix --only ' + finding.id));
  const bulk = run(directory, 'sec', '--fix', '--yes');
  assert.equal(bulk.status, 0, bulk.stderr);
  assert.equal(fs.readFileSync(file, 'utf8'), source);
});

test('combined and standalone security reports honor workspace selection for file checks', (context) => {
  const directory = fixture(context);
  fs.writeFileSync(path.join(directory, 'package.json'), '{"workspaces":["packages/*"]}');
  for (const name of ['first', 'second']) {
    const workspace = path.join(directory, 'packages', name);
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(path.join(workspace, 'package.json'), JSON.stringify({ name }));
    fs.writeFileSync(path.join(workspace, 'tsconfig.json'), '{"files":["app.ts"]}');
    fs.writeFileSync(path.join(workspace, 'app.ts'), 'export const app = true;\n');
    fs.writeFileSync(path.join(workspace, 'Dockerfile'), 'FROM node:latest\nUSER node\n');
  }
  for (const args of [
    ['check', '--only', 'perf,sec'],
    ['check', '--only', 'sec'],
  ]) {
    const runResult = run(directory, ...args, '--workspace', 'first', '--json', '--fail-on', 'contract');
    assert.equal(runResult.status, 0, runResult.stderr);
    const { security }: { security: SecReport } = JSON.parse(runResult.stdout);
    assert.equal(security.scannedFiles, 1);
    assert.deepEqual(
      security.findings.map(({ file }) => file),
      ['packages/first/Dockerfile'],
    );
  }
});
