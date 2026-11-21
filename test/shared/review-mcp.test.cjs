'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { PassThrough, Readable, Writable } = require('node:stream');
const { createInterface } = require('node:readline');
const test = require('node:test');
const { runReviewMcp } = require('../../lib/shared/review-mcp.cjs');
const { savePendingReview, pendingReviews } = require('../../lib/shared/pending-review.cjs');

async function exchange(directory, lines) {
  let transcript = '';
  const output = new Writable({
    write(chunk, _encoding, done) {
      transcript += chunk;
      done();
    },
  });
  const input = Readable.from(lines.map((line) => (typeof line === 'string' ? line : JSON.stringify(line)) + '\n'));
  assert.equal(await runReviewMcp(directory, input, output), 0);
  return transcript.trimEnd().split('\n').map(JSON.parse);
}

const request = (id, method, params) => ({ jsonrpc: '2.0', id, method, params });
const call = (id, name, args) => request(id, 'tools/call', { name, arguments: args });

test('an active session can scan its project, read all pages and keep project files intact', async (context) => {
  const base = process.platform === 'win32' ? path.join(os.tmpdir(), 'AI-Work') : os.tmpdir();
  await fs.mkdir(base, { recursive: true });
  const project = await fs.mkdtemp(path.join(base, 'loadwise-mcp-scan-'));
  context.after(() => fs.rm(project, { recursive: true, force: true }));
  await fs.writeFile(path.join(project, 'tsconfig.json'), '{}');
  const source = await fs.readFile(path.join(__dirname, '../../examples/slow.ts'), 'utf8');
  const files = Array.from({ length: 10 }, (_, index) => path.join(project, `example-${index}.ts`));
  await Promise.all(files.map((file) => fs.writeFile(file, source)));
  const input = new PassThrough();
  const output = new PassThrough();
  const replies = createInterface({ input: output })[Symbol.asyncIterator]();
  const server = runReviewMcp(project, input, output);
  context.after(async () => {
    input.end();
    await server;
    output.end();
  });
  async function send(message) {
    input.write(JSON.stringify(message) + '\n');
    return JSON.parse((await replies.next()).value).result;
  }
  await send(request(1, 'initialize', { protocolVersion: '2025-11-25' }));
  for (const invalid of [{ directory: '..' }, { online: true }, { checkers: [] }, { checkers: ['--fix'] }]) {
    assert.equal((await send(call(2, 'loadwise_check', invalid))).isError, true);
  }
  const first = await send(call(3, 'loadwise_check', { checkers: ['performance'] }));
  assert.equal(first.isError, false);
  assert.match(first.content[1].text, /false positives, skipped coverage/);
  assert.match(first.content[1].text, /let the user decide before editing/);
  let page = JSON.parse(first.content[0].text);
  assert.ok(page.nextOffset > 0);
  let document = page.text;
  const { id } = page;
  while (page.nextOffset !== null) {
    const reply = await send(call(4, 'loadwise_read_report', { id, offset: page.nextOffset }));
    page = JSON.parse(reply.content[0].text);
    document += page.text;
  }
  const event = JSON.parse(document);
  assert.equal(event.exitCode, 1);
  assert.doesNotMatch(event.notes, /Loadwise agent review:/);
  assert.deepEqual(Object.keys(event.report), ['performance']);
  assert.equal(event.report.performance.findings.length, files.length * 3);
  assert.equal(await fs.readFile(files[0], 'utf8'), source);
  assert.deepEqual(await pendingReviews(project), []);
  const [, foreign] = await exchange(project, [
    request(1, 'initialize', { protocolVersion: '2025-11-25' }),
    call(2, 'loadwise_read_report', { id }),
  ]);
  assert.equal(foreign.result.isError, true);
});

test('MCP negotiates the client protocol and keeps notifications and diagnostics out of stdout', async () => {
  const replies = await exchange(process.cwd(), [
    '{',
    request(1, 'tools/list'),
    request(2, 'initialize', { protocolVersion: '2025-06-18' }),
    request(undefined, 'notifications/initialized'),
    request(3, 'tools/list'),
    request(4, 'ping'),
    request(5, 'unrecognized'),
    call(6, 'run_fix', {}),
    request(7, 'initialize', { protocolVersion: 'unknown' }),
  ]);
  assert.equal(replies.length, 8);
  assert.equal(replies[0].error.code, -32700);
  assert.equal(replies[1].error.code, -32002);
  assert.equal(replies[2].result.protocolVersion, '2025-06-18');
  assert.deepEqual(
    replies[3].result.tools.map((tool) => tool.name),
    ['loadwise_check', 'loadwise_list_reports', 'loadwise_read_report'],
  );
  assert.deepEqual(replies[4].result, {});
  assert.equal(replies[5].error.code, -32601);
  assert.equal(replies[6].error.code, -32602);
  assert.equal(replies[7].result.protocolVersion, '2025-11-25');
});

