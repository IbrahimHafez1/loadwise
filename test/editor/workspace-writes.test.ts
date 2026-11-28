import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { buildDiagnostics } from '../../lib/editor/diagnostics.js';
import { createDismissals, dismissalsPath } from '../../lib/editor/dismissals.js';
import { readDiskDocument } from '../../lib/editor/editor-document.js';
import { fixAllEdit, fixEdit, missingFolders } from '../../lib/editor/fix-edits.js';
import { classifyChange, watchedGlobs } from '../../lib/editor/workspace-files.js';
import type { FixWorkspace } from '../../lib/editor/fix-edits.js';
import type { WorkspaceFix } from '../../lib/editor/diagnostics.js';

function temporaryFolder(context: TestContext): string {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'loadwise-writes-'));
  context.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  return folder;
}

// A junction needs no administrator rights on Windows; elsewhere it is an ordinary directory link.
function linkFolder(target: string, link: string): void {
  fs.symlinkSync(target, link, 'junction');
}

function diskWorkspace(): FixWorkspace {
  return {
    documentFor: readDiskDocument,
    uriFor: (filename) => 'file:///' + filename,
    keyOf: (filename) => filename,
    supportsDocumentChanges: true,
    canCreateFiles: true,
    failureHandling: undefined,
  };
}

const problems: string[] = [];
const options = { onProblem: (message: string) => problems.push(message) };

test('a dismissal file that does not parse is reported and never overwritten', async (context) => {
  const root = temporaryFolder(context);
  const stored = path.join(root, dismissalsPath);
  fs.mkdirSync(path.dirname(stored));
  fs.writeFileSync(stored, '[{"file": "a.ts", "ruleId": "x"},');
  problems.length = 0;
  const dismissals = createDismissals(root, options);
  assert.match(problems.join(), /dismissed\.json .* cannot be read/);
  await assert.rejects(dismissals.add({ file: path.join(root, 'a.ts'), ruleId: 'y' }), /left unchanged/);
  assert.equal(fs.readFileSync(stored, 'utf8'), '[{"file": "a.ts", "ruleId": "x"},');
  assert.equal(dismissals.has({ file: path.join(root, 'a.ts'), ruleId: 'y' }), false);
});

test('a reload of a broken dismissal file keeps the dismissals already shown', async (context) => {
  const root = temporaryFolder(context);
  const dismissals = createDismissals(root, options);
  const entry = { file: path.join(root, 'a.ts'), ruleId: 'x', lineText: 'a();' };
  await dismissals.add(entry);
  fs.writeFileSync(path.join(root, dismissalsPath), '{');
  dismissals.reload();
  assert.equal(dismissals.has(entry), true);
});

test('a failed dismissal write leaves the shown dismissals unchanged', async (context) => {
  const root = temporaryFolder(context);
  // A file where the .loadwise folder should be makes the write fail.
  fs.writeFileSync(path.join(root, '.loadwise'), '');
  const dismissals = createDismissals(root, options);
  const entry = { file: path.join(root, 'a.ts'), ruleId: 'x' };
  await assert.rejects(dismissals.add(entry));
  assert.equal(dismissals.has(entry), false);
  assert.deepEqual(dismissals.entries(), []);
});

test('a dismissal file larger than the limit is not parsed', (context) => {
  const root = temporaryFolder(context);
  const stored = path.join(root, dismissalsPath);
  fs.mkdirSync(path.dirname(stored));
  const entry = JSON.stringify({ file: 'a.ts', ruleId: 'x', lineText: 'a'.repeat(1000) });
  fs.writeFileSync(stored, '[' + Array.from({ length: 5000 }, () => entry).join(',') + ']');
  problems.length = 0;
  const dismissals = createDismissals(root, options);
  assert.deepEqual(dismissals.entries(), []);
  assert.match(problems.join(), /larger than 4 MB/);
});

