// Shared by the exposure rule tests: findings of one rule, with and without installed types.
import assert from 'node:assert/strict';
import { lintBothWays } from './helpers.cjs';
import type { LocatedFinding } from '../types/security.cjs';

function findingsOf(ruleId: string, source: string, files: Record<string, string> = {}) {
  const { typed, untyped } = lintBothWays(source, files);
  assert.ok(untyped.length <= typed.length);
  return typed.filter((finding: LocatedFinding) => finding.ruleId === ruleId);
}

// Findings shown by default, as the CLI selects them.
function defaultFindingsOf(ruleId: string, source: string, files: Record<string, string> = {}) {
  return findingsOf(ruleId, source, files).filter((finding: LocatedFinding) => !finding.contextualReason);
}

export { findingsOf, defaultFindingsOf };