test('modern MCP clients discover read-only tools and call them without an initialize handshake', async () => {
  const key = 'io.modelcontextprotocol/protocolVersion';
  const meta = { _meta: { [key]: '2026-07-28' } };
  const [discover, tools, callResult, unsupported] = await exchange(process.cwd(), [
    request(1, 'server/discover', meta),
    request(2, 'tools/list', meta),
    request(3, 'tools/call', { ...meta, name: 'loadwise_read_report', arguments: { id: '../another' } }),
    request(4, 'server/discover', { _meta: { [key]: 'unknown' } }),
  ]);
  assert.ok(discover.result.supportedVersions.includes('2026-07-28'));
  assert.equal(discover.result._meta['io.modelcontextprotocol/serverInfo'].name, 'loadwise');
  assert.equal(tools.result.resultType, 'complete');
  assert.ok(tools.result.tools.every((tool) => tool.annotations.readOnlyHint));
  assert.equal(callResult.result.isError, true);
  assert.equal(unsupported.error.code, -32022);
});

test('tools read only original validated receipts from the configured package without consuming them', async (context) => {
  const base = process.platform === 'win32' ? path.join(os.tmpdir(), 'AI-Work') : os.tmpdir();
  await fs.mkdir(base, { recursive: true });
  const scratch = await fs.mkdtemp(path.join(base, 'loadwise-mcp-'));
  const variable = process.platform === 'win32' ? 'LOCALAPPDATA' : 'XDG_STATE_HOME';
  const previous = process.env[variable];
  process.env[variable] = scratch;
  context.after(async () => {
    if (previous === undefined) delete process.env[variable];
    else process.env[variable] = previous;
    await fs.rm(scratch, { recursive: true, force: true });
  });
  const projects = ['selected', 'other'].map((name) => path.join(scratch, name));
  const receipts = [];
  for (const directory of projects) {
    await fs.mkdir(directory);
    await fs.writeFile(path.join(directory, 'package.json'), '{}');
    const event = { version: 1, command: 'fix', directory, report: { applied: [{ text: 'line one\nline two' }] } };
    const receipt = await savePendingReview(directory, JSON.stringify(event));
    receipts.push({ id: path.basename(path.dirname(receipt)), file: receipt, event });
  }
  const [local, foreign] = receipts;
  const [, list, read, outside, traversal, extra] = await exchange(projects[0], [
    request(1, 'initialize', { protocolVersion: '2025-11-25' }),
    call(2, 'loadwise_list_reports', {}),
    call(3, 'loadwise_read_report', { id: local.id }),
    call(4, 'loadwise_read_report', { id: foreign.id }),
    call(5, 'loadwise_read_report', { id: foreign.file }),
    call(6, 'loadwise_list_reports', { directory: projects[1] }),
  ]);
  assert.deepEqual(JSON.parse(list.result.content[0].text), { reports: [{ id: local.id }] });
  assert.deepEqual(JSON.parse(read.result.content[0].text), local.event);
  assert.ok([outside, traversal, extra].every((reply) => reply.result.isError));
  assert.deepEqual(await pendingReviews(projects[0]), [local.file]);
  const large = { ...local.event, report: { note: '🥘'.repeat(9000) } };
  const largeFile = await savePendingReview(projects[0], JSON.stringify(large));
  const id = path.basename(path.dirname(largeFile));
  const initialize = request(1, 'initialize', { protocolVersion: '2025-11-25' });
  const [, ordered, first] = await exchange(projects[0], [
    initialize,
    call(2, 'loadwise_list_reports', {}),
    call(3, 'loadwise_read_report', { id }),
  ]);
  assert.deepEqual(
    JSON.parse(ordered.result.content[0].text).reports.map((report) => report.id),
    [id, local.id],
  );
  const firstPage = JSON.parse(first.result.content[0].text);
  const openFile = fs.open;
  const openSpy = context.mock.method(fs, 'open', openFile);
  const [, cachedFirst, cachedLast] = await exchange(projects[0], [
    initialize,
    call(2, 'loadwise_read_report', { id }),
    call(3, 'loadwise_read_report', { id, offset: firstPage.nextOffset }),
  ]);
  assert.equal(openSpy.mock.calls.filter(({ arguments: [file] }) => file === largeFile).length, 1);
  openSpy.mock.restore();
  assert.deepEqual(
    JSON.parse(
      JSON.parse(cachedFirst.result.content[0].text).text + JSON.parse(cachedLast.result.content[0].text).text,
    ),
    large,
  );
  const [, second, negative, beyond] = await exchange(projects[0], [
    initialize,
    call(2, 'loadwise_read_report', { id, offset: firstPage.nextOffset }),
    call(3, 'loadwise_read_report', { id, offset: -1 }),
    call(4, 'loadwise_read_report', { id, offset: firstPage.totalLength }),
  ]);
  const secondPage = JSON.parse(second.result.content[0].text);
  assert.equal(secondPage.nextOffset, null);
  assert.deepEqual(JSON.parse(firstPage.text + secondPage.text), large);
  assert.ok(negative.result.isError && beyond.result.isError);
  await fs.copyFile(foreign.file, local.file);
  const [, replaced] = await exchange(projects[0], [
    request(1, 'initialize', { protocolVersion: '2025-11-25' }),
    call(2, 'loadwise_read_report', { id: local.id }),
  ]);
  assert.equal(replaced.result.isError, true);
});
