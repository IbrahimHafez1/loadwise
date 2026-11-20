'use strict';

// Rules that enforce a declared contract or policy. They fail a check under --fail-on contract and cannot be dismissed
// with a review comment, so every output format reports them at error level.
const contractRules = {
  performance: new Set(['pg-transaction-on-pool']),
  maintainability: new Set(['file-placement', 'folder-boundary', 'data-access-boundary', 'query-mutates-state']),
};

module.exports = { contractRules };
