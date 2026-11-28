import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import type { TestContext } from 'node:test';
import { isRecord } from '../../lib/shared/is-record.js';
import { notifyEditor } from '../../lib/shared/notify-editor.js';
import { startLspClient, until } from './lsp-client.js';
import type { LspClient } from './lsp-client.js';

interface Workspace {
  /** The temporary folder holding the workspace and the fake checker. */
  base: string;
  root: string;
  uri: string;
  /** The folder the fake checker reads its reports from. */
  reports: string;
  cli: string;
}

const ordersText = 'one();\ntwo();\nthree();\n';

// Stands in for bin/loadwise.js: it prints the report saved for the checker, and in watch mode
// stays running and prints the watch report again whenever it changes.
const fakeCli = `const fs = require('node:fs');
const path = require('node:path');
const [checker, ...rest] = process.argv.slice(2);
const reports = path.join(__dirname, path.basename(process.cwd()));
const read = (name) => { try { return JSON.parse(fs.readFileSync(path.join(reports, name), 'utf8')); } catch { return []; } };
fs.appendFileSync(path.join(reports, 'runs.log'), [checker, ...rest].join(' ') + '\\n');
if (rest.includes('--watch')) {
  fs.writeFileSync(path.join(reports, 'watch.pid'), String(process.pid));
  const report = () => process.stdout.write(JSON.stringify({ findings: read('watch.json') }) + '\\n');
  report();
  fs.watchFile(path.join(reports, 'watch.json'), { interval: 50 }, report);
} else {
  process.stdout.write(JSON.stringify({ findings: read((rest[0] === 'polyglot' ? checker + '-polyglot' : checker) + '.json') }));
}
`;

const capabilities = {
  workspace: {
    workspaceFolders: true,
    configuration: true,
    didChangeConfiguration: { dynamicRegistration: true },
    didChangeWatchedFiles: { dynamicRegistration: true },
    workspaceEdit: { documentChanges: true, resourceOperations: ['create'] },
    codeLens: { refreshSupport: true },
  },
  window: { workDoneProgress: true },
};

function removeDirectory(directory: string): void {
  // Windows keeps a folder locked until a killed child exits; a leftover temporary folder is harmless.
  try {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && (error.code === 'EBUSY' || error.code === 'EPERM'))) throw error;
  }
}

function createWorkspace(base: string, name: string, files: Record<string, string>): Workspace {
  const root = path.join(base, name);
  const reports = path.join(base, 'cli', name);
  fs.mkdirSync(reports, { recursive: true });
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  }
  const cli = path.join(base, 'cli', 'loadwise.cjs');
  fs.writeFileSync(cli, fakeCli);
  return { base, root, uri: pathToFileURL(root).href, reports, cli };
}

// Bounds a wait in the cleanup, so a stuck server cannot hold the test run.
function within<Value>(promise: Promise<Value>, timeoutMs: number): Promise<Value | undefined> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), timeoutMs);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

const shutdownTimeoutMs = 5_000;

function temporaryBase(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'loadwise-lsp-'));
}

function writeReport(workspace: Workspace, name: string, findings: unknown[]): void {
  fs.writeFileSync(path.join(workspace.reports, name), JSON.stringify(findings));
}

function fileUri(workspace: Workspace, file: string): string {
  return pathToFileURL(path.join(workspace.root, file)).href;
}

async function startServer(
  context: TestContext,
  workspace: Workspace,
  {
    initializationOptions,
    clientCapabilities = capabilities,
  }: { initializationOptions?: unknown; clientCapabilities?: object } = {},
): Promise<LspClient> {
  const client = startLspClient(workspace.root);
  client.onRequest('workspace/configuration', () => [null]);
  client.onRequest('workspace/applyEdit', () => ({ applied: true }));
  context.after(async () => {
    // The server must exit before its folder is removed, because Windows refuses to delete a folder in use.
    if (client.child.exitCode === null) {
      await within(
        client.request('shutdown').catch(() => {}),
        shutdownTimeoutMs,
      );
      client.notify('exit');
      if ((await within(client.exited, shutdownTimeoutMs)) === undefined && client.child.exitCode === null) {
        client.child.kill();
        await client.exited;
      }
    }
    removeDirectory(workspace.base);
  });
  await client.request('initialize', {
    processId: process.pid,
    rootUri: workspace.uri,
    capabilities: clientCapabilities,
    initializationOptions: initializationOptions ?? { loadwise: { cli: workspace.cli } },
    workspaceFolders: [{ uri: workspace.uri, name: path.basename(workspace.root) }],
  });
  client.notify('initialized', {});
  return client;
}

