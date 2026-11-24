import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { initAgent } from '../../lib/shared/agent-init.cjs';

function tempRoot(context: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loadwise-review-shared-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'package.json'), '{}');
  return root;
}

test('agent init leaves a CLAUDE.md linked to AGENTS.md without a self-import', (context) => {
  const root = tempRoot(context);
  const agents = path.join(root, 'AGENTS.md');
  fs.writeFileSync(agents, '# Team notes\n');
  fs.linkSync(agents, path.join(root, 'CLAUDE.md'));
  initAgent(root);
  const text = fs.readFileSync(agents, 'utf8');
  assert.ok(text.startsWith('# Team notes\n'));
  assert.ok(text.includes('<!-- loadwise:agent:start -->'));
  assert.ok(!text.split('\n').includes('@AGENTS.md'), 'AGENTS.md must not import itself');
});
