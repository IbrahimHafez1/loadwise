import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Readable, Writable } from 'node:stream';
import { createInterface } from 'node:readline';
import test from 'node:test';

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number | undefined;
  method: string;
  params: object | undefined;
}

interface McpText {
  text: string;
}

/**
 * The members of an MCP result that these tests read; which ones exist depends on the method
 * called.
 */
interface McpResult {
  isError?: boolean;
  content?: McpText[];
  tools?: { name: string; annotations: { readOnlyHint: boolean } }[];
  supportedVersions?: string[];
  protocolVersion?: string;
  resultType?: string;
  _meta?: Record<string, { name: string } | undefined>;
}

interface McpReply {
  result?: McpResult;
  error?: { code: number };
}

interface ReportPage {
  id: string;
  text: string;
  nextOffset: number | null;
  totalLength: number;
}

interface ReceiptEvent {
  version: number;
  command: string;
  directory: string;
  report: unknown;
}

interface Receipt {
  id: string;
  file: string;
  event: ReceiptEvent;
}

interface ReportEvent {
  exitCode: number;
  notes: string;
  report: Record<string, { findings: unknown[] } | undefined>;
}

interface ReportListing {
  reports: { id: string }[];
}

function replyAt(replies: readonly McpReply[], index: number): McpReply {
  const reply = replies[index];
  assert.ok(reply);
  return reply;
}

function resultOf(reply: McpReply): McpResult {
  assert.ok(reply.result);
  return reply.result;
}

function errorCodeOf(reply: McpReply): number {
  assert.ok(reply.error);
  return reply.error.code;
}

function textOf(result: McpResult, index: number): string {
  const item = result.content?.[index];
  assert.ok(item);
  return item.text;
}
import { runReviewMcp } from '../../lib/shared/review-mcp.cjs';
import { savePendingReview, pendingReviews } from '../../lib/shared/pending-review.cjs';

async function exchange(directory: string, lines: readonly (string | JsonRpcRequest)[]): Promise<McpReply[]> {
  let transcript = '';
  const output = new Writable({
    write(chunk, _encoding, done) {
      transcript += chunk;
      done();
    },
  });
  const input = Readable.from(lines.map((line) => (typeof line === 'string' ? line : JSON.stringify(line)) + '\n'));
  assert.equal(await runReviewMcp(directory, input, output), 0);
  return transcript
    .trimEnd()
    .split('\n')
    .map((line): McpReply => JSON.parse(line));
}

