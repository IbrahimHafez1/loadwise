import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { Finding } from '../../lib/shared/types.js';
import type { FileMap } from '../types/project-files.js';
import * as nativeRuntime from '../../lib/performance/native-runtime.js';

const bin = path.resolve(import.meta.dirname, '../../bin/loadwise.js');
const [major, minor] = process.versions.node.split('.').map(Number);
let skip = major < 22 || (major === 22 && minor < 13) ? 'native requires Node 22.13+' : false;
try {
  if (!skip) nativeRuntime.executable();
} catch {
  skip = 'optional native compiler is absent';
}

function write(directory: string, files: FileMap) {
  for (const [name, contents] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(directory, name)), { recursive: true });
    fs.writeFileSync(path.join(directory, name), contents);
  }
}

test('an uninstalled sibling workspace package resolves to its source on both engines', { skip }, (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'loadwise-native-workspace-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  write(directory, {
    'package.json': '{"private":true,"workspaces":["packages/*"]}',
    // The root config covers every package and declares no alias for the sibling, as in a
    // monorepo's jsconfig.
    'tsconfig.json': '{"compilerOptions":{"target":"ES2022","strict":true,"allowJs":true},"include":["packages"]}',
    'packages/common/package.json': '{"name":"@scope/common","main":"dist/index.js"}',
    'packages/common/src/log.ts':
      'async function send(message: string): Promise<void> {}\nexport const Log = { warn: (message: string) => send(message) };',
    'packages/app/package.json': '{"name":"@scope/app"}',
    'packages/app/src/use.ts':
      "import { Log } from '@scope/common/log';\nexport async function run() {\n  Log.warn('x');\n}",
  });
  const run = (engine: string) => {
    const result = spawnSync(process.execPath, [bin, 'perf', '-p', '.', '--engine', engine, '--json'], {
      cwd: directory,
      encoding: 'utf8',
    });
    const { engine: _engine, ...report } = JSON.parse(result.stdout);
    return report;
  };
  const javascript = run('js');
  assert.ok(javascript.findings.some((finding: Finding) => finding.ruleId === 'floating-promise'));
  assert.deepEqual(run('native'), javascript);
});