function record(value: unknown): Record<string, unknown> {
  assert.ok(isRecord(value), 'expected an object, got ' + JSON.stringify(value));
  return value;
}

function list(value: unknown): unknown[] {
  assert.ok(Array.isArray(value), 'expected an array, got ' + JSON.stringify(value));
  return value;
}

function codes(diagnostics: readonly unknown[] | undefined): unknown[] {
  return (diagnostics ?? []).map((diagnostic) => record(diagnostic).code);
}

function startLine(value: unknown): unknown {
  return record(record(record(value).range).start).line;
}

function titles(actions: unknown): unknown[] {
  return list(actions).map((action) => record(action).title);
}

function commandArgument(action: unknown): unknown {
  return list(record(record(action).command).arguments)[0];
}

async function codeActions(client: LspClient, uri: string, line: number, only?: string[]): Promise<unknown[]> {
  const position = { line, character: 0 };
  const actions = await client.request('textDocument/codeAction', {
    textDocument: { uri },
    range: { start: position, end: position },
    context: { diagnostics: [], ...(only ? { only } : {}) },
  });
  return list(actions);
}

const fixed = (line: number, before: string, after: string) => ({
  file: 'orders.ts',
  line,
  column: 1,
  ruleId: 'array-repeated-membership',
  message: 'Each call is slow. Use `a.b(). Then` instead, e.g. a batch.',
  fix: { changes: [{ file: 'orders.ts', line, before, after }] },
});

const migration = {
  file: 'migrations/001_orders.sql',
  line: 1,
  before: '',
  after: 'CREATE INDEX orders_id;\n',
  create: true,
};

function seedOrders(workspace: Workspace): void {
  writeReport(workspace, 'watch.json', [
    { ...fixed(1, 'one();', 'ONE();'), related: [{ file: 'orders.ts', line: 3, column: 1 }] },
    {
      file: 'orders.ts',
      line: 2,
      column: 1,
      ruleId: 'pg-transaction-on-pool',
      message: 'Declared contract.',
      fix: { changes: [migration] },
    },
    fixed(3, 'three();', 'THREE();'),
  ]);
  writeReport(workspace, 'sec.json', [
    { file: 'orders.ts', line: 2, column: 1, ruleId: 'pg-dynamic-query-text', message: 'Dynamic SQL text.' },
  ]);
}

test('diagnostics carry the checker, rule link, severity and related locations, with progress and logs', async (context) => {
  const workspace = createWorkspace(temporaryBase(), 'shop', {
    'tsconfig.json': '{}',
    'orders.ts': ordersText,
  });
  seedOrders(workspace);
  const client = await startServer(context, workspace);
  const uri = fileUri(workspace, 'orders.ts');
  const diagnostics = await until(
    () => client.diagnostics.get(uri)?.length === 4 && client.diagnostics.get(uri),
    'diagnostics',
  );
  // The checkers finish in any order, so each diagnostic is picked by its rule and line.
  const pick = (code: string, line: number) => {
    const found = diagnostics
      .map(record)
      .find((diagnostic) => diagnostic.code === code && startLine(diagnostic) === line);
    assert.ok(found, 'expected ' + code + ' on line ' + line);
    return found;
  };
  const [first, contract, third, security] = [
    pick('array-repeated-membership', 0),
    pick('pg-transaction-on-pool', 1),
    pick('array-repeated-membership', 2),
    pick('pg-dynamic-query-text', 1),
  ];
  assert.equal(first.source, 'loadwise perf');
  assert.equal(first.code, 'array-repeated-membership');
  assert.equal(first.severity, 2);
  assert.match(String(record(first.codeDescription).href), /\/docs\/rules\/array-repeated-membership\.md$/);
  assert.deepEqual(record(first.range).start, { line: 0, character: 0 });
  assert.deepEqual(
    String(first.message).split('\n').slice(1),
    ['Each call is slow.', 'Use `a.b(). Then` instead, e.g. a batch.'],
    'the first line previews the rewrite and the finding keeps one sentence per line',
  );
  assert.equal(String(first.message).split('\n')[0], 'Code: one(); → ONE();');
  const [related] = list(first.relatedInformation).map(record);
  assert.equal(related.message, 'Matching implementation');
  assert.equal(startLine(related.location), 2);
  assert.equal(contract.severity, 1, 'a declared contract is an error by default');
  assert.equal(third.code, 'array-repeated-membership');
  assert.equal(security.source, 'loadwise sec');
  assert.equal(security.code, 'pg-dynamic-query-text');

  const registration = client.serverRequests.find(({ method }) => method === 'client/registerCapability');
  assert.match(JSON.stringify(registration?.params), /dismissed\.json/);
  assert.match(JSON.stringify(registration?.params), /tsconfig\*\.json/);
  await until(
    () =>
      client.notifications.some(
        ({ method, params }) => method === '$/progress' && /"end"/.test(JSON.stringify(params)),
      ),
    'the end of the scan progress',
  );
  assert.ok(client.notifications.some(({ params }) => /"begin"/.test(JSON.stringify(params))));
  assert.ok(client.logs().some((line) => /loadwise perf — watching tsconfig\.json incrementally/.test(line)));
  assert.ok(client.logs().some((line) => /loadwise sec — 1 finding\(s\)/.test(line)));
});

