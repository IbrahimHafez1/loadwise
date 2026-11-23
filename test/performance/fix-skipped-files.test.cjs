'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawnSync } = require('node:child_process');

const bin = path.resolve(__dirname, '../../bin/loadwise.cjs');
const example = fs.readFileSync(path.resolve(__dirname, '../../examples/slow.ts'), 'utf8');

function projectWithBrokenFile(context) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loadwise-fix-skipped-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'slow.ts'), example);
  fs.writeFileSync(path.join(root, 'broken.ts'), 'export const broken = ;');
  fs.writeFileSync(
    path.join(root, 'tsconfig.json'),
    '{"compilerOptions":{"target":"ES2022","strict":true},"files":["slow.ts","broken.ts"]}',
  );
  return root;
}

test('perf --fix --yes applies the fixes of valid files, names the skipped file and exits 2', (context) => {
  const root = projectWithBrokenFile(context);
  const result = spawnSync(process.execPath, [bin, 'perf', '-p', 'tsconfig.json', '--fix', '--yes', '--engine', 'js'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, LOADWISE_AGENT: '0' },
    timeout: 120000,
  });
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /broken\.ts.*Skipped that file, which does not parse/);
  assert.match(result.stdout, /Applied [1-9]\d* of \d+ automatic fix\(es\)\./);
  assert.notEqual(fs.readFileSync(path.join(root, 'slow.ts'), 'utf8'), example);
  assert.equal(fs.readFileSync(path.join(root, 'broken.ts'), 'utf8'), 'export const broken = ;');
});