test('a .loadwise link that leaves the workspace folder is never written through', async (context) => {
  const base = temporaryFolder(context);
  const root = path.join(base, 'shop');
  const outside = path.join(base, 'outside');
  fs.mkdirSync(root);
  fs.mkdirSync(outside);
  linkFolder(outside, path.join(root, '.loadwise'));
  const dismissals = createDismissals(root, options);
  await assert.rejects(dismissals.add({ file: path.join(root, 'a.ts'), ruleId: 'x' }), /outside the workspace/);
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('a fix that writes through a link out of the workspace folder is dropped', (context) => {
  const base = temporaryFolder(context);
  const root = path.join(base, 'shop');
  const outside = path.join(base, 'outside');
  fs.mkdirSync(root);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'orders.ts'), 'one();\n');
  fs.writeFileSync(path.join(root, 'orders.ts'), 'one();\n');
  linkFolder(outside, path.join(root, 'linked'));
  const finding = (file: string) => ({
    file: 'orders.ts',
    line: 1,
    column: 1,
    ruleId: 'array-repeated-membership',
    message: 'Slow.',
    fix: { changes: [{ file, line: 1, before: 'one();', after: 'ONE();' }] },
  });
  const [inside, linked, created] = buildDiagnostics(
    root,
    'loadwise perf',
    [finding('orders.ts'), finding('linked/orders.ts'), finding('linked/new/created.sql')],
    { documentFor: readDiskDocument },
  );
  assert.ok(inside.anchor.fix);
  assert.equal(linked.anchor.fix, undefined);
  assert.equal(created.anchor.fix, undefined);
});

test('a fix whose own changes touch the same lines is refused', (context) => {
  const root = temporaryFolder(context);
  const filename = path.join(root, 'orders.ts');
  fs.writeFileSync(filename, 'one();\ntwo();\n');
  const change = (after: string) => ({ file: 'orders.ts', filename, line: 1, before: 'one();', after });
  const fix: WorkspaceFix = { changes: [change('ONE();'), change('UNO();')], note: undefined, requiresReview: false };
  assert.match(String(fixEdit(fix, diskWorkspace()).error), /same lines twice/);
  assert.equal(fixAllEdit([fix], diskWorkspace()).applied, 0);
});

test('new files come before the edits of existing ones, and their missing folders are listed', (context) => {
  const root = temporaryFolder(context);
  const filename = path.join(root, 'orders.ts');
  fs.writeFileSync(filename, 'one();\n');
  const created = path.join(root, 'migrations', 'v1', '001.sql');
  const fix: WorkspaceFix = {
    changes: [
      { file: 'orders.ts', filename, line: 1, before: 'one();', after: 'ONE();' },
      { file: 'migrations/v1/001.sql', filename: created, line: 1, before: '', after: 'CREATE INDEX;\n', create: true },
    ],
    note: undefined,
    requiresReview: false,
  };
  const result = fixEdit(fix, diskWorkspace());
  assert.ok(result.edit, result.error);
  assert.deepEqual(result.createdFiles, [created]);
  assert.deepEqual(
    (result.edit.documentChanges ?? []).map((change) => ('kind' in change ? change.kind : 'edit')),
    ['create', 'edit', 'edit'],
  );
  assert.deepEqual(missingFolders([created]), [path.join(root, 'migrations'), path.join(root, 'migrations', 'v1')]);
});

test('templates, and a project setting with any file name, are inputs that rescan', () => {
  const root = path.resolve('workspace');
  assert.equal(classifyChange(root, path.join(root, 'src', 'App.vue')), 'source');
  assert.equal(classifyChange(root, path.join(root, 'index.html')), 'source');
  assert.equal(classifyChange(root, path.join(root, 'config', 'editor.json')), 'ignored');
  assert.equal(classifyChange(root, path.join(root, 'config', 'editor.json'), 'config/editor.json'), 'config');
  assert.match(watchedGlobs[0], /svelte/);
});

test('the files the security checker reads without a config are inputs that rescan', () => {
  const root = path.resolve('workspace');
  for (const name of ['Dockerfile', 'api.Dockerfile', '.env.production', 'docker-compose.yml', 'compose.yaml']) {
    assert.equal(classifyChange(root, path.join(root, 'deploy', name)), 'source', name);
  }
  assert.ok(watchedGlobs.includes('**/*{Dockerfile,dockerfile}*'));
  assert.ok(watchedGlobs.includes('**/.env*'));
});