test('hover, code actions, fix-all, code lenses and the apply command edit only the original lines', async (context) => {
  const workspace = createWorkspace(temporaryBase(), 'shop', {
    'tsconfig.json': '{}',
    'orders.ts': ordersText,
    // The migration folder exists, so the editor can create the new file in it directly.
    'migrations/000_init.sql': '',
  });
  seedOrders(workspace);
  const client = await startServer(context, workspace);
  const uri = fileUri(workspace, 'orders.ts');
  await until(() => client.diagnostics.get(uri)?.length === 4, 'diagnostics');
  client.notify('textDocument/didOpen', {
    textDocument: { uri, languageId: 'typescript', version: 1, text: ordersText },
  });

  const hover = record(
    await client.request('textDocument/hover', { textDocument: { uri }, position: { line: 0, character: 1 } }),
  );
  const markdown = String(record(hover.contents).value);
  const order = [
    '**Code: one\\(\\); → ONE\\(\\);**',
    'Each call is slow\\.',
    '```typescript\none();\n```',
    'Suggested rewrite',
    '```typescript\nONE();\n```',
  ];
  const positions = order.map((part) => markdown.indexOf(part));
  assert.ok(
    positions.every((position) => position !== -1),
    markdown,
  );
  assert.deepEqual(
    [...positions].sort((left, right) => left - right),
    positions,
    'recommendation, finding, then comparison',
  );

  const lineActions = await codeActions(client, uri, 0);
  assert.deepEqual(titles(lineActions), [
    'Apply fix: array-repeated-membership',
    'Dismiss this finding (array-repeated-membership)',
    'Dismiss array-repeated-membership in this file',
    'Apply all Loadwise fixes in this file',
  ]);
  const apply = record(lineActions[0]);
  assert.equal(apply.isPreferred, true);
  assert.deepEqual(record(apply.edit).documentChanges, [
    {
      textDocument: { uri, version: 1 },
      edits: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 6 } }, newText: 'ONE();' }],
    },
  ]);

  const createAction = (await codeActions(client, uri, 1)).find(
    (action) => record(action).title === 'Apply fix: pg-transaction-on-pool',
  );
  const [create, insert] = list(record(record(createAction).edit).documentChanges).map(record);
  const migrationUri = fileUri(workspace, 'migrations/001_orders.sql');
  assert.deepEqual(create, { kind: 'create', uri: migrationUri, options: { overwrite: false, ignoreIfExists: false } });
  assert.equal(record(insert.textDocument).uri, migrationUri);

  const [fixAll] = await codeActions(client, uri, 0, ['source.fixAll']);
  const fixAllChanges = list(record(record(fixAll).edit).documentChanges).map(record);
  assert.equal(record(fixAll).kind, 'source.fixAll.loadwise');
  assert.equal(fixAllChanges[0].kind, 'create', 'new files first, so a failed create leaves existing files alone');
  assert.deepEqual(
    list(fixAllChanges[2].edits).map((edit) => record(edit).newText),
    ['ONE();', 'THREE();'],
    'one edit for the whole file, so one undo reverts it',
  );

  const lenses = list(await client.request('textDocument/codeLens', { textDocument: { uri } }));
  assert.deepEqual(
    lenses.map((lens) => [startLine(lens), record(record(lens).command).title]),
    [
      [0, 'Apply all 3 Loadwise fixes in this file'],
      [0, 'Apply fix: array-repeated-membership'],
      [0, 'Dismiss'],
      [1, 'Apply fix: pg-transaction-on-pool'],
      [1, 'Dismiss'],
      [2, 'Apply fix: array-repeated-membership'],
      [2, 'Dismiss'],
    ],
  );
  await client.request('workspace/executeCommand', {
    command: 'loadwise.applyFix',
    arguments: [commandArgument(lenses[1])],
  });
  const applied = client.serverRequests.filter(({ method }) => method === 'workspace/applyEdit');
  assert.equal(applied.length, 1);
  assert.match(JSON.stringify(applied[0].params), /"newText":"ONE\(\);"/);

  // The open buffer, not the saved file, decides whether the original lines are still there.
  client.notify('textDocument/didChange', {
    textDocument: { uri, version: 2 },
    contentChanges: [
      { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 6 } }, text: 'changed();' },
    ],
  });
  const [stale] = await codeActions(client, uri, 0);
  assert.match(String(record(record(stale).disabled).reason), /changed since the last scan/);
});

