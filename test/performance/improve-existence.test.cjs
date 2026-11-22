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

const transactionFiles = {
  'globals.d.ts': `declare function fetch(url: string): Promise<{ ok: boolean }>;
declare function setImmediate(callback: () => unknown): unknown;
declare function setTimeout(callback: () => unknown, delay?: number): unknown;
declare function setInterval(callback: () => unknown, delay?: number): unknown;
declare function queueMicrotask(callback: () => unknown): void;
declare const process: { nextTick(callback: () => unknown): void };`,
  'node_modules/@prisma/client/index.d.ts': `
    export class PrismaClient { user: { create(input: object): Promise<unknown> };
      $transaction<T>(run: (tx: PrismaClient) => Promise<T>): Promise<T> }
  `,
};

function transactionFindings(body) {
  const source = `import { PrismaClient } from '@prisma/client';
declare const prisma: PrismaClient;
declare const urls: string[];
export async function run() {
  await prisma.$transaction(async (tx) => {
    await tx.user.create({});
${body}
  });
}`;
  return rule(lint(source, transactionFiles), 'external-call-in-transaction');
}

test('I/O inside a callback deferred by a timer or microtask scheduler is outside the transaction', () => {
  const findings = transactionFindings(`
    setImmediate(async () => await fetch('https://example.test'));
    setTimeout(async () => { await fetch('https://example.test'); }, 10);
    setInterval(async () => { await fetch('https://example.test'); }, 10);
    process.nextTick(async () => { await fetch('https://example.test'); });
    queueMicrotask(async () => { await fetch('https://example.test'); });`);
  assert.deepEqual(findings, []);
});

test('I/O awaited directly or through Promise.all over map in a transaction is still reported', () => {
  const findings = transactionFindings(`
    await fetch('https://example.test');
    await Promise.all(urls.map(async (url) => await fetch(url)));`);
  assert.equal(findings.length, 2);
});

test('a local function named like a scheduler still runs its callback inside the transaction', () => {
  const findings = transactionFindings(`
    const setImmediate = async (callback: () => Promise<unknown>) => callback();
    await setImmediate(async () => await fetch('https://example.test'));`);
  assert.equal(findings.length, 1);
});

const floatingHeader = `declare function sendEmail(to: string): Promise<void>;
declare function log(error: unknown): void;
`;

function floatingFindings(body) {
  return rule(lint(floatingHeader + body), 'floating-promise');
}

test('a background helper that contains its own failures is contextual', () => {
  const findings = floatingFindings(`
async function notifyQuietly(to: string) {
  try {
    await sendEmail(to);
  } catch (error) {
    log(error);
  }
}
const notifyLater = (to: string) => sendEmail(to).catch((error) => log(error));
function notifyWithHandler(to: string) {
  return sendEmail(to).catch(log);
}
export async function signup(email: string) {
  notifyQuietly(email);
  notifyLater(email);
  notifyWithHandler(email);
}`);
  assert.equal(findings.length, 3);
  for (const finding of findings) assert.match(finding.contextualReason ?? '', /own failures/);
});

test('helpers that rethrow, leak a returned promise or are unknown stay default findings', () => {
  const findings = floatingFindings(`
declare function unknownHelper(to: string): Promise<void>;
async function rethrows(to: string) {
  try {
    await sendEmail(to);
  } catch (error) {
    log(error);
    throw error;
  }
}
async function returnsUnawaited(to: string) {
  try {
    return sendEmail(to);
  } catch (error) {
    log(error);
  }
}
async function partlyGuarded(to: string) {
  await sendEmail(to);
  try {
    await sendEmail(to);
  } catch {}
}
const rejectsAgain = (to: string) => sendEmail(to).catch((error) => Promise.reject(error));
const throwsAgain = (to: string) => sendEmail(to).catch((error) => { throw error; });
const handledThenRisky = (to: string) => sendEmail(to).catch(log).then(() => sendEmail(to));
export async function signup(email: string) {
  unknownHelper(email);
  rethrows(email);
  returnsUnawaited(email);
  partlyGuarded(email);
  rejectsAgain(email);
  throwsAgain(email);
  handledThenRisky(email);
}`);
  assert.equal(findings.length, 7);
  for (const finding of findings) assert.equal(finding.contextualReason, undefined);
});
