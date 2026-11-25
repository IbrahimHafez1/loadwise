import assert from 'node:assert/strict';
import type { Finding } from '../../lib/shared/types.js';
import type { FindingComparison } from '../../lib/maintainability/types/finding-comparison.js';

function isComparison(value: unknown): value is FindingComparison {
  return typeof value === 'object' && value !== null && 'before' in value && 'code' in value && 'inline' in value;
}

// The before/after rewrite of a finding the test expects to carry one.
export function comparisonOf(finding: Finding | undefined): FindingComparison {
  assert.ok(finding, 'expected a finding');
  const { comparison } = finding;
  assert.ok(isComparison(comparison), 'expected the finding to carry a comparison');
  return comparison;
}
