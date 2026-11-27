import assert from 'node:assert/strict';
import type { FindingFix } from '../../lib/shared/types.js';

// The note of a fix the test expects to carry one.
export function fixNoteOf(fix: FindingFix): string {
  assert.ok(fix.note, 'expected the fix to carry a note');
  return fix.note;
}
