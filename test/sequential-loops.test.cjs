'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { lint } = require('./helpers.cjs');

const files = {
  'node_modules/typeorm/index.d.ts':
    'export class Repository<T> { findOne(options: object): Promise<T | null>; findOneBy(where: object): Promise<T | null>; }',
};
const header = `import { Repository } from 'typeorm';
declare const repo: Repository<{ id: number; prevId: number; parentId: number }>;
declare const ids: number[];
`;

function reportedLines(body) {
  const source = header + body;
  const headerLines = header.split('\n').length - 1;
  return lint(source, files)
    .filter((finding) => finding.ruleId === 'orm-query-in-loop')
    .map((finding) => finding.line - headerLines);
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

