import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';

const cli = path.resolve(import.meta.dirname, '../../bin/loadwise.js');
const slow = fs.readFileSync(path.resolve(import.meta.dirname, '../../examples/slow.ts'), 'utf8');
const validation =
  "import { ValidationPipe } from '@nestjs/common';\ndeclare const app: any;\napp.useGlobalPipes(new ValidationPipe());\n";
const nested = [
  'function pick(items, flag) {',
  '  let total = 0;',
  '  for (const item of items) {',
  '    if (item) {',
  '      if (flag || item.forced) {',
  '        if (item.value > 1) total += item.value;',
  '      }',
  '    }',
  '    total += 1;',
  '  }',
  '  return total;',
  '}',
  'module.exports = { pick };',
].join('\n');

function fixture(context: TestContext) {
  const base = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Temp', 'AI-Work') : os.tmpdir();
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, 'loadwise-fix-selection-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const files = {
    'package.json': '{}',
    'tsconfig.json': '{"files":["slow.ts","validation.ts"]}',
    'node_modules/@nestjs/common/index.d.ts': 'export declare class ValidationPipe { constructor(options?: object); }',
    'slow.ts': slow,
    'nested.cjs': nested,
    'validation.ts': validation,
  };
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  return {
    run: (...args: string[]) =>
      spawnSync(process.execPath, [cli, 'fix', ...args], {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, LOADWISE_AGENT: '0' },
      }),
    read: (name: string) => fs.readFileSync(path.join(root, name), 'utf8'),
  };
}

test('a single checker applies its edits and leaves other checkers untouched', (context) => {
  const project = fixture(context);
  const result = project.run('--all', 'performance');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.notEqual(project.read('slow.ts'), slow);
  assert.match(result.stdout, /Review the changes and remaining findings/);
  assert.doesNotMatch(result.stdout, /loadwise fix --handoff/);
  assert.equal(project.read('nested.cjs'), nested);
  assert.equal(project.read('validation.ts'), validation);
});

test('space-separated names skip unselected changes and keep reviewed edits opt-in', (context) => {
  const project = fixture(context);
  const result = project.run('--yes', 'performance', 'security');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.notEqual(project.read('slow.ts'), slow);
  assert.equal(project.read('nested.cjs'), nested);
  assert.equal(project.read('validation.ts'), validation);
  assert.match(result.stdout, /nest-validation-without-whitelist/);
});

test('full names in a comma-separated selection can apply reviewed edits for just those checkers', (context) => {
  const project = fixture(context);
  const result = project.run('--all', 'maintainability,security');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(project.read('slow.ts'), slow);
  assert.notEqual(project.read('nested.cjs'), nested);
  assert.match(project.read('validation.ts'), /whitelist:\s*true/);
});

test('selecting all three categories applies generated edits across all three', (context) => {
  const project = fixture(context);
  const result = project.run('--all', 'performance', 'maintainability', 'security');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.notEqual(project.read('slow.ts'), slow);
  assert.notEqual(project.read('nested.cjs'), nested);
  assert.match(project.read('validation.ts'), /whitelist:\s*true/);
});

test('an unknown category mixed with valid categories fails before writing any edits', (context) => {
  const project = fixture(context);
  for (const invalid of ['1', '3', 'perf,,sec', 'spelling-error']) {
    const result = project.run('--all', 'performance', invalid);
    assert.equal(result.status, 2, result.stdout + result.stderr);
    assert.equal(project.read('slow.ts'), slow);
    assert.equal(project.read('nested.cjs'), nested);
    assert.equal(project.read('validation.ts'), validation);
  }
});
