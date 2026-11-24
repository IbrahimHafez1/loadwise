import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once, EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';
import { notifyEditor, signalDirectory } from '../../lib/performance/notify-editor.cjs';

test('an active editor task picks up same-version package replacements', { timeout: 40000 }, async (context) => {
  const base = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Temp', 'AI-Work') : os.tmpdir();
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, 'editor-package-update-'));
  const registrations = signalDirectory(root);
  const dependencies = path.join(root, 'node_modules');
  const backend = path.join(dependencies, '@loadwise', 'cli');
  const cli = path.join(backend, 'bin', 'loadwise.cjs');
  const watchModule = JSON.stringify(require.resolve('../../lib/performance/editor-watch.cjs'));
  function backendEntry(message: string) {
    return `const { watchEditor } = require(${watchModule});
      if (process.send) console.error('fixture-worker ' + process.pid);
      watchEditor(process.cwd(), undefined, () => [{file:'sample.ts', line:1, column:1, ruleId:'check-sample', message:${JSON.stringify(message)}}]);`;
  }
  fs.mkdirSync(path.dirname(cli), { recursive: true });
  const source = path.join(root, 'sample.ts');
  const manifest = path.join(backend, 'package.json');
  fs.writeFileSync(source, 'const ready = true;');
  fs.writeFileSync(manifest, '{"name":"@loadwise/cli","version":"1.0.0"}');
  fs.writeFileSync(cli, backendEntry('old rules'));
  const child = spawn(process.execPath, [cli, 'editor', 'watch'], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const events = new EventEmitter();
  let errors = '',
    results: string[] = [];
  child.stderr.setEncoding('utf8').on('data', (text) => {
    errors += text;
  });
  const done = once(child, 'close');
  child.on('close', () => events.emit('failed'));
  createInterface({ input: child.stdout }).on('line', (line) => {
    if (line === 'Loadwise: scan started') results = [];
    if (line.startsWith('BACKEND_CHECKER | ')) results.push(line);
    if (line === 'Loadwise: scan finished') events.emit('snapshot', results);
  });
  function until(predicate: (snapshot: string[]) => boolean): Promise<string[]> {
    return new Promise<string[]>((resolve, reject) => {
      const timer = setTimeout(fail, 10000);
      function clean() {
        clearTimeout(timer);
        events.off('snapshot', visit);
        events.off('failed', fail);
      }
      function fail() {
        clean();
        reject(new Error('Missing watcher snapshot. Last markers: ' + JSON.stringify(results) + '\n' + errors));
      }
      function visit(snapshot: string[]) {
        if (predicate(snapshot)) {
          clean();
          resolve(snapshot);
        }
      }
      events.on('snapshot', visit);
      events.once('failed', fail);
    });
  }
  context.after(async () => {
    child.kill();
    await done;
    for (const match of errors.matchAll(/fixture-worker (\d+)/g)) {
      assert.throws(() => process.kill(Number(match[1]), 0), { code: 'ESRCH' });
    }
    // A forced Windows process termination may leave one empty registration; the next CLI consumes
    // it.
    notifyEditor(root);
    if (fs.existsSync(registrations)) fs.rmdirSync(registrations);
    for (const file of [source, cli, manifest]) fs.rmSync(file, { force: true });
    for (const directory of [path.dirname(cli), backend, path.dirname(backend), dependencies, root]) {
      if (fs.existsSync(directory)) fs.rmdirSync(directory);
    }
  });
  await until((rows) => rows.some((row) => row.endsWith('old rules')));
  const refreshed = until((rows) => rows.some((row) => row.endsWith('old rules')));
  notifyEditor(root);
  await refreshed;
  const updated = until((rows) => rows.some((row) => row.endsWith('new rules')));
  const replacement = cli + '.new';
  fs.writeFileSync(replacement, backendEntry('new rules'));
  fs.renameSync(replacement, cli);
  await updated;
});
