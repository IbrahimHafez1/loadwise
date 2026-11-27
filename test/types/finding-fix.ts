import assert from 'node:assert/strict';
import type { Finding, FindingFix } from '../../lib/shared/types.js';

// The fix of a finding the test expects to carry one.
export function fixOf(finding: Finding | undefined): FindingFix {
  assert.ok(finding, 'expected a finding');
  assert.ok(finding.fix, 'expected the finding to carry a fix');
  return finding.fix;
}

// The note of a finding's fix, for tests that match on it.
export function noteOf(finding: Finding | undefined): string {
  const { note } = fixOf(finding);
  assert.ok(note, 'expected the fix to carry a note');
  return note;
}

// The file a finding was reported in.
export function fileOf(finding: Finding | undefined): string {
  assert.ok(finding, 'expected a finding');
  assert.ok(finding.file, 'expected the finding to name a file');
  return finding.file;
}

// The line a finding was reported on.
export function lineOf(finding: Finding | undefined): number {
  assert.ok(finding, 'expected a finding');
  assert.ok(finding.line, 'expected the finding to carry a line');
  return finding.line;
}

// The note of a fix result (or fix) the test expects to carry one.
export function requireNote(owner: { note?: string }): string {
  assert.ok(owner.note, 'expected a note');
  return owner.note;
}

// A text the test expects to exist, such as the combined `after` text of a finding's changes.
export function requireText(text: string | undefined): string {
  assert.ok(text !== undefined, 'expected a text');
  return text;
}