const request = (id: number | undefined, method: string, params?: object): JsonRpcRequest => ({
  jsonrpc: '2.0',
  id,
  method,
  params,
});
const call = (id: number, name: string, args: object): JsonRpcRequest =>
  request(id, 'tools/call', { name, arguments: args });

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
  async function send(message: JsonRpcRequest): Promise<McpResult> {
    input.write(JSON.stringify(message) + '\n');
    const { value } = await replies.next();
    assert.ok(value);
    return JSON.parse(value).result;
  }
  await send(request(1, 'initialize', { protocolVersion: '2025-11-25' }));
  for (const invalid of [{ directory: '..' }, { online: true }, { checkers: [] }, { checkers: ['--fix'] }]) {
    assert.equal((await send(call(2, 'loadwise_check', invalid))).isError, true);
  }
  const first = await send(call(3, 'loadwise_check', { checkers: ['performance'] }));
  assert.equal(first.isError, false);
  assert.match(textOf(first, 1), /false positives, skipped coverage/);
  assert.match(textOf(first, 1), /let the user decide before editing/);
  let page: ReportPage = JSON.parse(textOf(first, 0));
  assert.ok(page.nextOffset !== null && page.nextOffset > 0);
  let document = page.text;
  const { id } = page;
  while (page.nextOffset !== null) {
    const reply = await send(call(4, 'loadwise_read_report', { id, offset: page.nextOffset }));
    page = JSON.parse(textOf(reply, 0));
    document += page.text;
  }
  const event: ReportEvent = JSON.parse(document);
  assert.equal(event.exitCode, 1);
  assert.doesNotMatch(event.notes, /Loadwise agent review:/);
  assert.deepEqual(Object.keys(event.report), ['performance']);
  assert.equal(event.report['performance']?.findings.length, files.length * 3);
  const [firstFile] = files;
  assert.ok(firstFile);
  assert.equal(await fs.readFile(firstFile, 'utf8'), source);
  assert.deepEqual(await pendingReviews(project), []);
  const [, foreign] = await exchange(project, [
    request(1, 'initialize', { protocolVersion: '2025-11-25' }),
    call(2, 'loadwise_read_report', { id }),
  ]);
  assert.ok(foreign);
  assert.equal(resultOf(foreign).isError, true);
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
  assert.equal(errorCodeOf(replyAt(replies, 0)), -32700);
  assert.equal(errorCodeOf(replyAt(replies, 1)), -32002);
  assert.equal(resultOf(replyAt(replies, 2)).protocolVersion, '2025-06-18');
  assert.deepEqual(
    resultOf(replyAt(replies, 3)).tools?.map((tool) => tool.name),
    ['loadwise_check', 'loadwise_list_reports', 'loadwise_read_report'],
  );
  assert.deepEqual(resultOf(replyAt(replies, 4)), {});
  assert.equal(errorCodeOf(replyAt(replies, 5)), -32601);
  assert.equal(errorCodeOf(replyAt(replies, 6)), -32602);
  assert.equal(resultOf(replyAt(replies, 7)).protocolVersion, '2025-11-25');
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
  assert.ok(discover && tools && callResult && unsupported);
  assert.ok(resultOf(discover).supportedVersions?.includes('2026-07-28'));
  assert.equal(resultOf(discover)._meta?.['io.modelcontextprotocol/serverInfo']?.name, 'loadwise');
  assert.equal(resultOf(tools).resultType, 'complete');
  assert.ok(resultOf(tools).tools?.every((tool) => tool.annotations.readOnlyHint));
  assert.equal(resultOf(callResult).isError, true);
  assert.equal(errorCodeOf(unsupported), -32022);
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
  const selectedProject = path.join(scratch, 'selected');
  const otherProject = path.join(scratch, 'other');
  const projects = [selectedProject, otherProject];
  const receipts: Receipt[] = [];
  for (const directory of projects) {
    await fs.mkdir(directory);
    await fs.writeFile(path.join(directory, 'package.json'), '{}');
    const event: ReceiptEvent = {
      version: 1,
      command: 'fix',
      directory,
      report: { applied: [{ text: 'line one\nline two' }] },
    };
    const receipt = await savePendingReview(directory, JSON.stringify(event));
    receipts.push({ id: path.basename(path.dirname(receipt)), file: receipt, event });
  }
  const [local, foreign] = receipts;
  assert.ok(local && foreign);
  const [, list, read, outside, traversal, extra] = await exchange(selectedProject, [
    request(1, 'initialize', { protocolVersion: '2025-11-25' }),
    call(2, 'loadwise_list_reports', {}),
    call(3, 'loadwise_read_report', { id: local.id }),
    call(4, 'loadwise_read_report', { id: foreign.id }),
    call(5, 'loadwise_read_report', { id: foreign.file }),
    call(6, 'loadwise_list_reports', { directory: otherProject }),
  ]);
  assert.ok(list && read && outside && traversal && extra);
  assert.deepEqual(JSON.parse(textOf(resultOf(list), 0)), { reports: [{ id: local.id }] });
  assert.deepEqual(JSON.parse(textOf(resultOf(read), 0)), local.event);
  assert.ok([outside, traversal, extra].every((reply) => resultOf(reply).isError));
  assert.deepEqual(await pendingReviews(selectedProject), [local.file]);
  const large = { ...local.event, report: { note: '🥘'.repeat(9000) } };
  const largeFile = await savePendingReview(selectedProject, JSON.stringify(large));
  const id = path.basename(path.dirname(largeFile));
  const initialize = request(1, 'initialize', { protocolVersion: '2025-11-25' });
  const [, ordered, first] = await exchange(selectedProject, [
    initialize,
    call(2, 'loadwise_list_reports', {}),
    call(3, 'loadwise_read_report', { id }),
  ]);
  assert.ok(ordered && first);
  const listing: ReportListing = JSON.parse(textOf(resultOf(ordered), 0));
  assert.deepEqual(
    listing.reports.map((report) => report.id),
    [id, local.id],
  );
  const firstPage: ReportPage = JSON.parse(textOf(resultOf(first), 0));
  const openFile = fs.open;
  const openSpy = context.mock.method(fs, 'open', openFile);
  const [, cachedFirst, cachedLast] = await exchange(selectedProject, [
    initialize,
    call(2, 'loadwise_read_report', { id }),
    call(3, 'loadwise_read_report', { id, offset: firstPage.nextOffset }),
  ]);
  assert.ok(cachedFirst && cachedLast);
  assert.equal(openSpy.mock.calls.filter(({ arguments: [file] }) => file === largeFile).length, 1);
  openSpy.mock.restore();
  assert.deepEqual(
    JSON.parse(JSON.parse(textOf(resultOf(cachedFirst), 0)).text + JSON.parse(textOf(resultOf(cachedLast), 0)).text),
    large,
  );
  const [, second, negative, beyond] = await exchange(selectedProject, [
    initialize,
    call(2, 'loadwise_read_report', { id, offset: firstPage.nextOffset }),
    call(3, 'loadwise_read_report', { id, offset: -1 }),
    call(4, 'loadwise_read_report', { id, offset: firstPage.totalLength }),
  ]);
  assert.ok(second && negative && beyond);
  const secondPage: ReportPage = JSON.parse(textOf(resultOf(second), 0));
  assert.equal(secondPage.nextOffset, null);
  assert.deepEqual(JSON.parse(firstPage.text + secondPage.text), large);
  assert.ok(resultOf(negative).isError && resultOf(beyond).isError);
  await fs.copyFile(foreign.file, local.file);
  const [, replaced] = await exchange(selectedProject, [
    request(1, 'initialize', { protocolVersion: '2025-11-25' }),
    call(2, 'loadwise_read_report', { id: local.id }),
  ]);
  assert.ok(replaced);
  assert.equal(resultOf(replaced).isError, true);
});
