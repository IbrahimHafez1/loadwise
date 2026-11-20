'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const bin = path.resolve(__dirname, '../../bin/loadwise.cjs');

test('source fail-on thresholds apply after ignores while JSON keeps all remaining findings', (context) => {
  const base = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Temp', 'AI-Work') : os.tmpdir();
  fs.mkdirSync(base, { recursive: true });
  const directory = fs.mkdtempSync(path.join(base, 'backend-perf-threshold-'));
  const pgDirectory = path.join(directory, 'node_modules', 'pg');
  fs.mkdirSync(pgDirectory, { recursive: true });
  const files = {
    'node_modules/pg/index.d.ts': 'export class Pool { query(sql: string): Promise<unknown> }',
    'service.ts': [
      "import { Pool } from 'pg';",
      "import { readFileSync } from 'node:fs';",
      'const pool = new Pool();',
      'export async function handle() {',
      "  await pool.query('BEGIN');",
      "  readFileSync('example');",
      '}',
    ].join('\n'),
    'invalid.json': JSON.stringify({ prismaScopes: {} }),
  };
  for (const [name, contents] of Object.entries(files)) fs.writeFileSync(path.join(directory, name), contents);
  context.after(() => {
    for (const name of Object.keys(files)) fs.unlinkSync(path.join(directory, name));
    for (const target of [pgDirectory, path.dirname(pgDirectory), directory]) fs.rmdirSync(target);
  });
  function run(args) {
    return spawnSync(process.execPath, [bin, 'perf', ...args], { cwd: directory, encoding: 'utf8' });
  }
  const sourceArgs = ['service.ts', '--json'];
  const transaction = 'pg-transaction-on-pool',
    advisory = 'node-sync-fs-in-async';
  for (const [threshold, ignored, status, expected] of [
    ['all', [], 1, [transaction, advisory]],
    ['contract', [], 1, [transaction, advisory]],
    ['contract', [transaction], 0, [advisory]],
    ['all', [transaction], 1, [advisory]],
    ['all', [transaction, advisory], 0, []],
  ]) {
    const result = run([...sourceArgs, '--fail-on', threshold, ...ignored.flatMap((rule) => ['--ignore', rule])]);
    assert.equal(result.status, status, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.deepEqual(
      report.findings.map(({ ruleId }) => ruleId),
      expected,
    );
    if (threshold === 'contract') {
      assert.equal(report.contractFindingCount, expected.filter((rule) => rule === transaction).length);
    } else assert.equal(Object.hasOwn(report, 'contractFindingCount'), false);
  }
  const textReport = run(['service.ts', '--fail-on', 'contract']);
  assert.equal(textReport.status, 1, textReport.stderr);
  assert.match(textReport.stdout, /2 finding\(s\), 1 enforced by --fail-on contract/);
  for (const [args, error] of [
    [['service.ts', '--fail-on', 'other'], /--fail-on/],
    [['service.ts', '--fail-on', 'contract', '--policy', 'invalid.json'], /query policy|prismaScopes/i],
    [['service.ts', '--fail-on', 'contract', '--ignore', 'missing-rule'], /Unknown source rule/],
    [['traces', 'example.json', '--fail-on', 'contract'], /--fail-on/],
  ]) {
    const result = run(args);
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, error);
  }
});
