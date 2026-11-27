import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { applyBulkFixes } from '../../lib/shared/fix.js';
import type { Finding } from '../../lib/shared/types.js';
import type { TestContext } from 'node:test';
import type { FixableFinding } from '../types/findings.js';
import type { FileMap } from '../types/project-files.js';

const bin = path.resolve(import.meta.dirname, '../../bin/loadwise.js');
const example = fs.readFileSync(path.resolve(import.meta.dirname, '../../examples/slow.ts'), 'utf8');

function project(context: TestContext, files: FileMap) {
  const base = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Temp', 'AI-Work') : os.tmpdir();
  fs.mkdirSync(base, { recursive: true });
  const directory = fs.mkdtempSync(path.join(base, 'loadwise-combined-fix-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  for (const [name, text] of Object.entries(files)) {
    const file = path.join(directory, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [bin, ...args], {
      cwd: directory,
      encoding: 'utf8',
      env: { ...process.env, LOADWISE_AGENT: '0' },
    });
  return { directory, run, read: (file: string) => fs.readFileSync(path.join(directory, file), 'utf8') };
}

function finding(file: string, line: number, before: string, after: string): FixableFinding {
  return {
    id: 'test',
    ruleId: 'test-rule',
    message: 'test message',
    fix: { changes: [{ file, line, before, after }] },
  };
}

test('bulk fix requires explicit consent, applies source fixes and lists individual review sites', (context) => {
  const validation =
    "import { ValidationPipe } from '@nestjs/common';\ndeclare const app: any;\napp.useGlobalPipes(new ValidationPipe());\n";
  const { run, read } = project(context, {
    'package.json': '{}',
    'tsconfig.json': '{"files":["slow.ts","validation.ts"]}',
    'slow.ts': example,
    'validation.ts': validation,
    'node_modules/@nestjs/common/index.d.ts': 'export declare class ValidationPipe { constructor(options?: object); }',
  });
  assert.equal(run('fix').status, 2);
  assert.equal(read('slow.ts'), example);
  const fixed = run('fix', '--yes');
  assert.equal(fixed.status, 0, fixed.stdout + fixed.stderr);
  assert.match(fixed.stdout, /Review individually: sec .*nest-validation-without-whitelist #[0-9a-f]+/);
  assert.match(fixed.stdout, /3 automatic fix\(es\) in 1 file/);
  assert.equal(read('validation.ts'), validation);
  assert.notEqual(read('slow.ts'), example);
  assert.equal(run('perf', '-p', '.', '--json').status, 0);
  const reviewed = run('fix', '--all', 'security', '--json');
  assert.equal(reviewed.status, 0, reviewed.stderr);
  const report = JSON.parse(reviewed.stdout);
  assert.ok(
    report.applied.some(
      (finding: FixableFinding) => finding.fix.requiresReview && finding.ruleId === 'nest-validation-without-whitelist',
    ),
  );
  assert.deepEqual(report.pendingReview, []);
});

test('a skipped or failed checker stops the batch before any source edit', (context) => {
  const brokenConfigs: { files: FileMap; reason: RegExp }[] = [
    {
      files: {
        'tsconfig.json': '{"files":["slow.ts"]}',
        'loadwise.config.json': JSON.stringify({ maintainability: { exclude: 'generated' } }),
      },
      reason: /did not complete/,
    },
    { files: {}, reason: /No tsconfig.json or jsconfig.json in .*No fixes applied/ },
  ];
  for (const { files, reason } of brokenConfigs) {
    const { run, read } = project(context, { ...files, 'slow.ts': example });
    const fixed = run('fix', '--yes');
    assert.equal(fixed.status, 2, fixed.stdout + fixed.stderr);
    assert.match(fixed.stderr, reason);
    assert.equal(read('slow.ts'), example);
  }
});

test('bulk JSON keeps evidence of applied edits alongside findings left for the agent', (context) => {
  const connection = 'export const config = { ssl: { rejectUnauthorized: false as const } };';
  const { run, read } = project(context, {
    'tsconfig.json': '{"files":["slow.ts","connection.ts"]}',
    'slow.ts': example,
    'connection.ts': connection,
  });
  const fixed = run('fix', '--yes', 'performance', 'security', '--json');
  assert.equal(fixed.status, 0, fixed.stderr);
  const report = JSON.parse(fixed.stdout);
  assert.equal(report.changedFiles, 1);
  assert.equal(report.applied.length, 3);
  for (const finding of report.applied) {
    assert.equal(finding.checker, 'perf');
    assert.ok(finding.id && finding.ruleId && finding.message);
    for (const { file, before, after } of finding.fix.changes) {
      assert.ok(example.includes(before));
      assert.ok(read(file).includes(after));
    }
  }
  assert.ok(report.manual.some((finding: Finding) => finding.ruleId === 'tls-verification-disabled'));
  assert.deepEqual(report.pendingReview, []);
  assert.match(report.instructions, /Review the changes and remaining findings/);
  const second = run('fix', '--yes', 'performance', '--json');
  assert.equal(second.status, 0, second.stderr);
  const clean = JSON.parse(second.stdout);
  assert.equal(clean.changedFiles, 0);
  assert.deepEqual(clean.applied, []);
  assert.deepEqual(clean.manual, []);
  assert.match(clean.instructions, /No findings in the selected checkers/);
});

test('bulk preflight coalesces identical edits, rejects stale ones and defers overlapping ones', (context) => {
  const original = 'one\r\ntwo\r\nthree\r\n';
  const { directory, read } = project(context, { 'source.txt': original, 'other.txt': 'other\n' });
  const replaceOne = finding('source.txt', 1, 'one', 'first');
  const unrelated = finding('other.txt', 1, 'other', 'updated');
  const overlap = finding('source.txt', 1, 'one\ntwo', 'pair');
  const stale = finding('source.txt', 2, 'one', 'first');
  assert.throws(() => applyBulkFixes([unrelated, replaceOne, stale], directory), /changed since/);
  assert.equal(read('source.txt'), original);
  assert.equal(read('other.txt'), 'other\n');
  const deferred = applyBulkFixes([unrelated, replaceOne, overlap], directory);
  assert.deepEqual(
    deferred.refused.map(({ finding: refusedFinding }) => refusedFinding),
    [overlap],
  );
  assert.equal(read('source.txt'), original.replace('one', 'first'));
  assert.equal(read('other.txt'), 'updated\n');
  fs.writeFileSync(path.join(directory, 'source.txt'), original);
  assert.equal(applyBulkFixes([replaceOne, replaceOne], directory).changedFiles, 1);
  assert.equal(read('source.txt'), original.replace('one', 'first'));
});

test('a review-only hunk reserves its original lines against automatic fixes from every checker', (context) => {
  const { directory, read } = project(context, { 'source.txt': 'one\ntwo\nthree\nfour\n', 'other.txt': 'other' });
  const gated = finding('source.txt', 2, 'two\nthree', 'reviewed change');
  gated.fix.requiresReview = true;
  const identical = finding('./source.txt', 2, 'two\nthree', 'reviewed change');
  const partial = finding(path.join(directory, 'source.txt'), 1, 'one\ntwo', 'different change');
  partial.fix.changes.push(...finding('other.txt', 1, 'other', 'part of the same fix').fix.changes);
  const adjacent = finding('source.txt', 4, 'four', 'automatic change');
  const result = applyBulkFixes([identical, partial, adjacent, gated], directory);
  assert.deepEqual(result.review, [identical, partial, gated]);
  assert.deepEqual(result.automatic, [adjacent]);
  assert.equal(read('source.txt'), 'one\ntwo\nthree\nautomatic change\n');
  assert.equal(read('other.txt'), 'other');
});

test('disjoint edits may not add duplicate bindings or helper implementations to the same scope', (context) => {
  const original = 'export function example() {\n  first();\n  second();\n}\n';
  const { directory, read } = project(context, { 'sample.ts': original });
  for (const helper of ['const lookup = new Map();', 'function lookup() {}']) {
    const edits = ['first', 'second'].map((call, index) =>
      finding('sample.ts', index + 2, `  ${call}();`, `  ${helper}\n  ${call}();`),
    );
    assert.throws(() => applyBulkFixes(edits, directory), /redeclare|duplicate implementation/);
    assert.equal(read('sample.ts'), original);
  }
});

test('a combined fix cannot change a target outside the current project', (context) => {
  const outside = project(context, { 'sibling.txt': 'original' });
  const inside = project(context, { 'source.txt': 'source' });
  const sibling = path.relative(inside.directory, path.join(outside.directory, 'sibling.txt'));
  const edits = [finding('source.txt', 1, 'source', 'edited'), finding(sibling, 1, 'original', 'edited')];
  assert.throws(() => applyBulkFixes(edits, inside.directory), /outside the current project/);
  assert.equal(inside.read('source.txt'), 'source');
  assert.equal(outside.read('sibling.txt'), 'original');
});

test('a failed file replacement preserves previous file contents and cleans up staged copies', (context) => {
  const { directory, read } = project(context, { 'first.txt': 'one', 'second.txt': 'two' });
  const rename = fs.renameSync;
  context.mock.method(fs, 'renameSync', (from: string, to: string) => {
    if (path.basename(to) === 'second.txt') throw new Error('replacement failed');
    return rename(from, to);
  });
  const edits = [finding('first.txt', 1, 'one', 'first'), finding('second.txt', 1, 'two', 'second')];
  assert.throws(() => applyBulkFixes(edits, directory), /replacement failed/);
  assert.equal(read('first.txt'), 'one');
  assert.equal(read('second.txt'), 'two');
  assert.deepEqual(fs.readdirSync(directory).sort(), ['first.txt', 'second.txt']);
});

test('transient EPERM errors during file replacement are retried before succeeding', (context) => {
  const { directory, read } = project(context, { 'file.txt': 'before' });
  const rename = fs.renameSync;
  let attempts = 0;
  context.mock.method(fs, 'renameSync', (from: string, to: string) => {
    attempts++;
    if (attempts <= 2) {
      const error = Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
      throw error;
    }
    return rename(from, to);
  });
  applyBulkFixes([finding('file.txt', 1, 'before', 'after')], directory);
  assert.equal(attempts, 3);
  assert.equal(read('file.txt'), 'after');
});
