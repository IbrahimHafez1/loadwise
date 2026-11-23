'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const ts = require('typescript');
const { analyzeFunctions } = require('../../lib/maintainability/functions.cjs');

test('a flat else-if chain with block bodies is not deep nesting', () => {
  const branches = Array.from({ length: 8 }, (_, index) => `else if (kind === ${index}) { handle(${index}); }`);
  const source = `function route(kind) { if (kind < 0) { handle(-1); } ${branches.join(' ')} else { handle(9); } }`;
  const findings = analyzeFunctions(
    ts.createSourceFile('src/route.ts', source, ts.ScriptTarget.Latest),
    'src/route.ts',
  );
  assert.deepEqual(
    findings.filter((finding) => finding.ruleId === 'deep-control-flow'),
    [],
  );
});
