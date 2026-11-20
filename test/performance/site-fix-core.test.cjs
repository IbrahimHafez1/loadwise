'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

// Test builders are registered on a loaded builder module before the core reads the builder list.
const testBuilders = require('../../lib/performance/site-fixes/database.cjs');
const { buildFix, createFileCache } = require('../../lib/performance/site-fix.cjs');
const { applyFix } = require('../../editor/apply-fix.cjs');

const received = [];
testBuilders['test-schema-edit'] = (context) => {
  received.push(context);
  const offset = context.text.indexOf('}');
  return { edits: [{ start: offset, end: offset, text: '  @@index([userId])\n' }], note: 'Check the index.' };
};
testBuilders['test-create-file'] = (context) => {
  received.push(context);
  return { targets: [{ file: context.finding.newFile, create: true, text: context.finding.newText }] };
};

function tempDir(context) {
  const base = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Temp', 'AI-Work') : os.tmpdir();
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, 'backend-perf-core-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('a finding in a non-JS file gets the raw text and no parsed node', (context) => {
  const schema = path.join(tempDir(context), 'schema.prisma');
  fs.writeFileSync(schema, 'model Post {\n  userId Int\n}\n');
  received.length = 0;
  const fix = buildFix({ ruleId: 'test-schema-edit', file: schema, line: 2, column: 3 }, createFileCache());
  assert.equal(received[0].node, undefined);
  assert.equal(received[0].sourceFile, undefined);
  assert.equal(received[0].text, 'model Post {\n  userId Int\n}\n');
  assert.deepEqual(fix, {
    changes: [{ file: schema, line: 3, before: '}', after: '  @@index([userId])\n}' }],
    note: 'Check the index.',
  });
});

test('a finding without a file can create a new file', (context) => {
  const migration = path.join(tempDir(context), 'migrations', '001_index.sql');
  const finding = {
    ruleId: 'test-create-file',
    target: 'public.posts',
    newFile: migration,
    newText: 'CREATE INDEX;\n',
  };
  received.length = 0;
  const fix = buildFix(finding, createFileCache());
  assert.equal(received[0].text, undefined);
  assert.deepEqual(fix.changes, [{ file: migration, line: 1, before: '', after: 'CREATE INDEX;\n', create: true }]);
});

test('a created file is dropped when a different file exists or a JS file does not parse', (context) => {
  const root = tempDir(context);
  const existing = path.join(root, 'taken.sql');
  fs.writeFileSync(existing, 'SELECT 1;\n');
  const build = (newFile, newText) => buildFix({ ruleId: 'test-create-file', newFile, newText }, createFileCache());
  assert.equal(build(existing, 'CREATE INDEX;\n'), undefined);
  assert.ok(build(existing, 'SELECT 1;\n'), 'an identical file stays a fix so applying it reports already applied');
  assert.equal(build(path.join(root, 'broken.ts'), 'export class {'), undefined);
  assert.ok(build(path.join(root, 'fine.ts'), 'export class Migration {}\n'));
});

test('applying a created file writes it once and refuses to overwrite other content', () => {
  const files = new Map();
  const access = {
    readFile: (file) => {
      if (!files.has(file)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return files.get(file);
    },
    writeFile: (file, text) => files.set(file, text),
  };
  const fix = { changes: [{ file: 'm.sql', line: 1, before: '', after: 'CREATE INDEX;\n', create: true }] };
  assert.deepEqual(applyFix(fix, access), { files: ['m.sql'] });
  assert.equal(files.get('m.sql'), 'CREATE INDEX;\n');
  // A fix whose every file is already applied reports the bare message, so callers can treat it as done.
  assert.equal(applyFix(fix, access).error, 'already applied');
  files.set('m.sql', 'other');
  assert.match(applyFix(fix, access).error, /already exists with different content/);
  assert.equal(files.get('m.sql'), 'other');
});

test('a fix that creates a file prints the whole file as added lines', () => {
  const { findingDetailLines } = require('../../lib/performance/finding-text.cjs');
  const change = { file: 'migrations/1_add.sql', line: 1, before: '', after: 'CREATE INDEX a ON t (b);', create: true };
  assert.deepEqual(findingDetailLines({ fix: { changes: [change] } }), [
    '  Fix (migrations/1_add.sql, new file):',
    '    + CREATE INDEX a ON t (b);',
  ]);
});
