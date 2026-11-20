'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawnSync } = require('node:child_process');
const { assignFindingIds } = require('../../lib/performance/finding-ids.cjs');

const bin = path.resolve(__dirname, '../../bin/loadwise.cjs');
const example = fs.readFileSync(path.resolve(__dirname, '../../examples/slow.ts'), 'utf8');

function tempRoot(context) {
  const base = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Temp', 'AI-Work') : os.tmpdir();
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, 'backend-perf-agent-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  // A package.json makes this folder the project root that ids are relative to.
  fs.writeFileSync(path.join(root, 'package.json'), '{}');
  return root;
}

function project(context) {
  const root = tempRoot(context);
  fs.writeFileSync(path.join(root, 'slow.ts'), example);
  const run = (args) => spawnSync(process.execPath, [bin, 'perf', ...args], { cwd: root, encoding: 'utf8' });
  const scan = () => JSON.parse(run(['slow.ts', '--json', '--engine', 'js']).stdout).findings;
  return { root, run, scan };
}

test('ids survive a line inserted above the finding', (context) => {
  const { root, scan } = project(context);
  const before = scan();
  fs.writeFileSync(path.join(root, 'slow.ts'), '// a new comment\n' + example);
  const after = scan();
  assert.equal(after.length, before.length);
  assert.notEqual(after[0].line, before[0].line);
  assert.deepEqual(
    after.map(({ id }) => id),
    before.map(({ id }) => id),
  );
  for (const { id } of before) assert.match(id, /^[0-9a-f]{12}$/);
});

test('identical findings on identical lines get numbered suffixes in order', (context) => {
  const root = tempRoot(context);
  fs.writeFileSync(path.join(root, 'same.ts'), 'call();\ncall();\ncall();\n');
  const findings = [1, 2, 3].map((line) => ({ file: path.join(root, 'same.ts'), line, ruleId: 'some-rule' }));
  const [first, second, third] = assignFindingIds(findings, root).map(({ id }) => id);
  assert.equal(second, first + '-2');
  assert.equal(third, first + '-3');
  const [table] = assignFindingIds([{ ruleId: 'some-rule', target: 'public.orders' }], root);
  assert.match(table.id, /^[0-9a-f]{12}$/);
});

test('JSON findings carry the fix and whether they are fixable', (context) => {
  const { scan } = project(context);
  for (const finding of scan()) {
    assert.equal(finding.fixable, true);
    assert.ok(finding.fix.changes[0].after);
  }
});

test('--fix --only applies just the listed fix without a terminal', (context) => {
  const { run, scan } = project(context);
  const [chosen, ...others] = scan();
  const result = run(['slow.ts', '--fix', '--only', chosen.id, '--json', '--engine', 'js']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { applied: [chosen.id], alreadyApplied: [], failed: [] });
  assert.deepEqual(
    scan().map(({ id }) => id),
    others.map(({ id }) => id),
  );
});

test('--fix --only reports an unknown id and exits 2', (context) => {
  const { run, scan } = project(context);
  const [chosen] = scan();
  const result = run(['slow.ts', '--fix', '--only', `${chosen.id},000000000000`, '--json', '--engine', 'js']);
  assert.equal(result.status, 2, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    applied: [chosen.id],
    alreadyApplied: [],
    failed: [{ id: '000000000000', reason: 'unknown id' }],
  });
});

test('--fix --only treats a change made by an earlier id in the run as success', (context) => {
  const root = tempRoot(context);
  fs.writeFileSync(
    path.join(root, 'shared.ts'),
    [
      'export function pick(orders: { a: number; b: number }[], request: { body: { allowed: number[] } }) {',
      '  const allowed = request.body.allowed;',
      '  return orders.filter(order => allowed.includes(order.a) || allowed.includes(order.b));',
      '}',
      '',
    ].join('\n'),
  );
  const run = (args) =>
    spawnSync(process.execPath, [bin, 'perf', 'shared.ts', '--engine', 'js', ...args], { cwd: root, encoding: 'utf8' });
  const ids = JSON.parse(run(['--json']).stdout).findings.map(({ id }) => id);
  assert.deepEqual(ids, [ids[0], ids[0] + '-2']);
  const result = run(['--fix', '--only', ids.join(','), '--json']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    applied: [ids[0]],
    alreadyApplied: [{ id: ids[1], status: 'already applied' }],
    failed: [],
  });
});

test('migration findings carry ids in JSON and text', (context) => {
  const root = tempRoot(context);
  const migration = path.join(root, 'migrations', '001_drop.sql');
  fs.mkdirSync(path.dirname(migration));
  fs.writeFileSync(migration, "SET lock_timeout = '5s';\nALTER TABLE orders DROP COLUMN legacy;\n");
  const run = (args) =>
    spawnSync(process.execPath, [bin, 'perf', 'migrations', migration, '--dialect', 'postgres', ...args], {
      cwd: root,
      encoding: 'utf8',
    });
  const [finding] = JSON.parse(run(['--json']).stdout).findings;
  assert.match(finding.id, /^[0-9a-f]{12}$/);
  assert.ok(run([]).stdout.includes(`[${finding.ruleId} #${finding.id}]`));
});
