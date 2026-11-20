'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { lint } = require('./helpers.cjs');

const declarations = `
declare function left(): Promise<string>;
declare function right(): PromiseLike<number>;
declare const jobs: { lookup(key: string): Promise<number>; refresh(): Promise<void> };
`;

test('reports confirmed awaited calls in native Promise.all and warns about changed failure behavior', () => {
  const findings = lint(declarations + `
async function run(key: string) {
  return Promise.all([await left(), (await jobs.lookup(key)), await right()]);
}
`);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].ruleId, 'promise-combinator-serial-await');
  assert.match(findings[0].message, /earlier call rejects/);
});

test('allSettled explains that a rejection currently prevents the combinator from running', () => {
  const findings = lint(declarations + `
async function run() {
  return Promise.allSettled([await jobs.refresh(), await left()]);
}
`);
  assert.equal(findings.length, 1);
  assert.match(findings[0].message, /rejected entries/);
});

test('skips ambient lookalikes, shadowed globals, getters, prior work and uncertain evaluation order', () => {
  const findings = lint(declarations + `
declare function unknownResult(): any;
declare function synchronous(): number;
declare const store: { get job(): () => Promise<string> };
async function custom(Promise: PromiseConstructor) {
  return Promise.all([await left(), await right()]);
}
async function examples() {
  const started = left();
  const array = [left(), right()];
  await Promise.all([await started, await right()]);
  await Promise.all([left(), right()]);
  await Promise.all([await left(), started]);
  await Promise.all([await left(), 1]);
  await Promise.all([await left()]);
  await Promise.all([...array, await left(), await right()]);
  await Promise.all([await left(), await store.job()]);
  await Promise.all([await left(), await unknownResult()]);
  await Promise.all([await left(), await synchronous()]);
  await Promise.all([await left(), await jobs.lookup(await left())]);
  await Promise.all([await Promise.resolve('ready'), await right()]);
  await Promise.race([await left(), await right()]);
  await left();
  await right();
}
`);
  assert.deepEqual(findings, []);
});
