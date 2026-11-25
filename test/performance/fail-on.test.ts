import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

interface ThresholdCase {
  threshold: string;
  ignored: string[];
  status: number;
  expected: string[];
}

interface UsageErrorCase {
  args: string[];
  error: RegExp;
}

interface ThresholdReport {
  findings: { ruleId: string }[];
  contractFindingCount?: number;
}

const bin = path.resolve(import.meta.dirname, '../../bin/loadwise.js');

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
  function run(args: string[]) {
    return spawnSync(process.execPath, [bin, 'perf', ...args], { cwd: directory, encoding: 'utf8' });
  }
  const sourceArgs = ['service.ts', '--json'];
  const transaction = 'pg-transaction-on-pool',
    advisory = 'node-sync-fs-in-async';
  const thresholdCases: ThresholdCase[] = [
    { threshold: 'all', ignored: [], status: 1, expected: [transaction, advisory] },
    { threshold: 'contract', ignored: [], status: 1, expected: [transaction, advisory] },
    { threshold: 'contract', ignored: [transaction], status: 0, expected: [advisory] },
    { threshold: 'all', ignored: [transaction], status: 1, expected: [advisory] },
    { threshold: 'all', ignored: [transaction, advisory], status: 0, expected: [] },
  ];
  for (const { threshold, ignored, status, expected } of thresholdCases) {
    const result = run([...sourceArgs, '--fail-on', threshold, ...ignored.flatMap((rule) => ['--ignore', rule])]);
    assert.equal(result.status, status, result.stderr);
    const report: ThresholdReport = JSON.parse(result.stdout);
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
  const usageErrorCases: UsageErrorCase[] = [
    { args: ['service.ts', '--fail-on', 'other'], error: /--fail-on/ },
    { args: ['service.ts', '--fail-on', 'contract', '--policy', 'invalid.json'], error: /query policy|prismaScopes/i },
    { args: ['service.ts', '--fail-on', 'contract', '--ignore', 'missing-rule'], error: /Unknown source rule/ },
    { args: ['traces', 'example.json', '--fail-on', 'contract'], error: /--fail-on/ },
  ];
  for (const { args, error } of usageErrorCases) {
    const result = run(args);
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, error);
  }
});
