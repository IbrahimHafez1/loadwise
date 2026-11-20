'use strict';

const knownRules = new Set([
  'data-access-boundary',
  'deep-control-flow',
  'dependency-cycle',
  'duplicate-implementation',
  'file-placement',
  'folder-boundary',
  'high-branch-complexity',
  'large-class',
  'large-module',
  'long-parameter-list',
  'query-mutates-state',
  'swallowed-error',
  'unreferenced-file',
  'unused-export',
]);

// Impact levels (see lib/shared/impact-levels.cjs) for every rule id a maintainability finding can carry. README
// criteria: high is a cycle that changes load-time behaviour, medium significant maintainability debt, low readability.
const impactByRule = {
  'dependency-cycle': 'high',
  'duplicate-implementation': 'medium',
  'high-branch-complexity': 'medium',
  'folder-boundary': 'medium',
  'data-access-boundary': 'medium',
  'query-mutates-state': 'medium',
  'syntax-error': 'medium',
  'swallowed-error': 'medium',
  'large-module': 'medium',
  'large-class': 'medium',
  'deep-control-flow': 'low',
  'file-placement': 'low',
  'long-parameter-list': 'low',
  'unused-export': 'low',
  'unreferenced-file': 'low',
};

module.exports = { knownRules, impactByRule };
