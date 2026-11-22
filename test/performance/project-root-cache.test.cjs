'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { findProjectRoot, useSnapshot } = require('../../lib/performance/schema/context.cjs');

test('the project root is shared for the scan and looked up again for the next one', (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'project-root-cache-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const nested = path.join(root, 'src', 'deep');
  fs.mkdirSync(nested, { recursive: true });
  useSnapshot(undefined);
  assert.equal(findProjectRoot(nested), nested);
  fs.writeFileSync(path.join(root, 'package.json'), '{}');
  assert.equal(findProjectRoot(nested), nested, 'the earlier answer is reused during the scan');
  useSnapshot(undefined);
  assert.equal(findProjectRoot(nested), root);
  assert.equal(findProjectRoot(path.join(nested, 'file.ts')), root);
});
