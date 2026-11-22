'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable, Writable } = require('node:stream');
const test = require('node:test');
const { replaceBlocks } = require('../../lib/shared/managed-blocks.cjs');

const bin = path.resolve(__dirname, '../../bin/loadwise.cjs');
require('./history-test-state.cjs').isolateHistory();
const blockMarker = '# >>> loadwise pre-commit';

function temporaryDirectory(context, prefix) {
  const base = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Temp', 'AI-Work') : os.tmpdir();
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, prefix));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function hookRepository(context, existingHook) {
  const root = temporaryDirectory(context, 'loadwise-improve-hook-');
  spawnSync('git', ['init', '-q'], { cwd: root });
  fs.writeFileSync(path.join(root, 'package.json'), '{}');
  const hookFile = path.join(root, '.git', 'hooks', 'pre-commit');
  fs.mkdirSync(path.dirname(hookFile), { recursive: true });
  fs.writeFileSync(hookFile, existingHook);
  const installHook = (...args) =>
    spawnSync(process.execPath, [bin, 'agent', 'init', ...args], { cwd: root, encoding: 'utf8' });
  return { root, hookFile, installHook };
}

test('a start marker that lost its end marker never takes the user text after it', () => {
  const pairs = [['<!-- start -->', '<!-- end -->']];
  const block = '<!-- start -->\nnew\n<!-- end -->';
  const damaged = '# Notes\n\n<!-- start -->\nold body\n\nUser text that must stay.\n';
  const firstInstall = replaceBlocks(damaged, pairs, block);
  assert.equal(firstInstall, '# Notes\n\n' + block + '\nold body\n\nUser text that must stay.\n');
  // A lone start marker followed later by a complete block: only the marker line goes.
  const appendedLater = damaged + '\n' + block + '\n';
  const reinstalled = replaceBlocks(appendedLater, pairs, block);
  assert.ok(reinstalled.includes('User text that must stay.'), reinstalled);
  assert.equal(reinstalled.match(/<!-- start -->/g).length, 1);
  assert.ok(!replaceBlocks(appendedLater, pairs).includes('<!-- start -->'));
  assert.ok(replaceBlocks(appendedLater, pairs).includes('User text that must stay.'));
});

