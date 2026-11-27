import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';

const cli = path.join(import.meta.dirname, '..', '..', 'bin', 'loadwise.js');
// Eight positional parameters exceed the default long-parameter-list limit.
const longParametersSource =
  'export function save(a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) {\n  return a + b + c + d + e + f + g + h;\n}\n';

function project(context: TestContext, tsconfig: string) {
  const base = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Temp', 'AI-Work') : os.tmpdir();
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, 'maintainability-extends-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'tsconfig.json'), tsconfig);
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src', 'save.ts'), longParametersSource);
  return root;
}

function scan(root: string) {
  return spawnSync(process.execPath, [cli, 'maint', root, '--json'], { encoding: 'utf8', windowsHide: true });
}

test('a tsconfig extending an uninstalled package scans with a note and still reports findings', (context) => {
  const root = project(context, '{"extends":"@internal/cfg-typescript/esm.json"}');
  const result = scan(root);
  assert.notEqual(result.status, 2, result.stderr);
  assert.match(result.stderr, /Note: .*@internal\/cfg-typescript\/esm\.json.*Checked with this config's own settings/);
  assert.equal(result.stderr.match(/Note: /g)?.length, 1);
  assert.match(result.stdout, /long-parameter-list/);
});

test('a tsconfig extending a missing relative base still fails', (context) => {
  const root = project(context, '{"extends":"./configs/missing.json"}');
  const result = scan(root);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Invalid compiler configuration|missing\.json/);
});
