'use strict';

// Shared by the exposure rule tests: findings of one rule, with and without installed types.
const assert = require('node:assert/strict');
const { lintBothWays } = require('./helpers.cjs');

function findingsOf(ruleId, source, files = {}) {
  const { typed, untyped } = lintBothWays(source, files);
  assert.ok(untyped.length <= typed.length);
  return typed.filter((finding) => finding.ruleId === ruleId);
}

// Findings shown by default, as the CLI selects them.
function defaultFindingsOf(ruleId, source, files) {
  return findingsOf(ruleId, source, files).filter((finding) => !finding.contextualReason);
}

module.exports = { findingsOf, defaultFindingsOf };
