'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { lint, withProgram } = require('./helpers.cjs');

const files = {
  'node_modules/typeorm/index.d.ts':
    'export class Repository<T> { findOne(options: object): Promise<T | null>; findOneBy(where: object): Promise<T | null>; }',
};
const header = `import { Repository } from 'typeorm';
declare const repo: Repository<{ id: number }>;
declare const ids: number[];
declare const kind: number;
`;

function reportedLines(body) {
  const headerLines = header.split('\n').length - 1;
  return lint(header + body, files)
    .filter((finding) => finding.ruleId === 'orm-query-in-loop')
    .map((finding) => finding.line - headerLines);
}

test('a break that leaves a one-item inner loop does not end the outer loop', () => {
  assert.deepEqual(
    reportedLines(`async function load() {
  for (const id of ids) {
    for (const key of [id]) {
      await repo.findOneBy({ id: key });
      break;
    }
  }
}`),
    [4],
  );
});

test('a labelled break that leaves only a one-item inner loop does not end the outer loop', () => {
  assert.deepEqual(
    reportedLines(`async function load() {
  for (const id of ids) {
    inner: for (const key of [id]) {
      await repo.findOneBy({ id: key });
      break inner;
    }
  }
}`),
    [4],
  );
});

test('a break that leaves a switch inside the loop does not end the loop', () => {
  assert.deepEqual(
    reportedLines(`async function load() {
  for (const id of ids) {
    for (const key of [id]) {
      switch (kind) {
        case 1: {
          await repo.findOneBy({ id: key });
          break;
        }
      }
    }
  }
}`),
    [6],
  );
});

test('a break or labelled break out of the scanned loop right after the query stays quiet', () => {
  assert.deepEqual(
    reportedLines(`async function first() {
  for (const id of ids) {
    await repo.findOneBy({ id });
    break;
  }
}
async function firstLabelled() {
  outer: for (const id of ids) {
    for (const key of [id]) {
      await repo.findOneBy({ id: key });
      break outer;
    }
  }
}`),
    [],
  );
});

