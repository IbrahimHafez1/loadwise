'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { checkGraph } = require('../lib/graph.cjs');

test('folder boundaries accept an exact file name as the source or the disallowed target', () => {
  const files = ['src/domain/a.ts', 'src/domain/b.ts', 'src/http/handler.ts', 'src/http/other.ts'];
  const edges = [
    { from: 'src/domain/a.ts', to: 'src/http/handler.ts', line: 1, column: 1 },
    { from: 'src/domain/a.ts', to: 'src/http/other.ts', line: 2, column: 1 },
    { from: 'src/domain/b.ts', to: 'src/http/handler.ts', line: 3, column: 1 },
  ];
  const findings = checkGraph({
    files,
    edges,
    boundaries: [{ from: 'src/domain/a.ts', disallow: ['src/http/handler.ts'] }],
  });
  assert.deepEqual(
    findings.map((finding) => [finding.file, finding.line, finding.ruleId]),
    [['src/domain/a.ts', 1, 'folder-boundary']],
  );
});

