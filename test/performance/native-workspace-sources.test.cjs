'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const bin = path.resolve(__dirname, '../../bin/loadwise.cjs');
const [major, minor] = process.versions.node.split('.').map(Number);
let skip = major < 22 || (major === 22 && minor < 13) ? 'native requires Node 22.13+' : false;
try {
  if (!skip) require('../../lib/performance/native-runtime.cjs').executable();
} catch {
  skip = 'optional native compiler is absent';
}

function write(directory, files) {
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
    // The root config covers every package and declares no alias for the sibling, as in a monorepo's jsconfig.
    'tsconfig.json': '{"compilerOptions":{"target":"ES2022","strict":true,"allowJs":true},"include":["packages"]}',
    'packages/common/package.json': '{"name":"@scope/common","main":"dist/index.js"}',
    'packages/common/src/log.ts':
      'async function send(message: string): Promise<void> {}\nexport const Log = { warn: (message: string) => send(message) };',
    'packages/app/package.json': '{"name":"@scope/app"}',
    'packages/app/src/use.ts':
      "import { Log } from '@scope/common/log';\nexport async function run() {\n  Log.warn('x');\n}",
  });
  const run = (engine) => {
    const result = spawnSync(process.execPath, [bin, 'perf', '-p', '.', '--engine', engine, '--json'], {
      cwd: directory,
      encoding: 'utf8',
    });
    const { engine: _engine, ...report } = JSON.parse(result.stdout);
    return report;
  };
  const javascript = run('js');
  assert.ok(javascript.findings.some((finding) => finding.ruleId === 'floating-promise'));
  assert.deepEqual(run('native'), javascript);
});
