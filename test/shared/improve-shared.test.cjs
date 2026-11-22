'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable, Writable } = require('node:stream');
const test = require('node:test');
const { replaceBlocks } = require('../../lib/shared/managed-blocks.cjs');
const { runReviewMcp } = require('../../lib/shared/review-mcp.cjs');
const { writeFileAtomic } = require('../../lib/shared/atomic-write.cjs');

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


test('writeFileAtomic replaces through a temporary file and keeps the mode and symlink target', (context) => {
  const root = temporaryDirectory(context, 'loadwise-improve-atomic-');
  const target = path.join(root, 'hook');
  fs.writeFileSync(target, 'old', { mode: 0o755 });
  writeFileAtomic(target, 'new');
  assert.equal(fs.readFileSync(target, 'utf8'), 'new');
  if (process.platform !== 'win32') assert.equal(fs.statSync(target).mode & 0o777, 0o755);
  assert.deepEqual(fs.readdirSync(root), ['hook']);
  const link = path.join(root, 'link');
  try {
    fs.symlinkSync(target, link);
  } catch {
    return;
  }
  writeFileAtomic(link, 'through link');
  assert.ok(fs.lstatSync(link).isSymbolicLink());
  assert.equal(fs.readFileSync(target, 'utf8'), 'through link');
});

test('review-mcp ignores blank and whitespace-only stdin lines', async () => {
  let transcript = '';
  const output = new Writable({
    write(chunk, _encoding, done) {
      transcript += chunk;
      done();
    },
  });
  const ping = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' });
  const input = Readable.from(['\n', '   \t\n', ping + '\n', '\r\n']);
  assert.equal(await runReviewMcp(process.cwd(), input, output), 0);
  const replies = transcript.trimEnd().split('\n').map(JSON.parse);
  assert.equal(replies.length, 1);
  assert.equal(replies[0].id, 1);
});
