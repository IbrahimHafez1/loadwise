'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { formatFinding } = require('../lib/editor-report.cjs');

const MIGRATION = 'prisma/migrations/20240101_init/migration.sql';

function write(root, name, text) {
  fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
  fs.writeFileSync(path.join(root, name), text);
}

function migrationProject(context) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'editor-migrations-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  write(root, 'package.json', '{"dependencies":{"@prisma/client":"6"}}');
  write(root, 'prisma/schema.prisma', '');
  write(root, 'prisma/migrations/migration_lock.toml', 'provider = "postgresql"\n');
  write(root, MIGRATION, "SET lock_timeout = '5s';\nALTER TABLE orders DROP COLUMN legacy;\n");
  return root;
}

// Runs the real editor-watch worker against a fake file watcher and resolves with every logged line of one scan.
async function scanAfterSave(context, root, savedFile) {
  const watcher = new EventEmitter();
  watcher.close = async () => {};
  const originalLoad = Module._load;
  Module._load = function (request, ...rest) {
    if (request === './recursive-watch.cjs') return { watchTree: () => watcher };
    if (request === './editor-signal.cjs') return { listenForEditorRefresh: () => ({ close() {} }) };
    return originalLoad.call(this, request, ...rest);
  };
  const originalSend = process.send;
  const originalDisconnect = process.disconnect;
  const originalWorker = process.env.BACKEND_CHECKERS_EDITOR_WORKER;
  const originalConnected = Object.getOwnPropertyDescriptor(process, 'connected');
  process.send = () => {};
  process.disconnect = () => {};
  process.env.BACKEND_CHECKERS_EDITOR_WORKER = '1';
  Object.defineProperty(process, 'connected', { value: true, configurable: true, writable: true });
  const logged = [];
  context.mock.method(console, 'log', (line) => logged.push(line));
  context.after(() => {
    process.emit('SIGINT');
    Module._load = originalLoad;
    process.send = originalSend;
    process.disconnect = originalDisconnect;
    if (originalWorker === undefined) delete process.env.BACKEND_CHECKERS_EDITOR_WORKER;
    else process.env.BACKEND_CHECKERS_EDITOR_WORKER = originalWorker;
    if (originalConnected) Object.defineProperty(process, 'connected', originalConnected);
    else delete process.connected;
  });
  const modulePath = require.resolve('../lib/editor-watch.cjs');
  delete require.cache[modulePath];
  require(modulePath).watchEditor(root, undefined, async () => []);
  watcher.once('ready', () => {});
  // Let the initial scan (triggered by ready) finish, then save the file and wait for the follow-up scan.
  watcher.emit('ready');
  await waitForFinishedScans(logged, 1);
  watcher.emit('all', 'change', savedFile);
  await waitForFinishedScans(logged, 2);
  return logged;
}

async function waitForFinishedScans(logged, count) {
  const deadline = Date.now() + 20000;
  while (logged.filter((line) => line === 'Backend Checkers: scan finished').length < count) {
    if (Date.now() > deadline) throw new Error('scan did not finish');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test('editor rescans on .sql saves and reports migration findings on the statement line', async (context) => {
  const root = migrationProject(context);
  const logged = await scanAfterSave(context, root, MIGRATION);
  const markers = logged.filter((line) => line.startsWith('BACKEND_CHECKER | ' + path.normalize(MIGRATION)));
  assert.ok(markers.length >= 2, 'one marker per scan');
  assert.match(markers[0], /^BACKEND_CHECKER \| [^|]+ \| 2 \| /, 'points at the ALTER TABLE statement line');
  assert.ok(logged.filter((line) => line === 'Backend Checkers: scan started').length >= 2);
});

test('editor ignores baselined migrations', async (context) => {
  const root = migrationProject(context);
  const { writeBaseline } = require('../lib/migrations/enforce.cjs');
  writeBaseline(path.join(root, 'backend-perf.migrations-baseline.json'), [
    { path: path.join(root, MIGRATION), text: fs.readFileSync(path.join(root, MIGRATION), 'utf8') },
  ]);
  const logged = await scanAfterSave(context, root, 'prisma/schema.prisma');
  assert.equal(logged.filter((line) => line.startsWith('BACKEND_CHECKER')).length, 0);
});

test('editor report formats .sql and .prisma findings', (context) => {
  const root = migrationProject(context);
  for (const file of [MIGRATION, 'prisma/schema.prisma']) {
    write(root, file, 'ALTER TABLE orders DROP COLUMN legacy;\n');
    const report = formatFinding(root, 'backend-perf-check', {
      file,
      line: 1,
      column: 1,
      ruleId: 'pg-drop-column',
      message: 'Dropping a column.',
    });
    assert.match(report, /^BACKEND_CHECKER \| [^|]+ \| 1 \| 1 \| \d+ \| warning \| pg-drop-column \|/);
  }
});

test('I4: an editor scan never loads lib/db modules', async (context) => {
  const root = migrationProject(context);
  await scanAfterSave(context, root, MIGRATION);
  const loaded = Object.keys(require.cache).filter((file) => /[\\/]lib[\\/]db[\\/]/.test(file));
  assert.deepEqual(loaded, []);
});