test('dismissing persists to .loadwise/dismissed.json, hides the diagnostic, and restoring shows it again', async (context) => {
  const workspace = createWorkspace(temporaryBase(), 'shop', {
    'tsconfig.json': '{}',
    'orders.ts': ordersText,
  });
  seedOrders(workspace);
  const client = await startServer(context, workspace);
  const uri = fileUri(workspace, 'orders.ts');
  await until(() => client.diagnostics.get(uri)?.length === 4, 'diagnostics');
  const [, dismissThis, dismissFile] = await codeActions(client, uri, 0);
  await client.request('workspace/executeCommand', {
    command: 'loadwise.dismiss',
    arguments: [commandArgument(dismissThis)],
  });
  const stored = path.join(workspace.root, '.loadwise', 'dismissed.json');
  assert.deepEqual(JSON.parse(fs.readFileSync(stored, 'utf8')), [
    { file: 'orders.ts', ruleId: 'array-repeated-membership', lineText: 'one();' },
  ]);
  await until(() => client.diagnostics.get(uri)?.length === 3, 'the dismissed diagnostic to disappear');
  assert.equal(fs.readFileSync(path.join(workspace.root, 'orders.ts'), 'utf8'), ordersText, 'never written into code');

  await client.request('workspace/executeCommand', {
    command: 'loadwise.dismiss',
    arguments: [commandArgument(dismissFile)],
  });
  await until(
    () =>
      codes(client.diagnostics.get(uri)).map(String).toSorted().join() ===
      'pg-dynamic-query-text,pg-transaction-on-pool',
    'the rule to disappear from the file',
  );

  client.onRequest('window/showMessageRequest', (params) => list(record(params).actions)[0]);
  await client.request('workspace/executeCommand', { command: 'loadwise.showDismissed', arguments: [] });
  const shown = record(client.serverRequests.findLast(({ method }) => method === 'window/showMessageRequest')?.params);
  assert.match(String(shown.message), /1\. array-repeated-membership — orders\.ts — one\(\);/);
  assert.match(String(shown.message), /2\. array-repeated-membership — orders\.ts — Whole file/);
  assert.deepEqual(titles(shown.actions), ['Restore all (2)', 'Restore 1', 'Restore 2']);
  await until(() => client.diagnostics.get(uri)?.length === 4, 'restored diagnostics');
  assert.deepEqual(JSON.parse(fs.readFileSync(stored, 'utf8')), []);

  // A dismissal written by another editor or a checkout applies without a rescan.
  fs.writeFileSync(stored, JSON.stringify([{ file: 'orders.ts', ruleId: 'pg-dynamic-query-text' }]));
  client.notify('workspace/didChangeWatchedFiles', { changes: [{ uri: pathToFileURL(stored).href, type: 2 }] });
  await until(() => client.diagnostics.get(uri)?.length === 3, 'the externally dismissed finding to disappear');
  await client.request('workspace/executeCommand', { command: 'loadwise.restoreDismissed', arguments: [] });
  await until(() => client.diagnostics.get(uri)?.length === 4, 'restore all');
});

test('the severity and codeLens settings apply from initialization options and configuration changes', async (context) => {
  const workspace = createWorkspace(temporaryBase(), 'shop', {
    'tsconfig.json': '{}',
    'orders.ts': ordersText,
  });
  seedOrders(workspace);
  const client = await startServer(context, workspace, {
    initializationOptions: { cli: workspace.cli, severity: 'information', codeLens: false },
    clientCapabilities: { ...capabilities, workspace: { ...capabilities.workspace, configuration: false } },
  });
  const uri = fileUri(workspace, 'orders.ts');
  const severities = () => (client.diagnostics.get(uri) ?? []).map((diagnostic) => record(diagnostic).severity);
  await until(() => severities().length === 4, 'diagnostics');
  assert.deepEqual(severities(), [3, 3, 3, 3]);
  assert.deepEqual(await client.request('textDocument/codeLens', { textDocument: { uri } }), []);
  client.notify('workspace/didChangeConfiguration', {
    settings: { loadwise: { cli: workspace.cli, severity: 'hint', codeLens: true } },
  });
  await until(() => severities().join() === '4,4,4,4', 'hint severity');
  assert.equal(list(await client.request('textDocument/codeLens', { textDocument: { uri } })).length, 7);
});

