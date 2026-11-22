'use strict';

// Regressions found by running loadwise on real projects (juice-shop, cuspa, infisical).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');
const { scan } = require('../../lib/maintainability/scan.cjs');
const { scanChangedFiles } = require('../../lib/maintainability/scan-changed.cjs');
const { applyChangesToText } = require('../../editor/apply-fix.cjs');
const { scanWithFixes } = require('../performance/site-fix-helpers.cjs');

test('maint skips an unparsable file with a note instead of failing the whole scan', async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loadwise-c4-maint-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'broken.ts'), "import { helper } from './helper';\nexport const = helper;\n");
  fs.writeFileSync(path.join(root, 'helper.ts'), 'export const helper = 1;\n');
  const notes = [];
  context.mock.method(console, 'error', (message) => notes.push(message));
  const policy = { exclude: [], boundaries: [], placement: [] };
  for (const parallelFrom of [Infinity, 1]) {
    const report = await scan(root, policy, { parallelFrom });
    assert.equal(report.dependencyFiles, 2);
    // The broken file still counts as importing helper.ts, so helper.ts is not reported unused.
    assert.ok(!report.findings.some((finding) => finding.file === 'helper.ts'));
  }
  const changed = await scanChangedFiles(root, policy, ['broken.ts', 'helper.ts']);
  assert.equal(changed.dependencyFiles, 2);
  const note = 'Note: broken.ts:2:14 Variable declaration expected. Skipped that file, which does not parse.';
  assert.deepEqual(notes, [note, note, note]);
});

// Just enough of Node's types for the rewritten files to type-check.
