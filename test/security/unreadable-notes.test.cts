import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { findLockfile, readLockfilePackages } from '../../lib/security/deps/lockfiles.cjs';

const yarnLock = '"alpha@^1.0.0":\n  version "1.0.0"\n';

function readWithNotes(manifestText?: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loadwise-notes-'));
  fs.writeFileSync(path.join(root, 'yarn.lock'), yarnLock);
  if (manifestText !== undefined) fs.writeFileSync(path.join(root, 'package.json'), manifestText);
  const notes: string[] = [];
  const original = console.error;
  console.error = (message: string) => notes.push(message);
  try {
    const location = findLockfile(root);
    assert.ok(location);
    readLockfilePackages(location);
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
