// The security checker alone on a folder that has no config of its own but sits inside a package
// whose config covers it, as perf and the combined check already do.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { Finding } from '../../lib/shared/types.js';
import type { TestContext } from 'node:test';
import type { FileMap } from '../types/project-files.js';

const cli = path.resolve(import.meta.dirname, '../../bin/loadwise.js');
const insecureSource = "process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';\nexport {};\n";

function project(context: TestContext, files: FileMap) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loadwise-c5b-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), text);
  }
  return root;
}

function loadwise(cwd: string, ...args: string[]) {
  const run = spawnSync(process.execPath, [cli, ...args], {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, LOADWISE_AGENT: '0' },
  });
  return { code: run.status, stdout: run.stdout, stderr: run.stderr };
}

const packageFiles = {
  'package.json': '{"name":"server"}',
  'tsconfig.json': JSON.stringify({ include: ['src/**/*.ts'] }),
  'src/api/connection.ts': insecureSource,
  'src/other/connection.ts': insecureSource,
};

test('check --only sec and sec on a covered folder scan its sources and only them', (context) => {
  const root = project(context, packageFiles);
  const folder = path.join(root, 'src/api');
  const checked = loadwise(folder, 'check', '--json', '--only', 'sec');
  assert.equal(checked.code, 1, checked.stderr);
  assert.doesNotMatch(checked.stderr, /no tsconfig\.json or jsconfig\.json/);
  const security = JSON.parse(checked.stdout).security;
  assert.equal(security.scannedFiles, 1);
  assert.deepEqual([...new Set(security.findings.map(({ file }: Finding) => file))], ['connection.ts']);
  const direct = loadwise(folder, 'sec', '--json');
  assert.equal(direct.code, 1, direct.stderr);
  assert.equal(JSON.parse(direct.stdout).scannedFiles, 1);
});

test('check --only sec on a folder no config covers keeps the skipped-checker note', (context) => {
  const root = project(context, { ...packageFiles, 'scripts/connection.ts': insecureSource });
  const run = loadwise(path.join(root, 'scripts'), 'check', '--json', '--only', 'sec');
  assert.equal(run.code, 0, run.stderr);
  assert.match(run.stderr, /no tsconfig\.json or jsconfig\.json in .*scripts; skipped the security checker/);
  assert.equal(JSON.parse(run.stdout).security, null);
});
