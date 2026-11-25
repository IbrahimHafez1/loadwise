import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { Finding } from '../../lib/shared/types.js';
import { applyBulkFixes } from '../../lib/shared/fix.js';
import { introducedSyntaxError } from '../../lib/shared/fix-safety.js';
import * as performance from '../../lib/performance/fix-cli.js';
import * as maintainability from '../../lib/maintainability/fix-cli.js';
import type { TestContext } from 'node:test';
import type { FixableFinding } from '../types/findings.js';
import type { FileMap } from '../types/project-files.js';

const original = 'const total = compute(1, 2);\nexport { total };\n';
const brokenAfter = 'const total = compute(1, 2));\n);';
const validAfter = 'const total = compute(2, 1);';

function project(context: TestContext, files: FileMap) {
  const base = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Temp', 'AI-Work') : os.tmpdir();
  fs.mkdirSync(base, { recursive: true });
  const directory = fs.mkdtempSync(path.join(base, 'loadwise-fix-safety-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(directory, name), text);
  return { directory, read: (file: string) => fs.readFileSync(path.join(directory, file), 'utf8') };
}

function finding(id: string, file: string, after: string): FixableFinding {
  return {
    id,
    ruleId: 'test-rule',
    message: 'test message',
    checker: 'test',
    file,
    line: 1,
    fix: { changes: [{ file, line: 1, before: 'const total = compute(1, 2);', after }] },
  };
}

test('the syntax comparison ignores existing errors, honours .tsx and skips non-JavaScript files', () => {
  assert.equal(introducedSyntaxError('a.ts', 'foo(;', 'bar(;'), undefined);
  assert.match(introducedSyntaxError('a.ts', 'foo();', 'foo());') ?? '', /line 1/);
  assert.equal(introducedSyntaxError('a.tsx', 'const a = 1;', 'const a = <div />;'), undefined);
  assert.ok(introducedSyntaxError('a.ts', 'const a = 1;', 'const a = <div />;'));
  assert.equal(introducedSyntaxError('schema.prisma', 'model A {}', 'not ( valid'), undefined);
  assert.equal(introducedSyntaxError('query.sql', 'select 1;', 'select ((;'), undefined);
});

test('a bulk fix whose builder breaks one file leaves it byte-identical and still applies the others', (context) => {
  const { directory, read } = project(context, { 'broken.ts': original, 'fine.ts': original });
  const result = applyBulkFixes(
    [finding('bad', 'broken.ts', brokenAfter), finding('good', 'fine.ts', validAfter)],
    directory,
  );
  assert.equal(read('broken.ts'), original);
  assert.equal(read('fine.ts'), original.replace('compute(1, 2)', 'compute(2, 1)'));
  assert.equal(result.changedFiles, 1);
  assert.deepEqual(
    result.applied.map(({ id }: Finding) => id),
    ['good'],
  );
  assert.equal(result.refused[0].finding.id, 'bad');
  assert.match(result.refused[0].reason, /would introduce a syntax error/);
});

test('a bulk fix touching a refused file and another file applies to neither', (context) => {
  const { directory, read } = project(context, { 'broken.ts': original, 'other.ts': original });
  const spanning = finding('span', 'broken.ts', brokenAfter);
  spanning.fix.changes.push(finding('x', 'other.ts', validAfter).fix.changes[0]);
  const result = applyBulkFixes([spanning], directory);
  assert.equal(result.changedFiles, 0);
  assert.equal(read('broken.ts'), original);
  assert.equal(read('other.ts'), original);
});

test('performance --fix --only refuses a broken fix and applies a valid one', (context) => {
  const { directory, read } = project(context, { 'broken.ts': original, 'fine.ts': original });
  const previous = process.cwd();
  process.chdir(directory);
  const findings = [finding('bad', 'broken.ts', brokenAfter), finding('good', 'fine.ts', validAfter)];
  try {
    assert.equal(
      performance.applyChosenFixes(findings, ['bad', 'good'], { json: true, format: false, project: directory }),
      2,
    );
  } finally {
    process.chdir(previous);
  }
  assert.equal(read('broken.ts'), original);
  assert.equal(read('fine.ts'), original.replace('compute(1, 2)', 'compute(2, 1)'));
});

test('maintainability --fix --only refuses a broken fix and applies a valid one', (context) => {
  const { directory, read } = project(context, { 'broken.ts': original, 'fine.ts': original });
  const findings = [finding('bad', 'broken.ts', brokenAfter), finding('good', 'fine.ts', validAfter)];
  assert.equal(
    maintainability.applyChosenFixes(findings, ['bad', 'good'], directory, { json: true, format: false }),
    2,
  );
  assert.equal(read('broken.ts'), original);
  assert.equal(read('fine.ts'), original.replace('compute(1, 2)', 'compute(2, 1)'));
});

test('two fixes creating the same new file apply the first and leave the second for the next run', (context) => {
  const { directory, read } = project(context, { 'a.ts': original, 'b.ts': original });
  const helper = (id: string, file: string, body: string) => {
    const extraction = finding(id, file, validAfter);
    extraction.fix.changes.push({ file: 'helper.ts', line: 1, before: '', after: body, create: true });
    return extraction;
  };
  const same = helper('same', 'b.ts', 'export const helper = 1;\n');
  same.fix.changes.shift();
  const result = applyBulkFixes(
    [
      helper('first', 'a.ts', 'export const helper = 1;\n'),
      helper('second', 'b.ts', 'export const helper = 2;\n'),
      same,
    ],
    directory,
  );
  assert.equal(read('helper.ts'), 'export const helper = 1;\n');
  assert.equal(read('b.ts'), original);
  assert.deepEqual(
    result.applied.map(({ id }: Finding) => id),
    ['first', 'same'],
  );
  assert.equal(result.refused[0].finding.id, 'second');
  assert.match(result.refused[0].reason, /#first creates helper\.ts in this run/);
});

test('two fixes rewriting overlapping lines apply the first and leave the second for the next run', (context) => {
  const lines = 'const a = 1;\nconst b = 2;\nconst c = 3;\nconst d = 4;\n';
  const { directory, read } = project(context, { 'schema.ts': lines });
  const removal = (id: string, line: number, before: string, after: string): FixableFinding => ({
    id,
    ruleId: 'test-rule',
    message: 'test message',
    checker: 'test',
    file: 'schema.ts',
    line,
    fix: { changes: [{ file: 'schema.ts', line, before, after }] },
  });
  const result = applyBulkFixes(
    [
      removal('first', 1, 'const a = 1;\nconst b = 2;', 'const a = 1;'),
      removal('second', 2, 'const b = 2;\nconst c = 3;', 'const b = 2;'),
      removal('separate', 4, 'const d = 4;', 'const d = 5;'),
    ],
    directory,
  );
  assert.equal(read('schema.ts'), 'const a = 1;\nconst c = 3;\nconst d = 5;\n');
  assert.deepEqual(
    result.applied.map(({ id }: Finding) => id),
    ['first', 'separate'],
  );
  assert.equal(result.refused[0].finding.id, 'second');
  assert.match(result.refused[0].reason, /#first changes schema\.ts:2 in this run/);
});
