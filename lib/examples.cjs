'use strict';

// Compact before/after snippets, one per ruleId. Each side stays within 2-6 lines so the CLI can print it inline.
const examples = {
  'dependency-cycle': {
    before: ['// a.ts: import { total } from "./b";', '// b.ts: import { total } from "./a";'],
    after: [
      '// shared.ts: export const total = (xs) => xs.length;',
      '// a.ts and b.ts: import { total } from "./shared";',
    ],
  },
  'folder-boundary': {
    before: [
      '// inner/service.ts',
      'import { loadCount } from "../outer/db";',
      'export const run = () => loadCount();',
    ],
    after: [
      '// inner/service.ts',
      'export const run = (count: number) => ({ count });',
      '// outer/handler.ts (allowed to use both)',
      'run(await loadCount());',
    ],
  },
  'duplicate-implementation': {
    before: ['const okA = (n) => n >= 1 && n <= 9;', 'const okB = (n) => n >= 1 && n <= 9;'],
    after: ['export const inRange = (n) => n >= 1 && n <= 9;', '// call inRange(n) from both sites'],
  },
  'high-branch-complexity': {
    before: [
      'if (kind === "a") return doA(x);',
      'if (kind === "b") return doB(x);',
      'if (kind === "c") return doC(x);',
      'return reject(x);',
    ],
    after: [
      'const handlers = { a: doA, b: doB, c: doC };',
      'const handle = handlers[kind] ?? reject;',
      'return handle(x);',
    ],
  },
  'deep-control-flow': {
    before: ['for (const item of items) {', '  if (item.ready) {', '    if (item.valid) save(item);', '  }', '}'],
    after: ['for (const item of items) {', '  if (!item.ready || !item.valid) continue;', '  save(item);', '}'],
  },
  'query-mutates-state': {
    before: ['/** @maintainabilityQuery */', 'current() { this.count += 1; return this.count; }'],
    after: ['/** @maintainabilityQuery */', 'current() { return this.count; }', 'increment() { this.count += 1; }'],
  },
  'file-placement': {
    before: ['// outside the declared folder', 'src/user.controller.ts'],
    after: ['// moved, imports updated', 'src/http/user.controller.ts'],
  },
};

function exampleFor(ruleId) {
  return examples[ruleId];
}

module.exports = { examples, exampleFor };
