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

test('fix commands reuse the JS engine when auto falls back on a removed compiler option', (context) => {
  const { root, run } = project(context);
  fs.writeFileSync(
    path.join(root, 'tsconfig.json'),
    '{"compilerOptions":{"moduleResolution":"node10"},"files":["slow.ts"]}',
  );
  const report = run(['-p', 'tsconfig.json']);
  assert.equal(report.status, 1, report.stderr);
  const command = report.stdout.match(/^Fix all: npx loadwise perf (.+)$/m)?.[1];
  assert.match(command ?? '', /--engine js --fix --only /);
  const fixed = run(command.split(' '));
  assert.equal(fixed.status, 0, fixed.stdout + fixed.stderr);
  assert.doesNotMatch(fixed.stderr, /cannot load this project/);
});

test('the suggested lookup fix preserves strict equality and first-match results', (context) => {
  const { root, run, scan } = project(context);
  const { transpileModule, ModuleKind } = require('typescript');
  const names = (moduleName) => {
    const source = fs.readFileSync(path.join(root, 'slow.ts'), 'utf8');
    const filename = path.join(root, moduleName);
    fs.writeFileSync(
      filename,
      transpileModule(source, { compilerOptions: { module: ModuleKind.CommonJS } }).outputText,
    );
    const ids = [NaN, -0, 7, 99];
    const customers = [
      { id: NaN, name: 'unmatchable' },
      { id: 0, name: 'zero' },
      { id: 7, name: 'first' },
      { id: 7, name: 'duplicate' },
    ];
    return require(filename).visibleNames(
      ids.map((customerId) => ({ customerId })),
      customers,
      { body: { allowed: ids } },
    );
  };
  const before = names('original.cjs');
  assert.deepEqual(before, ['Unknown', 'zero', 'first', 'Unknown']);
  const lookup = scan().find(({ ruleId }) => ruleId === 'array-repeated-find');
  const result = run(['slow.ts', '--fix', '--only', lookup.id]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(names('fixed.cjs'), before);
});

test('a printed command reruns the same scan when its file and policy paths contain shell characters', (context) => {
  const { root, run } = project(context);
  const filename = "customer's $orders & team’s history.ts";
  fs.renameSync(path.join(root, 'slow.ts'), path.join(root, filename));
  fs.writeFileSync(
    path.join(root, 'review policy.json'),
    '{"parallelReads":[{"from":"app/reads","exports":["readA","readB"]}]}',
  );
  fs.writeFileSync(path.join(root, 'custom config.json'), '{}');
  fs.writeFileSync(path.join(root, 'schema.json'), JSON.stringify({ version: 1, dialect: 'postgres', tables: {} }));
  const inputs = [
    filename,
    '--policy',
    'review policy.json',
    '--loadwise-config',
    'custom config.json',
    '--schema',
    'schema.json',
    '--engine',
    'js',
  ];
  const report = run(inputs);
  assert.equal(report.status, 1, report.stderr);
  const command = report.stdout.match(/^Fix all: npx loadwise (.+)$/m)?.[1];
  assert.ok(command, report.stdout);
  for (const option of ['--policy', '--loadwise-config', '--schema', '--engine js'])
    assert.ok(command.includes(option));
  const windows = process.platform === 'win32';
  const shell = windows ? 'powershell.exe' : '/bin/sh';
  const shellArgs = windows
    ? [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '& $env:LOADWISE_TEST_NODE $env:LOADWISE_TEST_CLI ' + command + '\nexit $LASTEXITCODE',
      ]
    : ['-c', '"$LOADWISE_TEST_NODE" "$LOADWISE_TEST_CLI" ' + command];
  const fixed = spawnSync(shell, shellArgs, {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, LOADWISE_TEST_NODE: process.execPath, LOADWISE_TEST_CLI: bin },
  });
  assert.equal(fixed.status, 0, fixed.stderr);
  assert.equal(run(inputs).status, 0);
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

test('Prisma schema findings from a workspace scan can be fixed and rescanned in that workspace', (context) => {
  const root = tempRoot(context);
  fs.writeFileSync(path.join(root, 'package.json'), '{"workspaces":["packages/*"]}');
  const schemaFixture = path.join(__dirname, 'fixtures/schema/prisma-shop/prisma/schema.prisma');
  for (const name of ['alpha', 'beta']) {
    const directory = path.join(root, 'packages', name);
    fs.mkdirSync(path.join(directory, 'prisma'), { recursive: true });
    fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ name }));
    fs.writeFileSync(path.join(directory, 'tsconfig.json'), '{"files":["index.ts"]}');
    fs.writeFileSync(path.join(directory, 'index.ts'), 'export const value = 1;');
    fs.copyFileSync(schemaFixture, path.join(directory, 'prisma/schema.prisma'));
  }
  const alpha = path.join(root, 'packages/alpha');
  const run = (cwd, ...args) => spawnSync(process.execPath, [bin, ...args], { cwd, encoding: 'utf8' });
  const scan = (cwd, ...args) => {
    const result = run(cwd, ...args, '--json');
    assert.ok([0, 1].includes(result.status), result.stderr);
    return JSON.parse(result.stdout);
  };
  const selection = ['-p', '.', '--workspace', 'alpha'];
  const combined = scan(root, 'check', '--only', 'perf,sec', '--workspace', 'alpha').performance;
  assert.equal(combined.findings.length, 1);
  const [finding] = combined.findings;
  assert.equal(finding.ruleId, 'index-missing-foreign-key');
  assert.ok(finding.fixable);
  assert.equal(scan(alpha, 'perf').findings.length, 1);
  assert.equal(scan(root, 'perf', ...selection).findings[0]?.id, finding.id);
  const fixed = run(root, 'perf', ...selection, '--fix', '--only', finding.id);
  assert.equal(fixed.status, 0, fixed.stdout + fixed.stderr);
  assert.equal(scan(alpha, 'perf').findings.length, 0);
  assert.equal(scan(root, 'perf', '--workspace', 'beta').findings.length, 1);
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
