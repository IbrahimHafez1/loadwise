import type { ImpactLevel } from '../shared/types.js';

// Keep sorted by rule id; test/shared/registry-order.test.ts checks it.
const knownRules = new Set<string>([
  'data-access-boundary',
  'deep-control-flow',
  'dependency-cycle',
  'deprecated-node-api',
  'double-type-assertion',
  'duplicate-implementation',
  'file-placement',
  'focused-test-committed',
  'folder-boundary',
  'high-branch-complexity',
  'large-class',
  'large-module',
  'long-parameter-list',
  'query-mutates-state',
  'stray-console',
  'ts-suppression-without-reason',
  'tsconfig-strict-disabled',
  'unreferenced-file',
  'unused-export',
  'unused-import',
  'unused-local-variable',
]);

// Impact levels (see lib/shared/impact-levels.cjs) for every rule id a maintainability finding can
// carry. README
// criteria: high is a cycle that changes load-time behaviour, medium significant maintainability
// debt, low readability.
// Keep sorted by rule id; test/shared/registry-order.test.ts checks it.
const impactByRule: Record<string, ImpactLevel> = {
  'data-access-boundary': 'medium',
  'deep-control-flow': 'low',
  'dependency-cycle': 'high',
  'deprecated-node-api': 'medium',
  'double-type-assertion': 'low',
  'duplicate-implementation': 'medium',
  'file-placement': 'low',
  'focused-test-committed': 'medium',
  'folder-boundary': 'medium',
  'high-branch-complexity': 'medium',
  'large-class': 'low',
  'large-module': 'low',
  'long-parameter-list': 'low',
  'query-mutates-state': 'medium',
  'stray-console': 'low',
  'syntax-error': 'medium',
  'ts-suppression-without-reason': 'low',
  'tsconfig-strict-disabled': 'medium',
  'unreferenced-file': 'low',
  'unused-export': 'low',
  'unused-import': 'low',
  'unused-local-variable': 'low',
};

// One-line summaries of every rule above, used where a rule needs a fixed name (SARIF
// shortDescription) rather than the per-site finding message. The README row for each rule has the
// full evidence.
// Keep sorted by rule id; test/shared/registry-order.test.ts checks it.
const descriptionByRule: Record<string, string> = {
  'data-access-boundary': 'A file outside the approved paths imports a configured database driver or ORM.',
  'deep-control-flow': 'Control structures are nested four levels deep.',
  'dependency-cycle': 'An eager chain of internal imports leads back to the module it started from.',
  'deprecated-node-api': 'A deprecated Node.js API is used: new Buffer(), url.parse() or fs.exists().',
  'double-type-assertion': 'A value is cast through unknown or any to a second type, bypassing the type checker.',
  'duplicate-implementation': 'Substantial functions share the same implementation.',
  'file-placement': 'A file with a configured suffix sits outside its allowed folders.',
  'focused-test-committed': 'A committed .only, fit or fdescribe makes the test runner skip every other test.',
  'folder-boundary': 'An import crosses a folder boundary the team declared.',
  'high-branch-complexity': 'A function reaches a branch complexity score of 15.',
  'large-class': 'A class has more than 30 methods, accessors, constructors or function-valued fields.',
  'large-module': 'A file has more than 600 lines of code.',
  'long-parameter-list': 'A function takes more than 5 positional parameters.',
  'query-mutates-state': 'A method marked @maintainabilityQuery writes through this.',
  'stray-console': 'A console call in production code bypasses the logger, so its output has no level or structure.',
  'syntax-error': 'A native parser could not read the file, so it is skipped and listed and the scan exits 2.',
  'ts-suppression-without-reason': 'A @ts-ignore, @ts-expect-error or @ts-nocheck directive has no explanation.',
  'tsconfig-strict-disabled': 'A tsconfig turns off strict type checking.',
  'unreferenced-file': 'A source file that nothing imports and that is not an entry point.',
  'unused-export': 'An export that no scanned file imports.',
  'unused-import': 'An imported name is never used in the file.',
  'unused-local-variable': 'A local variable is assigned but never read.',
};

export { knownRules, impactByRule, descriptionByRule };
