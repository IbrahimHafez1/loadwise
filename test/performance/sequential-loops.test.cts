import assert from 'node:assert/strict';
import test from 'node:test';
import { lint } from './helpers.cjs';
import { nativeAvailable, runOnNativeEngine } from './index-rules-fixtures.cjs';
import type { Finding } from '../../lib/shared/types.cjs';
import { lineOf } from '../types/finding-fix.cjs';

const onNativeEngine = process.env.PERF_CHECK_TEST_NATIVE === '1';

const files = {
  'node_modules/typeorm/index.d.ts':
    'export class Repository<T> { findOne(options: object): Promise<T | null>; findOneBy(where: object): Promise<T | null>; }',
};
const header = `import { Repository } from 'typeorm';
declare const repo: Repository<{ id: number; prevId: number; parentId: number }>;
declare const ids: number[];
`;

function reportedLines(body: string) {
  const source = header + body;
  const headerLines = header.split('\n').length - 1;
  return lint(source, files)
    .filter((finding: Finding) => finding.ruleId === 'orm-query-in-loop')
    .map((finding: Finding) => lineOf(finding) - headerLines);
}

test('a cursor assigned from a query that reads the cursor is a chain walk', () => {
  assert.deepEqual(
    reportedLines(`async function walk() {
  let cursor = await repo.findOneBy({ id: 1 });
  while (cursor) {
    cursor = await repo.findOne({ where: { id: cursor.prevId } });
  }
}`),
    [],
  );
});

test('an assignment that never reads its target is still a per-iteration query', () => {
  assert.deepEqual(
    reportedLines(`async function poll() {
  let row = await repo.findOneBy({ id: 1 });
  while (row) {
    row = await repo.findOneBy({ id: 2 });
  }
}`),
    [4],
  );
});

test('a per-item query in a for-of loop stays reported next to a nested chain walk', () => {
  assert.deepEqual(
    reportedLines(`async function ancestors() {
  for (const id of ids) {
    let node = await repo.findOneBy({ id });
    while (node && node.parentId) {
      node = await repo.findOneBy({ id: node.parentId });
    }
  }
}`),
    [3],
  );
});

test('a per-item query inside the walking loop is reported while the walk step is skipped', () => {
  assert.deepEqual(
    reportedLines(`async function audit() {
  for (const id of ids) {
    let node: { parentId: number } | null = { parentId: id };
    do {
      await repo.findOneBy({ id });
      node = await repo.findOneBy({ id: node.parentId });
    } while (node);
  }
}`),
    [5],
  );
});

test('a destructuring with a skipped element does not stop the loop analysis', () => {
  const source = `${header}async function loadRow(id: number): Promise<[number, { id: number } | null, number]> {
  return [id, await repo.findOneBy({ id }), id];
}
export async function run() {
  for (let index = 0; index < ids.length; index++) {
    const [first, , third] = await loadRow(ids[index]);
    console.log(first, third);
  }
}`;
  const findings = lint(source, files).filter((finding: Finding) => finding.ruleId === 'service-query-in-loop');
  assert.equal(findings.length, 1);
});

test('the skipped-element case on the TypeScript 7 engine', { skip: onNativeEngine || !nativeAvailable() }, () => {
  const result = runOnNativeEngine(__filename);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /# pass [1-9]d*/);
});