test('saves and watched-file changes rescan, workspace folders come and go, and shutdown stops every checker', async (context) => {
  const base = temporaryBase();
  const shop = createWorkspace(base, 'shop', { 'tsconfig.json': '{}', 'orders.ts': ordersText });
  const billing = createWorkspace(base, 'billing', { 'invoice.ts': 'total();\n' });
  writeReport(shop, 'watch.json', []);
  const maintFinding = (file: string, ruleId: string) => ({ file, line: 1, column: 1, ruleId, message: 'Nested.' });
  writeReport(shop, 'maint.json', [maintFinding('orders.ts', 'deep-nesting')]);
  writeReport(billing, 'maint.json', [maintFinding('invoice.ts', 'duplicate-implementation')]);
  const client = await startServer(context, shop);
  const ordersUri = fileUri(shop, 'orders.ts');
  await until(() => codes(client.diagnostics.get(ordersUri)).join() === 'deep-nesting', 'maintainability diagnostics');

  writeReport(shop, 'maint.json', [maintFinding('orders.ts', 'deep-control-flow')]);
  client.notify('workspace/didChangeWatchedFiles', { changes: [{ uri: ordersUri, type: 2 }] });
  await until(
    () => codes(client.diagnostics.get(ordersUri)).join() === 'deep-control-flow',
    'a rescan after a file change',
  );
  writeReport(shop, 'maint.json', []);
  const runs = () => fs.readFileSync(path.join(shop.reports, 'runs.log'), 'utf8');
  const runsBeforeSave = runs().length;
  client.notify('textDocument/didOpen', {
    textDocument: { uri: ordersUri, languageId: 'typescript', version: 1, text: ordersText },
  });
  client.notify('textDocument/didSave', { textDocument: { uri: ordersUri } });
  await until(() => client.diagnostics.get(ordersUri)?.length === 0, 'a rescan after a save');
  // The checkers run one after another and a newer change cancels the rest of a scan, so security
  // runs once maintainability reports for the latest change.
  await until(
    () => /^sec -p tsconfig\.json --json$/m.test(runs().slice(runsBeforeSave)),
    'security to run again after maintainability',
  );

  const invoiceUri = fileUri(billing, 'invoice.ts');
  client.notify('workspace/didChangeWorkspaceFolders', {
    event: { added: [{ uri: billing.uri, name: 'billing' }], removed: [] },
  });
  await until(
    () => codes(client.diagnostics.get(invoiceUri)).join() === 'duplicate-implementation',
    'the added folder',
  );
  client.notify('workspace/didChangeWorkspaceFolders', {
    event: { added: [], removed: [{ uri: billing.uri, name: 'billing' }] },
  });
  await until(() => client.diagnostics.get(invoiceUri)?.length === 0, 'the removed folder to clear');

  const watcher = Number(fs.readFileSync(path.join(shop.reports, 'watch.pid'), 'utf8'));
  assert.ok(isRunning(watcher));
  await client.request('shutdown');
  client.notify('exit');
  await client.exited;
  await until(() => !isRunning(watcher), 'the watcher to stop');
});

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test(
  'with the bundled checkers, the incremental watcher reports a real finding',
  { timeout: 120_000 },
  async (context) => {
    const example = fs.readFileSync(path.resolve(import.meta.dirname, '../../examples/slow.ts'), 'utf8');
    const workspace = createWorkspace(temporaryBase(), 'shop', {
      'tsconfig.json': JSON.stringify({ compilerOptions: { strict: true }, include: ['slow.ts'] }),
      'slow.ts': example,
    });
    const client = await startServer(context, workspace, { initializationOptions: {} });
    const uri = fileUri(workspace, 'slow.ts');
    const found = await until(
      () =>
        (client.diagnostics.get(uri) ?? [])
          .map(record)
          .find((diagnostic) => diagnostic.code === 'array-repeated-membership'),
      'a real performance finding',
      100_000,
    );
    assert.equal(found.source, 'loadwise perf');
    assert.equal(startLine(found), 5);
  },
);

function runLog(workspace: Workspace): string {
  try {
    return fs.readFileSync(path.join(workspace.reports, 'runs.log'), 'utf8');
  } catch {
    return '';
  }
}

const finding = (file: string, ruleId: string, line = 1) => ({ file, line, column: 1, ruleId, message: 'Found.' });

