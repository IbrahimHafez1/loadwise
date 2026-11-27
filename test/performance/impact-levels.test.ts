import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { knownRules, impactByRule } from '../../lib/performance/rule-ids.js';
import { impactLevels } from '../../lib/shared/impact-levels.js';

interface ImpactReportFinding {
  ruleId: string;
  impactLevel: string;
}

const bin = path.resolve(import.meta.dirname, '../../bin/loadwise.js');
// Rules that findings carry but --ignore does not accept: traces, plans, cached reads and polyglot
// rules.
const unignorableRules = [
  'duplicate-key-read',
  'repeated-db-span',
  'redis-repeated-read',
  'redis-keys-scan',
  'pg-sequential-scan',
  'pg-disk-sort',
  'pg-deep-offset',
  'mongo-collection-scan',
  'mongo-disk-sort',
  'mongo-deep-skip',
  'csharp-fixed-regex-in-loop',
  'go-fixed-regexp-in-loop',
  'java-fixed-regex-in-loop',
  'rust-fixed-regex-in-loop',
  'python-copy-growing-list',
  'python-sync-requests-in-async',
  'python-blocking-sleep-in-async',
  'python-fixed-regex-in-loop',
  'python-n-plus-one-orm-loop',
  'python-unbounded-comprehension',
  'go-sql-query-in-loop',
  'go-string-concat-in-loop',
  'java-string-concat-in-loop',
  'java-jdbc-query-in-loop',
  'csharp-string-concat-in-loop',
  'rust-clone-in-loop',
  'rust-format-in-loop',
];

test('every performance rule id has a valid impact level', () => {
  const missing = [...knownRules, ...unignorableRules].filter((rule) => !impactLevels.includes(impactByRule[rule]));
  assert.deepEqual(missing, []);
});

test('the impact table names no rule that does not exist', () => {
  const known = new Set([...knownRules, ...unignorableRules]);
  assert.deepEqual(
    Object.keys(impactByRule).filter((rule) => !known.has(rule)),
    [],
  );
});

test('the README lists the impact level of every performance rule', () => {
  const readme = fs.readFileSync(path.resolve(import.meta.dirname, '../../README.md'), 'utf8');
  const wrong = Object.entries(impactByRule).filter(
    ([rule, level]) => !new RegExp(['\\|\\s*`', rule, '`\\s*\\|\\s*', level, '\\s*\\|'].join('')).test(readme),
  );
  assert.deepEqual(wrong, []);
});

function project(context: TestContext) {
  const base = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Temp', 'AI-Work') : os.tmpdir();
  fs.mkdirSync(base, { recursive: true });
  const directory = fs.mkdtempSync(path.join(base, 'loadwise-impact-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.mkdirSync(path.join(directory, 'node_modules', 'pg'), { recursive: true });
  const files = {
    'node_modules/pg/index.d.ts': 'export class Pool { query(sql: string): Promise<unknown> }',
    // The medium finding comes first in the file, so sorting must move the critical one above it.
    'service.ts': [
      "import { Pool } from 'pg';",
      "import { readFileSync } from 'node:fs';",
      'export async function read() {',
      "  readFileSync('example');",
      '}',
      'export function handle() {',
      '  for (const id of [1, 2]) new Pool();',
      '}',
    ].join('\n'),
  };
  for (const [name, contents] of Object.entries(files)) fs.writeFileSync(path.join(directory, name), contents);
  return (...args: string[]) =>
    spawnSync(process.execPath, [bin, 'perf', 'service.ts', ...args], { cwd: directory, encoding: 'utf8' });
}

test('JSON findings carry impactLevel and text output shows it, most severe first', (context) => {
  const run = project(context);
  const json = JSON.parse(run('--json').stdout);
  assert.deepEqual(
    json.findings.map(({ ruleId, impactLevel }: ImpactReportFinding) => [ruleId, impactLevel]),
    [
      ['pool-created-per-request-or-item', 'critical'],
      ['node-sync-fs-in-async', 'medium'],
    ],
  );
  const labelled = run()
    .stdout.split('\n')
    .filter((line) => /\[[a-z-]+ #[0-9a-f]+\]/.test(line));
  assert.match(labelled[0], /\[pool-created-per-request-or-item #[0-9a-f]+\] critical: /);
  assert.match(labelled[1], /\[node-sync-fs-in-async #[0-9a-f]+\] medium: /);
});

test('--min-impact drops lower findings from output and from the exit code', (context) => {
  const run = project(context);
  const critical = JSON.parse(run('--json', '--min-impact', 'critical').stdout);
  assert.deepEqual(
    critical.findings.map(({ ruleId }: ImpactReportFinding) => ruleId),
    ['pool-created-per-request-or-item'],
  );
  assert.equal(run('--min-impact', 'critical').status, 1);
  assert.equal(run('--ignore', 'pool-created-per-request-or-item', '--min-impact', 'high').status, 0);
  assert.equal(run('--ignore', 'pool-created-per-request-or-item', '--min-impact', 'medium').status, 1);
});

test('an invalid --min-impact level exits 2', (context) => {
  const run = project(context);
  const result = run('--min-impact', 'severe');
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--min-impact must be one of low, medium, high, critical/);
});
