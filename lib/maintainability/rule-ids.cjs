'use strict';

const knownRules = new Set([
  'data-access-boundary',
  'deep-control-flow',
  'dependency-cycle',
  'duplicate-implementation',
  'file-placement',
  'folder-boundary',
  'high-branch-complexity',
  'query-mutates-state',
]);

module.exports = { knownRules };