test('with the watcher running, template findings come from an accessibility scan of their own', async (context) => {
  const workspace = createWorkspace(temporaryBase(), 'shop', {
    'tsconfig.json': '{}',
    'orders.ts': ordersText,
    'index.html': '<img src="a.png">\n',
  });
  writeReport(workspace, 'watch.json', [finding('orders.ts', 'array-repeated-membership')]);
  // The one-shot scan also reports the JSX the watcher already shows; only the template is kept.
  writeReport(workspace, 'a11y.json', [finding('index.html', 'img-alt'), finding('orders.ts', 'img-alt')]);
  const client = await startServer(context, workspace);
  const htmlUri = fileUri(workspace, 'index.html');
  await until(() => codes(client.diagnostics.get(htmlUri)).join() === 'img-alt', 'the template finding');
  // The watcher publishes separately from the template scan, so its findings can arrive later.
  await until(
    () => codes(client.diagnostics.get(fileUri(workspace, 'orders.ts'))).join() === 'array-repeated-membership',
    'the watcher finding without the duplicate JSX one',
  );
  assert.match(runLog(workspace), /^a11y -p tsconfig\.json --json$/m);
  assert.match(JSON.stringify(client.serverRequests), /html/);

  writeReport(workspace, 'a11y.json', []);
  client.notify('workspace/didChangeWatchedFiles', { changes: [{ uri: htmlUri, type: 2 }] });
  await until(() => client.diagnostics.get(htmlUri)?.length === 0, 'a rescan after a template change');
});

test('a terminal scan refresh picks up a template the editor never reported', async (context) => {
  const workspace = createWorkspace(temporaryBase(), 'shop', { 'tsconfig.json': '{}', 'orders.ts': ordersText });
  writeReport(workspace, 'watch.json', [finding('orders.ts', 'array-repeated-membership')]);
  const client = await startServer(context, workspace);
  const ordersUri = fileUri(workspace, 'orders.ts');
  await until(() => codes(client.diagnostics.get(ordersUri)).join() === 'array-repeated-membership', 'the watcher');

  // Clients without watched-file registration send no creation notice, so only the refresh reveals it.
  fs.writeFileSync(path.join(workspace.root, 'index.html'), '<img src="a.png">\n');
  writeReport(workspace, 'a11y.json', [finding('index.html', 'img-alt')]);
  notifyEditor(workspace.root);
  await until(
    () => codes(client.diagnostics.get(fileUri(workspace, 'index.html'))).join() === 'img-alt',
    'the template',
  );
});

test('a folder without a config is scanned the way loadwise check scans it', async (context) => {
  const workspace = createWorkspace(temporaryBase(), 'shop', {
    'package.json': '{"name":"shop"}',
    'orders.js': ordersText,
  });
  writeReport(workspace, 'perf.json', [finding('orders.js', 'array-repeated-membership')]);
  const client = await startServer(context, workspace);
  const uri = fileUri(workspace, 'orders.js');
  await until(() => codes(client.diagnostics.get(uri)).join() === 'array-repeated-membership', 'plain JavaScript');
  await until(() => /^sec -p \. --json$/m.test(runLog(workspace)), 'the security scan');
  assert.match(runLog(workspace), /^perf -p \. --json$/m);
  assert.doesNotMatch(runLog(workspace), /--watch/);
});

test('a tsconfig.json beside a jsconfig.json is scanned as the folder, like loadwise check', async (context) => {
  const workspace = createWorkspace(temporaryBase(), 'shop', {
    'tsconfig.json': '{}',
    'jsconfig.json': '{}',
    'orders.ts': ordersText,
  });
  const client = await startServer(context, workspace);
  await until(() => /^sec -p \. --json$/m.test(runLog(workspace)), 'the security scan');
  assert.match(runLog(workspace), /^perf -p \. --json$/m);
  assert.match(runLog(workspace), /^rel -p \. --json$/m);
  assert.doesNotMatch(runLog(workspace), /--watch/);
  assert.ok(client.child.exitCode === null);
});

test('nested workspace folders show one diagnostic per finding and both rescan on a change', async (context) => {
  const base = temporaryBase();
  const shop = createWorkspace(base, 'shop', { 'pkg/orders.ts': ordersText });
  const nestedRoot = path.join(shop.root, 'pkg');
  // The fake checker reads the reports of the folder with the same base name.
  const nested: Workspace = {
    ...shop,
    root: nestedRoot,
    uri: pathToFileURL(nestedRoot).href,
    reports: path.join(base, 'cli', 'pkg'),
  };
  fs.mkdirSync(nested.reports, { recursive: true });
  writeReport(shop, 'maint.json', [finding('pkg/orders.ts', 'deep-nesting')]);
  writeReport(nested, 'maint.json', [finding('orders.ts', 'deep-nesting')]);
  const client = await startServer(context, shop);
  // Folder changes are handled once the server has registered for them, after its first folders.
  await until(() => /maint/.test(runLog(shop)), 'the parent folder to scan');
  client.notify('workspace/didChangeWorkspaceFolders', {
    event: { added: [{ uri: nested.uri, name: 'pkg' }], removed: [] },
  });
  const uri = fileUri(nested, 'orders.ts');
  await until(() => /maint/.test(runLog(nested)), 'the nested folder to scan');
  await until(() => client.diagnostics.get(uri)?.length === 1, 'one diagnostic');
  assert.equal(
    (await codeActions(client, uri, 0)).filter((action) => String(record(action).title).startsWith('Dismiss this'))
      .length,
    1,
  );

  const parentRuns = runLog(shop).length;
  const nestedRuns = runLog(nested).length;
  client.notify('workspace/didChangeWatchedFiles', { changes: [{ uri, type: 2 }] });
  await until(
    () => runLog(shop).length > parentRuns && runLog(nested).length > nestedRuns,
    'the parent and the nested folder to rescan',
  );
});

