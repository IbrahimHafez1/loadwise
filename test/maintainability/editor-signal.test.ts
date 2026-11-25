import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { signalDirectory } from '../../lib/maintainability/notify-editor.js';

test('successful source scans consume only active editor registrations, with identical CLI output', () => {
  const cli = path.resolve(import.meta.dirname, '../../bin/loadwise.js');
  const base = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Temp', 'AI-Work') : os.tmpdir();
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, 'maint-editor-refresh-'));
  const directory = signalDirectory(root);
  const registration = path.join(directory, 'watch-' + '1'.repeat(32));
  const source = path.join(root, 'sample.ts');
  fs.writeFileSync(source, 'export const ok = true;');
  const scan = (env = process.env) =>
    spawnSync(process.execPath, [cli, 'maint', root, '--json'], { encoding: 'utf8', env });
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
