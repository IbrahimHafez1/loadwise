import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { findProjectRoot, useSnapshot } from '../../lib/performance/schema/context.js';

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
