import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { prepareReviewRequest } from '../../lib/shared/review-request.js';
import { pendingReviews } from '../../lib/shared/pending-review.js';

async function fixture(context: TestContext) {
  const base = process.platform === 'win32' ? path.join(os.tmpdir(), 'AI-Work') : os.tmpdir();
  await fs.mkdir(base, { recursive: true });
  const root = await fs.mkdtemp(path.join(base, 'loadwise-inbox-'));
  const state = path.join(root, 'state');
  const project = path.join(root, 'project');
  const child = path.join(project, 'nested-package');
  await fs.mkdir(state, { mode: 0o700 });
  await fs.mkdir(child, { recursive: true });
  for (const directory of [project, child]) await fs.writeFile(path.join(directory, 'package.json'), '{}');
  const variable = process.platform === 'win32' ? 'LOCALAPPDATA' : 'XDG_STATE_HOME';
  const previous = process.env[variable];
  process.env[variable] = state;
  context.after(async () => {
    if (previous === undefined) delete process.env[variable];
    else process.env[variable] = previous;
    await fs.rm(root, { recursive: true, force: true });
  });
  const save = (directory: string) =>
    prepareReviewRequest({ version: 1, command: 'fix', directory, report: { applied: [] } }, { pending: true });
  return { project, child, state, save };
}

test('project inbox supports concurrent receipts, exact package scope and cleanup by the reviewer', async (context) => {
  const { project, child, state, save } = await fixture(context);
  assert.deepEqual(await pendingReviews(project), []);
  assert.deepEqual(await fs.readdir(state), []);
  const [first, second, nested] = await Promise.all([save(project), save(project), save(child)]);
  assert.deepEqual(new Set(await pendingReviews(project)), new Set([first.file, second.file]));
  assert.deepEqual(await pendingReviews(child), [nested.file]);
  await fs.unlink(first.file);
  assert.deepEqual(await pendingReviews(project), [second.file]);
});

test('malformed, hard-linked, and cross-project receipts cannot appear in a prompt', async (context) => {
  const { project, child, save } = await fixture(context);
  const [receipt, foreign] = await Promise.all([save(project), save(child)]);
  await fs.copyFile(foreign.file, receipt.file);
  assert.deepEqual(await pendingReviews(project), []);
  await fs.writeFile(receipt.file, '{');
  assert.deepEqual(await pendingReviews(project), []);
  await fs.unlink(receipt.file);
  await fs.link(foreign.file, receipt.file);
  assert.deepEqual(await pendingReviews(project), []);
  await fs.unlink(receipt.file);
  const inbox = path.dirname(path.dirname(receipt.file));
  await fs.symlink(
    path.dirname(foreign.file),
    path.join(inbox, 'run-1111111111111-abcdef'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  assert.deepEqual(await pendingReviews(project), []);
});