// A parent folder `shop` that reports `pkg/orders.ts`, and the nested folder `pkg`, not yet added.
async function startNestedFolders(context: TestContext, nestedFiles: Record<string, string> = {}) {
  const base = temporaryBase();
  const shop = createWorkspace(base, 'shop', {
    'pkg/orders.ts': ordersText,
    'other.ts': 'other();\n',
    ...Object.fromEntries(Object.entries(nestedFiles).map(([file, text]) => ['pkg/' + file, text])),
  });
  const nestedRoot = path.join(shop.root, 'pkg');
  const nested = { uri: pathToFileURL(nestedRoot).href, name: 'pkg' };
  fs.mkdirSync(path.join(base, 'cli', 'pkg'), { recursive: true });
  writeReport(shop, 'maint.json', [finding('pkg/orders.ts', 'deep-nesting'), finding('other.ts', 'deep-nesting')]);
  const client = await startServer(context, shop);
  const uri = pathToFileURL(path.join(nestedRoot, 'orders.ts')).href;
  await until(() => client.diagnostics.get(uri)?.length === 1, 'the parent folder to report the nested file');
  return { client, nested, uri, otherUri: fileUri(shop, 'other.ts') };
}

test('a nested folder with loadwise disabled hides what the parent reports for its files', async (context) => {
  const { client, nested, uri, otherUri } = await startNestedFolders(context);
  client.onRequest('workspace/configuration', (params) => {
    const [item] = list(record(params).items).map(record);
    return [item.scopeUri === nested.uri ? { enabled: false } : null];
  });
  client.notify('workspace/didChangeWorkspaceFolders', { event: { added: [nested], removed: [] } });
  await until(() => client.diagnostics.get(uri)?.length === 0, 'the disabled folder to hide the finding');
  assert.equal(client.diagnostics.get(otherUri)?.length, 1, 'the parent keeps its own files');
});

test('adding or removing a nested folder applies or drops its dismissals on the parent findings', async (context) => {
  const dismissed = JSON.stringify([{ file: 'orders.ts', ruleId: 'deep-nesting' }]);
  const { client, nested, uri } = await startNestedFolders(context, { '.loadwise/dismissed.json': dismissed });
  client.notify('workspace/didChangeWorkspaceFolders', { event: { added: [nested], removed: [] } });
  await until(() => client.diagnostics.get(uri)?.length === 0, 'the nested dismissal to hide the parent finding');
  client.notify('workspace/didChangeWorkspaceFolders', { event: { added: [], removed: [nested] } });
  await until(() => client.diagnostics.get(uri)?.length === 1, 'the parent finding to return');
});

test('a refused multi-file edit without a failure index warns that earlier changes may remain', async (context) => {
  const workspace = createWorkspace(temporaryBase(), 'shop', {
    'tsconfig.json': '{}',
    'orders.ts': ordersText,
    'migrations/000_init.sql': '',
  });
  seedOrders(workspace);
  const client = await startServer(context, workspace);
  const uri = fileUri(workspace, 'orders.ts');
  await until(() => client.diagnostics.get(uri)?.length === 4, 'diagnostics');
  client.onRequest('workspace/applyEdit', () => ({ applied: false }));
  const lenses = list(await client.request('textDocument/codeLens', { textDocument: { uri } }));
  const createLens = lenses.find((lens) => record(record(lens).command).title === 'Apply fix: pg-transaction-on-pool');
  await client.request('workspace/executeCommand', {
    command: 'loadwise.applyFix',
    arguments: [commandArgument(createLens)],
  });
  // Warnings go out as message requests.
  const warning = await until(
    () => client.serverRequests.findLast(({ method }) => method === 'window/showMessageRequest'),
    'the warning',
  );
  assert.match(String(record(warning?.params).message), /may have kept changes/);
});

