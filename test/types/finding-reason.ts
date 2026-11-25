import assert from 'node:assert/strict';
import type { Finding } from '../../lib/shared/types.js';

// The contextual reason of a finding the test expects to carry one.
export function reasonOf(finding: Finding | undefined): string {
  assert.ok(finding, 'expected a finding');
  assert.ok(finding.contextualReason, 'expected the finding to carry a contextual reason');
  return finding.contextualReason;
}
