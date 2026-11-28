import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { once, EventEmitter } from 'node:events';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { listenForEditorRefresh, notifyEditor } from '../../lib/performance/editor-signal.js';
import { signalDirectory } from '../../lib/shared/notify-editor.js';

const cli = path.resolve(import.meta.dirname, '../../bin/loadwise.js');
function workspace(context: TestContext) {
  const base = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Temp', 'AI-Work') : os.tmpdir();
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, 'terminal-refresh-'));
  const source = path.join(root, 'sample.ts');
  fs.writeFileSync(source, 'export const ok = true;');
  context.after(() => {
    const directory = signalDirectory(root);
    if (fs.existsSync(directory)) fs.rmdirSync(directory);
    fs.unlinkSync(source);
    fs.rmdirSync(root);
  });
  return root;
}

test('a successful terminal source scan refreshes all listeners, re-arms, and leaves JSON and status intact', async (context) => {
  const root = workspace(context);
  const directory = signalDirectory(root);
  const ordinary = () =>
    spawnSync(process.execPath, [cli, 'perf', 'sample.ts', '--json'], { cwd: root, encoding: 'utf8' });
  const baseline = ordinary();
  assert.equal(baseline.status, 0);
  assert.doesNotThrow(() => JSON.parse(baseline.stdout));
  assert.equal(fs.existsSync(directory), false);
  const events = new EventEmitter();
  const first = listenForEditorRefresh(root, () => events.emit('first'));
  const second = listenForEditorRefresh(root, () => events.emit('second'));
  const controller = new AbortController();
  // Production has the source watcher as a live handle. Keep this isolated sender test alive while
  // events arrive.
  // Shared CI runners run eight test files at once, so the terminal scan can take several times longer there.
  const deadline = setTimeout(() => controller.abort(), process.env.CI ? 60000 : 10000);
  try {
    assert.equal(fs.readdirSync(directory).length, 2);
    const silent = spawnSync(process.execPath, [cli, 'perf', 'sample.ts', '--json'], {
      cwd: root,
      env: { ...process.env, LOADWISE_EDITOR_SCAN: '1' },
      encoding: 'utf8',
    });
    assert.equal(silent.stdout, baseline.stdout);
    assert.equal(fs.readdirSync(directory).length, 2);
    const invalid = spawnSync(process.execPath, [cli, 'perf', '--fail-on', 'invalid'], { cwd: root });
    assert.equal(invalid.status, 2);
    assert.equal(fs.readdirSync(directory).length, 2);
    const { signal } = controller;
    const active = Promise.all([once(events, 'first', { signal }), once(events, 'second', { signal })]);
    const repeated = ordinary();
    assert.equal(repeated.status, baseline.status);
    assert.equal(repeated.stdout, baseline.stdout);
    await active;
    assert.equal(fs.readdirSync(directory).length, 2);
    first.close();
    const remaining = once(events, 'second', { signal });
    notifyEditor(root);
    await remaining;
    assert.equal(fs.readdirSync(directory).length, 1);
  } finally {
    clearTimeout(deadline);
    first.close();
    second.close();
  }
});

test('a directory link cannot redirect terminal notifications or listener registrations', (context) => {
  const root = workspace(context);
  const target = path.join(root, 'unrelated');
  fs.mkdirSync(target);
  const marker = path.join(target, 'watch-' + '0'.repeat(32));
  fs.writeFileSync(marker, 'outside');
  const link = signalDirectory(root);
  try {
    fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
    notifyEditor(root);
    const listener = listenForEditorRefresh(root, () => assert.fail('unexpected refresh'));
    listener.close();
    assert.equal(fs.readFileSync(marker, 'utf8'), 'outside');
    assert.deepEqual(fs.readdirSync(target), [path.basename(marker)]);
  } finally {
    if (fs.lstatSync(link, { throwIfNoEntry: false })?.isSymbolicLink()) fs.unlinkSync(link);
    fs.unlinkSync(marker);
    fs.rmdirSync(target);
  }
});
