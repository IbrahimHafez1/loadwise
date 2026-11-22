'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { lint } = require('./helpers.cjs');

function rule(findings, ruleId) {
  return findings.filter((finding) => finding.ruleId === ruleId);
}

test('filter length compared with one or wrapped in Boolean() is an existence check', () => {
  const tests = [
    'rows.filter(row => row > 0).length >= 1',
    'rows.filter(row => row > 0).length < 1',
    '1 <= rows.filter(row => row > 0).length',
    '1 > rows.filter(row => row > 0).length',
    'Boolean(rows.filter(row => row > 0).length)',
    '!!rows.filter(row => row > 0).length',
  ];
  const findings = rule(
    lint(`export function check(rows: number[]) { return [${tests.join(', ')}]; }`),
    'filter-for-existence',
  );
  assert.deepEqual(
    findings.map((finding) => finding.message.match(/`(!?some\(\))`/)[1]),
    ['some()', '!some()', 'some()', '!some()', 'some()', 'some()'],
  );
});

test('filter length compared with one as a count threshold, or a shadowed Boolean, stays quiet', () => {
  const tests = [
    'rows.filter(row => row > 0).length > 1',
    'rows.filter(row => row > 0).length <= 1',
    'rows.filter(row => row > 0).length === 1',
    '1 < rows.filter(row => row > 0).length',
    '1 >= rows.filter(row => row > 0).length',
    'Number(rows.filter(row => row > 0).length)',
  ];
  const source = `function Boolean(value: number) { return value; }
export function check(rows: number[]) { return [${tests.join(', ')}, Boolean(rows.filter(row => row > 0).length)]; }`;
  assert.deepEqual(rule(lint(source), 'filter-for-existence'), []);
});

const prismaFiles = {
  'node_modules/@prisma/client/index.d.ts': `
export interface StoreDelegate {
  count(args?: object): Promise<number>;
}
export declare class PrismaClient { store: StoreDelegate }
`,
};
const prismaHeader = `import { PrismaClient } from '@prisma/client';
declare const prisma: PrismaClient;
declare const where: { slug: string };
`;

test('Prisma count compared loosely with zero is an existence check', () => {
  const comparisons = [
    '(await prisma.store.count({ where })) == 0',
    '(await prisma.store.count({ where })) != 0',
    '0 == (await prisma.store.count({ where }))',
    '(await prisma.store.count({ where })) < 1',
    '0 < (await prisma.store.count({ where }))',
  ];
  const source = `${prismaHeader}export async function exists() { return [${comparisons.join(', ')}]; }`;
  assert.equal(rule(lint(source, prismaFiles), 'prisma-count-for-existence').length, comparisons.length);
});

test('Prisma count compared loosely with other values stays quiet', () => {
  const comparisons = [
    '(await prisma.store.count({ where })) == 1',
    '(await prisma.store.count({ where })) != 2',
    '1 != (await prisma.store.count({ where }))',
  ];
  const source = `${prismaHeader}export async function exists() { return [${comparisons.join(', ')}]; }`;
  assert.deepEqual(rule(lint(source, prismaFiles), 'prisma-count-for-existence'), []);
});
