import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

// Test builders are registered on a loaded builder module before the core reads the builder list.
import testBuilders from '../../lib/performance/site-fixes/database.js';
import { buildFix, createFileCache, loadBuilders } from '../../lib/performance/site-fix.js';
import { applyFix } from '../../editor/apply-fix.cjs';
import type { TestContext } from 'node:test';
import type { Finding, SiteFixBuilder, SiteFixInput } from '../../lib/shared/types.js';
import type { FileAccess } from '../../editor/apply-fix.cjs';
import { findingDetailLines } from '../../lib/performance/finding-text.js';

const registeredBuilders: Record<string, SiteFixBuilder> = testBuilders;
const received: SiteFixInput[] = [];
registeredBuilders['test-schema-edit'] = (input) => {
  received.push(input);
  const offset = (input.text ?? '').indexOf('}');
  return { edits: [{ start: offset, end: offset, text: '  @@index([userId])\n' }], note: 'Check the index.' };
};
registeredBuilders['test-create-file'] = (input) => {
  received.push(input);
  const { newFile, newText } = input.finding;
  assert.ok(typeof newFile === 'string' && typeof newText === 'string');
  return { targets: [{ file: newFile, create: true, text: newText }] };
};

await loadBuilders();

function tempDir(context: TestContext) {
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
  const fix = buildFix(
    { ruleId: 'test-schema-edit', message: '', file: schema, line: 2, column: 3 },
    createFileCache(),
  );
  assert.equal(received[0]?.node, undefined);
  assert.equal(received[0]?.sourceFile, undefined);
  assert.equal(received[0]?.text, 'model Post {\n  userId Int\n}\n');
  assert.deepEqual(fix, {
    changes: [{ file: schema, line: 3, before: '}', after: '  @@index([userId])\n}' }],
    note: 'Check the index.',
  });
});

test('a finding without a file can create a new file', (context) => {
  const migration = path.join(tempDir(context), 'migrations', '001_index.sql');
  const finding: Finding = {
    ruleId: 'test-create-file',
    message: '',
    target: 'public.posts',
    newFile: migration,
    newText: 'CREATE INDEX;\n',
  };
  received.length = 0;
  const fix = buildFix(finding, createFileCache());
  assert.equal(received[0]?.text, undefined);
  assert.ok(fix);
  assert.deepEqual(fix.changes, [{ file: migration, line: 1, before: '', after: 'CREATE INDEX;\n', create: true }]);
});

test('a created file is dropped when a different file exists or a JS file does not parse', (context) => {
  const root = tempDir(context);
  const existing = path.join(root, 'taken.sql');
  fs.writeFileSync(existing, 'SELECT 1;\n');
  const build = (newFile: string, newText: string) =>
    buildFix({ ruleId: 'test-create-file', message: '', newFile, newText }, createFileCache());
  assert.equal(build(existing, 'CREATE INDEX;\n'), undefined);
  assert.ok(build(existing, 'SELECT 1;\n'), 'an identical file stays a fix so applying it reports already applied');
  assert.equal(build(path.join(root, 'broken.ts'), 'export class {'), undefined);
  assert.ok(build(path.join(root, 'fine.ts'), 'export class Migration {}\n'));
});

test('applying a created file writes it once and refuses to overwrite other content', () => {
  const files = new Map<string, string>();
  const access: FileAccess = {
    readFile: (file: string) => {
      if (!files.has(file)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return files.get(file);
    },
    writeFile: (file: string, text: string) => {
      files.set(file, text);
    },
  };
  const fix = { changes: [{ file: 'm.sql', line: 1, before: '', after: 'CREATE INDEX;\n', create: true }] };
  assert.deepEqual(applyFix(fix, access), { files: ['m.sql'] });
  assert.equal(files.get('m.sql'), 'CREATE INDEX;\n');
  // A fix whose every file is already applied reports the bare message, so callers can treat it as
  // done.
  assert.equal(applyFix(fix, access).error, 'already applied');
  files.set('m.sql', 'other');
  assert.match(applyFix(fix, access).error ?? '', /already exists with different content/);
  assert.equal(files.get('m.sql'), 'other');
});

test('a fix that creates a file prints the whole file as added lines', () => {
  const change = { file: 'migrations/1_add.sql', line: 1, before: '', after: 'CREATE INDEX a ON t (b);', create: true };
  assert.deepEqual(findingDetailLines({ ruleId: 'test-create-file', message: '', fix: { changes: [change] } }), [
    '  Fix (migrations/1_add.sql, new file):',
    '    + CREATE INDEX a ON t (b);',
  ]);
});
