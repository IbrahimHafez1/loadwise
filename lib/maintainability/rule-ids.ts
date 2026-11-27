import type { ImpactLevel } from '../shared/types.js';

const knownRules = new Set<string>([
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
  'unreferenced-file',
  'unused-export',
  'unused-import',
  'unused-local-variable',
  'stray-console',
  'deprecated-node-api',
]);

// Impact levels (see lib/shared/impact-levels.cjs) for every rule id a maintainability finding can
// carry. README
// criteria: high is a cycle that changes load-time behaviour, medium significant maintainability
// debt, low readability.
const impactByRule: Record<string, ImpactLevel> = {
  'dependency-cycle': 'high',
  'duplicate-implementation': 'medium',
  'high-branch-complexity': 'medium',
  'folder-boundary': 'medium',
  'data-access-boundary': 'medium',
  'query-mutates-state': 'medium',
  'syntax-error': 'medium',
  'large-module': 'low',
  'large-class': 'low',
  'deep-control-flow': 'low',
  'file-placement': 'low',
  'long-parameter-list': 'low',
  'unused-export': 'low',
  'unreferenced-file': 'low',
  'unused-import': 'low',
  'unused-local-variable': 'low',
  'stray-console': 'low',
  'deprecated-node-api': 'medium',
};

// One-line summaries of every rule above, used where a rule needs a fixed name (SARIF
// shortDescription) rather than the per-site finding message. The README row for each rule has the
// full evidence.
const descriptionByRule: Record<string, string> = {
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
  'syntax-error': 'A native parser could not read the file, so it is skipped and listed and the scan exits 2.',
  'unreferenced-file': 'A source file that nothing imports and that is not an entry point.',
  'unused-export': 'An export that no scanned file imports.',
  'unused-import': 'An imported name is never used in the file.',
  'unused-local-variable': 'A local variable is assigned but never read.',
  'stray-console': 'A console call in production code bypasses the logger, so its output has no level or structure.',
  'deprecated-node-api': 'A deprecated Node.js API is used: new Buffer(), url.parse() or fs.exists().',
};

export { knownRules, impactByRule, descriptionByRule };
