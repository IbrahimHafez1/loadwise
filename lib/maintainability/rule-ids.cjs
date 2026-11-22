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
  'sql-insert-truncated-at-semicolon',
  'swallowed-error',
  'unreferenced-file',
  'unused-export',
]);

// Impact levels (see lib/shared/impact-levels.cjs) for every rule id a maintainability finding can carry. README
// criteria: high is a cycle that changes load-time behaviour, medium significant maintainability debt, low readability.
const impactByRule = {
  'dependency-cycle': 'high',
  'sql-insert-truncated-at-semicolon': 'high',
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

// One-line summaries of every rule above, used where a rule needs a fixed name (SARIF shortDescription) rather than
// the per-site finding message. The README row for each rule has the full evidence.
const descriptionByRule = {
  'data-access-boundary': 'A file outside the approved paths imports a configured database driver or ORM.',
  'deep-control-flow': 'Control structures are nested four levels deep.',
  'dependency-cycle': 'An eager chain of internal imports leads back to the module it started from.',
  'duplicate-implementation': 'Substantial functions share the same implementation.',
  'file-placement': 'A file with a configured suffix sits outside its allowed folders.',
  'folder-boundary': 'An import crosses a folder boundary the team declared.',
  'high-branch-complexity': 'A function reaches a branch complexity score of 15.',
  'large-class': 'A class has more than 30 methods, accessors, constructors or function-valued fields.',
  'large-module': 'A file has more than 600 lines of code.',
  'long-parameter-list': 'A function takes more than 5 positional parameters.',
  'query-mutates-state': 'A method marked @maintainabilityQuery writes through this.',
  'sql-insert-truncated-at-semicolon': 'A SQL dump parser ends INSERT values at a semicolon inside quoted text.',
  'swallowed-error': 'A catch block drops the error and the code after the try carries on as if it succeeded.',
  'syntax-error': 'A native parser could not read the file, so it is skipped and listed and the scan exits 2.',
  'unreferenced-file': 'A source file that nothing imports and that is not an entry point.',
  'unused-export': 'An export that no scanned file imports.',
};

module.exports = { knownRules, impactByRule, descriptionByRule };
