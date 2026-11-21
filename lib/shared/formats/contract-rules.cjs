'use strict';

// Rules that default to an error under --fail-on contract.
const contractRules = {
  performance: new Set(['pg-transaction-on-pool']),
  maintainability: new Set(['file-placement', 'folder-boundary', 'data-access-boundary', 'query-mutates-state']),
  security: require('../../security/rule-ids.cjs').contractRules,
};

module.exports = { contractRules };
