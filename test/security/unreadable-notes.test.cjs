'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { findLockfile, readLockfilePackages } = require('../../lib/security/deps/lockfiles.cjs');

const yarnLock = '"alpha@^1.0.0":\n  version "1.0.0"\n';

function readWithNotes(manifestText) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loadwise-notes-'));
  fs.writeFileSync(path.join(root, 'yarn.lock'), yarnLock);
  if (manifestText !== undefined) fs.writeFileSync(path.join(root, 'package.json'), manifestText);
  const notes = [];
  const original = console.error;
  console.error = (message) => notes.push(message);
  try {
    readLockfilePackages(findLockfile(root));
  } finally {
    console.error = original;
    fs.rmSync(root, { recursive: true, force: true });
  }
  return notes;
}

test('an absent package.json next to a lockfile stays silent', () => {
  assert.deepEqual(readWithNotes(undefined), []);
});

test('a malformed package.json next to a lockfile prints one note', () => {
  const notes = readWithNotes('{ not json');
  assert.equal(notes.length, 1);
  assert.match(
    notes[0],
    /^Note: could not read .*package\.json \(SyntaxError\); direct dependencies there were not marked\.$/,
  );
  assert.deepEqual(readWithNotes('{ still not json'), [], 'the same cause is said once per run');
});
