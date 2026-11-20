'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { checkGraph } = require('../lib/graph.cjs');
const { loadPolicy } = require('../lib/project.cjs');

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

test('config folders accept a trailing slash', (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'maintainability-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(root, 'maintainability.config.json'),
    JSON.stringify({ exclude: ['generated/'], boundaries: [{ from: 'src/domain/', disallow: ['src/http/'] }] }),
  );
  const policy = loadPolicy(root);
  assert.deepEqual(policy.exclude, ['generated']);
  assert.deepEqual(policy.boundaries, [{ from: 'src/domain', disallow: ['src/http'] }]);
  fs.writeFileSync(path.join(root, 'maintainability.config.json'), JSON.stringify({ exclude: ['/'] }));
  assert.throws(() => loadPolicy(root), /project-relative/);
});
