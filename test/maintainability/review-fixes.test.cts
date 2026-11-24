import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { checkGraph } from '../../lib/maintainability/graph.cjs';
import { loadPolicy } from '../../lib/maintainability/project.cjs';

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
