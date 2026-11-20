'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawnSync } = require('node:child_process');

const bin = path.join(__dirname, '../../bin/warden-backend.cjs');

test('a one-shot scan loads the SQL parser, so raw SQL index rules report', (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'backend-perf-raw-sql-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const files = {
    'node_modules/pg/package.json': '{ "name": "pg", "types": "index.d.ts" }',
    'node_modules/pg/index.d.ts':
      'export declare class Pool { query(text: string, values?: unknown[]): Promise<unknown>; }',
    'query.ts':
      "import { Pool } from 'pg';\ndeclare const pool: Pool;\n" +
      "export async function find(email: string) {\n  await pool.query('SELECT * FROM customers WHERE lower(email) = $1', [email]);\n}\n",
  };
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), content);
  }
  const checked = spawnSync(process.execPath, [bin, '--engine', 'js', '--json', path.join(root, 'query.ts')], {
    encoding: 'utf8',
  });
  assert.equal(checked.status, 1, checked.stderr);
  assert.deepEqual(
    JSON.parse(checked.stdout).findings.map(({ line, ruleId }) => [line, ruleId]),
    [[4, 'index-unusable-expression']],
  );
});