test('a late answer to an older settings request does not overwrite newer settings', async (context) => {
  const workspace = createWorkspace(temporaryBase(), 'shop', { 'tsconfig.json': '{}', 'orders.ts': ordersText });
  seedOrders(workspace);
  const client = await startServer(context, workspace);
  let requests = 0;
  client.onRequest('workspace/configuration', () => {
    requests++;
    if (requests === 1) {
      client.notify('workspace/didChangeConfiguration', { settings: null });
      return new Promise((resolve) => setTimeout(() => resolve([{ severity: 'error', cli: workspace.cli }]), 500));
    }
    return [{ severity: 'hint', cli: workspace.cli }];
  });
  client.notify('workspace/didChangeConfiguration', { settings: null });
  const severities = () =>
    (client.diagnostics.get(fileUri(workspace, 'orders.ts')) ?? []).map((item) => record(item).severity);
  await until(() => requests === 2 && severities().length === 4 && severities().every((level) => level === 4), 'hint');
  await new Promise((resolve) => setTimeout(resolve, 800));
  assert.ok(
    severities().every((level) => level === 4),
    'the older answer arrived later and was dropped',
  );
});

test('a severity change republishes without restarting the watcher; a project change restarts it', async (context) => {
  const workspace = createWorkspace(temporaryBase(), 'shop', { 'tsconfig.json': '{}', 'orders.ts': ordersText });
  seedOrders(workspace);
  const client = await startServer(context, workspace, {
    initializationOptions: { cli: workspace.cli },
    clientCapabilities: { ...capabilities, workspace: { ...capabilities.workspace, configuration: false } },
  });
  const uri = fileUri(workspace, 'orders.ts');
  const watchRuns = () => runLog(workspace).match(/--watch/g)?.length ?? 0;
  await until(() => client.diagnostics.get(uri)?.length === 4 && watchRuns() === 1, 'the first scan');
  client.notify('workspace/didChangeConfiguration', {
    settings: { loadwise: { cli: workspace.cli, severity: 'hint' } },
  });
  const severities = () => (client.diagnostics.get(uri) ?? []).map((item) => record(item).severity);
  await until(() => severities().join() === '4,4,4,4', 'hint severity');
  // Longer than the scan debounce, so a restart would have started a second watcher.
  await new Promise((resolve) => setTimeout(resolve, 1500));
  assert.equal(watchRuns(), 1);
  client.notify('workspace/didChangeConfiguration', {
    settings: { loadwise: { cli: workspace.cli, severity: 'hint', project: 'tsconfig.json' } },
  });
  await until(() => watchRuns() === 2, 'a new watcher for the new project setting');
});

test('a dismissal from a buffer opened with unsaved edits records the saved line', async (context) => {
  const workspace = createWorkspace(temporaryBase(), 'shop', { 'tsconfig.json': '{}', 'orders.ts': ordersText });
  seedOrders(workspace);
  const client = await startServer(context, workspace);
  const uri = fileUri(workspace, 'orders.ts');
  await until(() => client.diagnostics.get(uri)?.length === 4, 'diagnostics');
  client.notify('textDocument/didOpen', {
    textDocument: { uri, languageId: 'typescript', version: 7, text: 'edited();\ntwo();\nthree();\n' },
  });
  // The server handles messages in order, so the code actions see the opened buffer.
  const dismissThis = (await codeActions(client, uri, 0)).find((action) =>
    String(record(action).title).startsWith('Dismiss this'),
  );
  assert.equal(record(commandArgument(dismissThis)).lineText, 'one();');
});

test('a fix creating a file in a missing folder makes the folder, and removes it when the edit is refused', async (context) => {
  const workspace = createWorkspace(temporaryBase(), 'shop', { 'tsconfig.json': '{}', 'orders.ts': ordersText });
  seedOrders(workspace);
  const client = await startServer(context, workspace);
  const uri = fileUri(workspace, 'orders.ts');
  await until(() => client.diagnostics.get(uri)?.length === 4, 'diagnostics');
  const createAction = record(
    (await codeActions(client, uri, 1)).find((action) => record(action).title === 'Apply fix: pg-transaction-on-pool'),
  );
  assert.equal(createAction.edit, undefined, 'the command makes the folder first');
  const migrations = path.join(workspace.root, 'migrations');
  let folderExisted = false;
  client.onRequest('workspace/applyEdit', () => {
    folderExisted = fs.existsSync(migrations);
    return { applied: false };
  });
  await client.request('workspace/executeCommand', {
    command: 'loadwise.applyFix',
    arguments: [commandArgument(createAction)],
  });
  assert.equal(folderExisted, true);
  assert.equal(fs.existsSync(migrations), false, 'a refused edit leaves no empty folder behind');
});
