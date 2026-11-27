import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import type { FileMap } from '../types/project-files.js';

const bin = path.resolve(import.meta.dirname, '../../bin/loadwise.js');
const tsconfig = JSON.stringify({ compilerOptions: { strict: true, types: [] }, include: ['*.ts'] });
const dynamicQuery = [
  "import type { Pool } from 'pg';",
  'export const load = (pool: Pool, table: string) => pool.query(`SELECT * FROM ${table}`);',
].join('\n');

function project(context: TestContext, files: FileMap) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loadwise-sec-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const all = {
    'tsconfig.json': tsconfig,
    'node_modules/@types/pg/index.d.ts': 'export class Pool { query(text: string): Promise<unknown> }',
    ...files,
  };
  for (const [name, text] of Object.entries(all)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), text);
  }
  return root;
}

function sec(root: string, ...args: string[]) {
  const run = spawnSync(process.execPath, [bin, 'sec', ...args], { cwd: root, encoding: 'utf8', windowsHide: true });
  return { code: run.status, stdout: run.stdout, stderr: run.stderr };
}

test('a security finding exits 1 with an id, an example and a fix command for sec', (context) => {
  const root = project(context, { 'query.ts': dynamicQuery });
  const text = sec(root);
  assert.equal(text.code, 1, text.stderr);
  assert.match(text.stdout, /^query\.ts:2:\d+ \[pg-dynamic-query-text #[0-9a-f]{12}\] /);
  assert.match(text.stdout, /1 file\(s\) checked, 1 finding\(s\)\.\n$/);
  const report = JSON.parse(sec(root, '--json').stdout);
  assert.deepEqual(Object.keys(report), ['scannedFiles', 'findings']);
  const [finding] = report.findings;
  assert.equal(finding.ruleId, 'pg-dynamic-query-text');
  assert.equal(finding.example.language, 'typescript');
  assert.equal(finding.pillar, undefined);
});

test('--ignore takes security and performance ids, --fail-on contract passes and bad input exits 2', (context) => {
  const root = project(context, { 'query.ts': dynamicQuery });
  assert.equal(sec(root, '--ignore', 'pg-dynamic-query-text').code, 0);
  assert.equal(sec(root, '--ignore', 'array-repeated-find').code, 1);
  assert.equal(sec(root, '--fail-on', 'contract').code, 0);
  const unknown = sec(root, '--ignore', 'sql-everything');
  assert.equal(unknown.code, 2);
  assert.equal(unknown.stderr, 'Unknown source rule: sql-everything\n');
  assert.equal(sec(root, '--engine', 'turbo').code, 2);
  assert.equal(sec(root, '--policy', 'missing.json').code, 2);
});

test('a reviewed comment moves the finding to the contextual count', (context) => {
  const reviewed = dynamicQuery.replace(
    'export const',
    '// loadwise-reviewed pg-dynamic-query-text -- the table comes from a fixed enum\nexport const',
  );
  const root = project(context, { 'query.ts': reviewed });
  const run = sec(root);
  assert.equal(run.code, 0, run.stderr);
  assert.match(run.stdout, /1 contextual finding\(s\) available with --include-contextual\./);
});

test('perf no longer reports the moved rules and still accepts them in --ignore', (context) => {
  const root = project(context, { 'query.ts': dynamicQuery });
  const run = spawnSync(
    process.execPath,
    [bin, 'perf', '--json', '--ignore', 'prisma-scope-unverified', '--ignore', 'sql-select-star-in-query'],
    {
      cwd: root,
      encoding: 'utf8',
    },
  );
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout).findings, []);
});

test('--help lists the flags', () => {
  const run = sec(os.tmpdir(), '--help');
  assert.equal(run.code, 0);
  assert.match(run.stdout, /^Usage:\n {2}loadwise sec /);
});
