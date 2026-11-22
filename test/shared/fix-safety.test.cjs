'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { applyBulkFixes } = require('../../lib/shared/fix.cjs');
const { introducedSyntaxError } = require('../../lib/shared/fix-safety.cjs');
const performance = require('../../lib/performance/fix-cli.cjs');
const maintainability = require('../../lib/maintainability/fix-cli.cjs');

const original = 'const total = compute(1, 2);\nexport { total };\n';
const brokenAfter = 'const total = compute(1, 2));\n);';
const validAfter = 'const total = compute(2, 1);';

function project(context, files) {
  const base = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Temp', 'AI-Work') : os.tmpdir();
  fs.mkdirSync(base, { recursive: true });
  const directory = fs.mkdtempSync(path.join(base, 'loadwise-fix-safety-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(directory, name), text);
  return { directory, read: (file) => fs.readFileSync(path.join(directory, file), 'utf8') };
}

function finding(id, file, after) {
  return {
    id,
    ruleId: 'test-rule',
    checker: 'test',
    file,
    line: 1,
    fix: { changes: [{ file, line: 1, before: 'const total = compute(1, 2);', after }] },
  };
}

test('the syntax comparison ignores existing errors, honours .tsx and skips non-JavaScript files', () => {
  assert.equal(introducedSyntaxError('a.ts', 'foo(;', 'bar(;'), undefined);
  assert.match(introducedSyntaxError('a.ts', 'foo();', 'foo());'), /line 1/);
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
    result.applied.map(({ id }) => id),
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
