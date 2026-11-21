'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { prepareReviewRequest } = require('../../lib/shared/review-request.cjs');

async function fixture(context) {
  const base = process.platform === 'win32' ? path.join(os.tmpdir(), 'AI-Work') : os.tmpdir();
  await fs.mkdir(base, { recursive: true });
  const root = await fs.mkdtemp(path.join(base, 'loadwise-request-test-'));
  const project = path.join(root, 'project');
  const state = path.join(root, 'state');
  await Promise.all([fs.mkdir(project), fs.mkdir(state, { mode: 0o700 })]);
  const variable = process.platform === 'win32' ? 'LOCALAPPDATA' : 'TMPDIR';
  const previous = process.env[variable];
  process.env[variable] = state;
  context.after(async () => {
    if (previous === undefined) delete process.env[variable];
    else process.env[variable] = previous;
    await fs.rm(root, { recursive: true, force: true });
  });
  return {
    root,
    state,
    variable,
    event: { version: 1, command: 'check', directory: project, report: { findings: [] } },
  };
}

test('a saved handoff keeps its exact data in a unique private report', async (context) => {
  const { state, event } = await fixture(context);
  event.report.findings.push({ message: 'Finding with original source text' });
  const [first, second] = await Promise.all([prepareReviewRequest(event), prepareReviewRequest(event)]);
  assert.notEqual(first.file, second.file);
  assert.equal(path.dirname(path.dirname(first.file)), await fs.realpath(state));
  assert.deepEqual(JSON.parse(await fs.readFile(first.file)), event);
  assert.deepEqual(await fs.readdir(event.directory), []);
  if (process.getuid) {
    assert.equal((await fs.stat(first.file)).mode & 0o077, 0);
    assert.equal((await fs.stat(path.dirname(first.file))).mode & 0o077, 0);
  }
});

test('invalid and oversized reports create no private files', async (context) => {
  const { state, event } = await fixture(context);
  await assert.rejects(prepareReviewRequest({ ...event, command: 'other' }), /Invalid/);
  const { maxReportBytes } = require('../../lib/shared/pending-review.cjs');
  event.report.findings.push('x'.repeat(maxReportBytes));
  await assert.rejects(prepareReviewRequest(event), /size limit/);
  assert.deepEqual(await fs.readdir(state), []);
});

test('a project-relative storage location or a redirected storage directory cannot receive a report', async (context) => {
  const { root, state, variable, event } = await fixture(context);
  process.env[variable] = event.directory;
  await assert.rejects(prepareReviewRequest(event), /outside the project/);
  const nested = path.join(event.directory, 'src');
  await fs.mkdir(nested);
  await fs.writeFile(path.join(event.directory, 'package.json'), '{}');
  await assert.rejects(prepareReviewRequest({ ...event, directory: nested }), /outside the project/);
  const link = path.join(root, 'link');
  await fs.symlink(state, link, process.platform === 'win32' ? 'junction' : 'dir');
  process.env[variable] = link;
  await assert.rejects(prepareReviewRequest(event), /Expected a directory/);
  assert.deepEqual(await fs.readdir(state), []);
});
