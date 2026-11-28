import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import type { TestContext } from 'node:test';
import { isRecord } from '../../lib/shared/is-record.js';
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
      await client.request('shutdown').catch(() => {});
      client.notify('exit');
      await client.exited;
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
  assert.match(String(record(first.codeDescription).href), /#array-repeated-membership$/);
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
  assert.deepEqual(
    list(fixAllChanges[0].edits).map((edit) => record(edit).newText),
    ['ONE();', 'THREE();'],
    'one edit for the whole file, so one undo reverts it',
  );
  assert.equal(fixAllChanges[1].kind, 'create');

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
  client.notify('textDocument/didOpen', {
    textDocument: { uri: ordersUri, languageId: 'typescript', version: 1, text: ordersText },
  });
  client.notify('textDocument/didSave', { textDocument: { uri: ordersUri } });
  await until(() => client.diagnostics.get(ordersUri)?.length === 0, 'a rescan after a save');
  // The checkers run one after another and a newer change cancels the rest of a scan, so security
  // runs once maintainability reports for the latest change.
  const runs = () => fs.readFileSync(path.join(shop.reports, 'runs.log'), 'utf8');
  await until(() => /^sec -p tsconfig\.json --json$/m.test(runs()), 'security to run after maintainability');

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
