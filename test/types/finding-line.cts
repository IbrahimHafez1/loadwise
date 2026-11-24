import assert from 'node:assert/strict';
import type { Finding } from '../../lib/shared/types.cjs';

// The line a finding was reported on.
export function lineOfFinding(finding: Finding): number {
  assert.ok(finding.line !== undefined, 'expected the finding to carry a line');
  return finding.line;
}
