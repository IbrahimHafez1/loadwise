import assert from 'node:assert/strict';
import type { FileTarget, FixResult, TextEdit } from '../../lib/shared/types.js';

// The edits of a site-fix result the test expects to edit the finding's own file.
export function requireEdits(result: FixResult): TextEdit[] {
  assert.ok(result.edits, 'expected the fix to carry edits');
  return result.edits;
}

// The file targets of a site-fix result the test expects to touch other files.
export function requireTargets(result: FixResult): FileTarget[] {
  assert.ok(result.targets, 'expected the fix to carry file targets');
  return result.targets;
}
