'use strict';

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
  'deep-control-flow': 'low',
  'file-placement': 'low',
};

module.exports = { impactByRule };
