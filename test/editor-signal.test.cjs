'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { signalDirectory } = require('../lib/notify-editor.cjs');

test('successful source scans consume only active editor registrations, with identical CLI output', () => {
  const cli = path.resolve(__dirname, '../bin/warden-maint.cjs');
  const base = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Temp', 'AI-Work') : os.tmpdir();
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, 'maint-editor-refresh-'));
  const directory = signalDirectory(root);
  const registration = path.join(directory, 'watch-' + '1'.repeat(32));
  const source = path.join(root, 'sample.ts');
  fs.writeFileSync(source, 'export const ok = true;');
  const scan = (env = process.env) => spawnSync(process.execPath, [cli, root, '--json'], { encoding: 'utf8', env });
  try {
    const baseline = scan();
    assert.equal(baseline.status, 0);
    assert.equal(fs.existsSync(directory), false);
    fs.mkdirSync(directory, { mode: 0o700 });
    fs.writeFileSync(registration, '');
    const internal = scan({ ...process.env, BACKEND_CHECKERS_EDITOR_SCAN: '1' });
    assert.equal(internal.stdout, baseline.stdout);
    assert.ok(fs.existsSync(registration));
    const ordinary = scan();
    assert.equal(ordinary.status, baseline.status);
    assert.equal(ordinary.stdout, baseline.stdout);
    assert.equal(fs.existsSync(registration), false);
  } finally {
    fs.rmSync(registration, { force: true });
    if (fs.existsSync(directory)) fs.rmdirSync(directory);
    fs.unlinkSync(source);
    fs.rmdirSync(root);
  }
});
