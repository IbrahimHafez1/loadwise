'use strict';

const assert = require('node:assert/strict');
const { beforeEach, test } = require('node:test');
const { noteUnreadable, resetCoverageNotes } = require('../../lib/shared/coverage-notes.cjs');

beforeEach(resetCoverageNotes);

function capture(action) {
  const notes = [];
  const original = console.error;
  console.error = (message) => notes.push(message);
  try {
    action();
  } finally {
    console.error = original;
  }
  return notes;
}

const unreadable = (code) => Object.assign(new Error('boom'), { code });

test('an absent path is silent', () => {
  const notes = capture(() => {
    noteUnreadable({ error: unreadable('ENOENT'), location: 'a', consequence: 'skipped it' });
    noteUnreadable({ error: unreadable('ENOTDIR'), location: 'a', consequence: 'skipped it' });
  });
  assert.deepEqual(notes, []);
});

test('an extra absent code is silent', () => {
  const error = unreadable('MODULE_NOT_FOUND');
  assert.deepEqual(
    capture(() => noteUnreadable({ error, location: 'a', consequence: 'x', absentCodes: ['MODULE_NOT_FOUND'] })),
    [],
  );
});

test('an unreadable path notes once per cause and consequence', () => {
  const notes = capture(() => {
    noteUnreadable({ error: unreadable('EACCES'), location: 'a', consequence: 'skipped it' });
    noteUnreadable({ error: unreadable('EACCES'), location: 'b', consequence: 'skipped it' });
    noteUnreadable({ error: unreadable('EACCES'), location: 'c', consequence: 'ignored it' });
  });
  assert.deepEqual(notes, [
    'Note: could not read a (EACCES); skipped it.',
    'Note: could not read c (EACCES); ignored it.',
  ]);
});
