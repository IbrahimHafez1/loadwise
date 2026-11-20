'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { once } = require('node:events');
const { watchTree } = require('../lib/recursive-watch.cjs');

const waitTimeoutMs = 10_000;
const pollMs = 25;

async function waitFor(condition, description) {
  const deadline = Date.now() + waitTimeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for ' + description);
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

function ignoreNodeModules(relative) {
  return relative.split(path.sep).includes('node_modules');
}

test('recursive watch reports create, edit, delete and new subfolders, skips ignored folders, and closes', { timeout: 60_000 }, async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'recursive-watch-'));
  fs.writeFileSync(path.join(root, 'existing.js'), 'one');
  fs.mkdirSync(path.join(root, 'node_modules', 'dep'), { recursive: true });
  fs.writeFileSync(path.join(root, 'node_modules', 'dep', 'index.js'), '');
  const watcher = watchTree(root, ignoreNodeModules);
  context.after(async () => {
    await watcher.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const events = [];
  const errors = [];
  watcher.on('all', (event, file) => events.push(event + ' ' + file));
  watcher.on('error', (error) => errors.push(error));
  await once(watcher, 'ready');
  assert.deepEqual(events, ['add existing.js'], 'initial walk adds existing files and skips ignored folders');

  fs.writeFileSync(path.join(root, 'created.ts'), 'a');
  await waitFor(() => events.includes('add created.ts'), 'create');

  fs.writeFileSync(path.join(root, 'existing.js'), 'two');
  await waitFor(() => events.includes('change existing.js'), 'edit');

  fs.rmSync(path.join(root, 'created.ts'));
  await waitFor(() => events.includes('unlink created.ts'), 'delete');

  const nested = path.join('feature', 'deep', 'route.ts');
  fs.mkdirSync(path.join(root, 'feature', 'deep'), { recursive: true });
  fs.writeFileSync(path.join(root, nested), 'b');
  await waitFor(() => events.includes('add ' + nested), 'file in a new subfolder');

  fs.renameSync(path.join(root, 'feature'), path.join(root, 'renamed'));
  await waitFor(
    () => events.includes('unlink ' + nested) && events.includes('add ' + path.join('renamed', 'deep', 'route.ts')),
    'renamed folder',
  );

  fs.writeFileSync(path.join(root, 'node_modules', 'dep', 'index.js'), 'changed');
  fs.writeFileSync(path.join(root, 'node_modules', 'dep', 'extra.js'), '');
  // A marker written after the ignored edits proves those were processed (and dropped) by the time it arrives.
  fs.writeFileSync(path.join(root, 'marker.json'), '{}');
  await waitFor(() => events.includes('add marker.json'), 'marker after ignored edits');
  assert.equal(events.filter((line) => line.includes('node_modules')).length, 0, 'ignored folder produced events');
  assert.deepEqual(errors, []);

  await watcher.close();
  const countAtClose = events.length;
  fs.writeFileSync(path.join(root, 'after-close.js'), '');
  fs.writeFileSync(path.join(root, 'existing.js'), 'three');
  // Nothing can arrive after close; waiting well past the settle delay shows none did.
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(events.length, countAtClose, 'no events after close');
});

test('recursive watch surfaces an error for a missing root', { timeout: 30_000 }, async () => {
  const root = path.join(os.tmpdir(), 'recursive-watch-missing-' + process.pid + '-' + Date.now());
  const watcher = watchTree(root, ignoreNodeModules);
  const [error] = await once(watcher, 'error');
  assert.equal(error.code, 'ENOENT');
  await watcher.close();
});
