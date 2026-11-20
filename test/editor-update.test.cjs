'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once, EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createInterface } = require('node:readline');
const test = require('node:test');
const { notifyEditor, signalDirectory } = require('../lib/notify-editor.cjs');

test(
  'an active editor task picks up same-version package replacements and a newly installed companion',
  { timeout: 40000 },
  async (context) => {
    const base = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Temp', 'AI-Work') : os.tmpdir();
    fs.mkdirSync(base, { recursive: true });
    const root = fs.mkdtempSync(path.join(base, 'editor-package-update-'));
    const registrations = signalDirectory(root);
    const dependencies = path.join(root, 'node_modules');
    const backend = path.join(dependencies, '@codewarden', 'backend'),
      companion = path.join(dependencies, '@codewarden', 'maintainability');
    const cli = path.join(backend, 'bin', 'warden-backend.cjs');
    const companionCli = path.join(companion, 'bin', 'warden-maint.cjs');
    const watchModule = JSON.stringify(require.resolve('../lib/editor-watch.cjs'));
    function backendEntry(message) {
      return `const { watchEditor } = require(${watchModule});
      if (process.send) console.error('fixture-worker ' + process.pid);
      watchEditor(process.cwd(), undefined, () => [{file:'sample.ts', line:1, column:1, ruleId:'check-sample', message:${JSON.stringify(message)}}]);`;
    }
    fs.mkdirSync(path.dirname(cli), { recursive: true });
    const source = path.join(root, 'sample.ts');
    const manifest = path.join(backend, 'package.json'),
      companionManifest = path.join(companion, 'package.json');
    fs.writeFileSync(source, 'const ready = true;');
    fs.writeFileSync(manifest, '{"name":"@codewarden/backend","version":"1.0.0"}');
    fs.writeFileSync(cli, backendEntry('old rules'));
    const child = spawn(process.execPath, [cli, 'editor', 'watch'], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const events = new EventEmitter();
    let errors = '',
      results = [];
    child.stderr.setEncoding('utf8').on('data', (text) => {
      errors += text;
    });
    const done = once(child, 'close');
    child.on('close', () => events.emit('failed'));
    createInterface({ input: child.stdout }).on('line', (line) => {
      if (line === 'Backend Checkers: scan started') results = [];
      if (line.startsWith('BACKEND_CHECKER | ')) results.push(line);
      if (line === 'Backend Checkers: scan finished') events.emit('snapshot', results);
    });
    function until(predicate) {
      return new Promise((resolve, reject) => {
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
        function visit(snapshot) {
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
      // A forced Windows process termination may leave one empty registration; the next CLI consumes it.
      notifyEditor(root);
      if (fs.existsSync(registrations)) fs.rmdirSync(registrations);
      for (const file of [source, cli, manifest, companionCli, companionManifest]) fs.rmSync(file, { force: true });
      for (const directory of [
        path.dirname(companionCli),
        companion,
        path.dirname(cli),
        backend,
        path.dirname(backend),
        dependencies,
        root,
      ]) {
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
    const joined = until((rows) => rows.some((row) => row.endsWith('companion installed')));
    fs.mkdirSync(path.dirname(companionCli), { recursive: true });
    fs.writeFileSync(companionManifest, '{"name":"@codewarden/maintainability","version":"1.0.0"}');
    fs.writeFileSync(
      companionCli,
      `if (process.env.BACKEND_CHECKERS_EDITOR_SCAN !== '1') process.exit(2);
    console.log(JSON.stringify({findings:[{file:'sample.ts',line:1,column:1,ruleId:'check-sample',message:'companion installed'}]}));`,
    );
    assert.equal((await joined).length, 2);
    const removed = until((rows) => rows.length === 1 && rows[0].endsWith('new rules'));
    fs.unlinkSync(companionManifest);
    fs.unlinkSync(companionCli);
    await removed;
  },
);
