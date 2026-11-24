import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { formatHandoff } from '../../lib/shared/fix-handoff.cjs';

const bin = path.resolve(__dirname, '../../bin/loadwise.cjs');

test('handoff lists every manual location, groups repeated messages, and excludes all generated fixes', () => {
  const first = {
    checker: 'sec',
    ruleId: 'rule-a',
    id: 'a1',
    file: 'src/routes.ts',
    line: 3,
    column: 12,
    related: [{ file: 'src/caller.ts', line: 9, column: 1 }],
    message: 'Inspect this call.',
  };
  const result = formatHandoff(
    [
      first,
      { ...first, id: 'a2', line: 4 },
      { ...first, id: 'a3', fix: { changes: [] } },
      { ...first, id: 'a4', fix: { requiresReview: true, changes: [] } },
    ],
    ['sec'],
  );
  assert.match(result, /## sec \/ rule-a/);
  assert.match(result, /#a1 "src\/routes\.ts:3:12"/);
  assert.match(result, /#a2 "src\/routes\.ts:4:12"/);
  assert.match(result, /related: "src\/caller\.ts:9:1"/);
  assert.equal(result.match(/Inspect this call\./g)?.length, 1);
  assert.doesNotMatch(result, /#a[34]/);
  assert.match(result, /loadwise check --only sec --json/);
  assert.match(result, /Reevaluate each diagnostic/);
  assert.match(result, /intentional behavior and false positives with a reason/);
  assert.match(formatHandoff([], []), /No manual findings/);
});

test('CLI handoff scans the selected checker and writes only its brief to stdout', (context) => {
  const base = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Temp', 'AI-Work') : os.tmpdir();
  fs.mkdirSync(base, { recursive: true });
  const directory = fs.mkdtempSync(path.join(base, 'loadwise-handoff-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const inputs = {
    'tsconfig.json': '{"files":["connection.ts","slow.ts"]}',
    'connection.ts': 'export const config = { ssl: { rejectUnauthorized: false as const } };',
    'slow.ts': fs.readFileSync(path.resolve(__dirname, '../../examples/slow.ts'), 'utf8'),
  };
  for (const [name, text] of Object.entries(inputs)) fs.writeFileSync(path.join(directory, name), text);
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [bin, 'fix', '--handoff', ...args], { cwd: directory, encoding: 'utf8' });
  const result = run('security');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /tls-verification-disabled/);
  assert.match(result.stdout, /connection\.ts:1:/);
  assert.doesNotMatch(result.stdout, /slow\.ts|## perf/);
  for (const mode of ['--yes', '--all']) {
    const fixed = spawnSync(process.execPath, [bin, 'fix', mode, 'security'], {
      cwd: directory,
      encoding: 'utf8',
      env: { ...process.env, LOADWISE_AGENT: '1' },
    });
    assert.equal(fixed.status, 0, fixed.stderr);
    assert.match(fixed.stdout, /For the coding agent running this fix/);
    assert.match(fixed.stdout, /loadwise fix --handoff sec`/);
    assert.doesNotMatch(fixed.stdout, /slow\.ts|--handoff perf/);
  }
  for (const args of [['--yes'], ['--all'], ['--recipe', 'missing.cjs']]) {
    const failed = run(...args);
    assert.equal(failed.status, 2);
    assert.match(failed.stderr, /read-only/);
    assert.equal(failed.stdout, '');
  }
  assert.deepEqual(fs.readdirSync(directory).sort(), Object.keys(inputs).sort());
  for (const [name, text] of Object.entries(inputs))
    assert.equal(fs.readFileSync(path.join(directory, name), 'utf8'), text);
});
