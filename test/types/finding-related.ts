import assert from 'node:assert/strict';
import type { Finding } from '../../lib/shared/types.js';
import type { SourceLocation } from '../../lib/maintainability/types/polyglot-scan.js';

// The other sites a graph or duplicate finding points at; the test expects the field to be present.
export function relatedOf(finding: Finding | undefined): readonly SourceLocation[] {
  assert.ok(finding, 'expected a finding');
  assert.ok(Array.isArray(finding.related), 'expected the finding to list related sites');
  return finding.related;
}
