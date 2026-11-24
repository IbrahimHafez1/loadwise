import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lint } from './helpers.cjs';
import type { Finding } from '../../lib/shared/types.cjs';

function scan(source: string) {
  return lint('/// <reference lib="es2023.array" />\n' + source).filter(
    (finding: Finding) => finding.ruleId === 'numeric-sort-for-extreme',
  );
}

test('recognizes numeric minima and maxima across ordering, endpoint and fresh copy forms', () => {
  const findings = scan(`export function scores(values: readonly number[]) {
    const minimum = values.toSorted((current, next) => current - next)[0];
    const maximum = [...values].sort((current, next) => current - next).at(-1);
    const high = Array.from(values).sort((current, next) => next - current).at(0);
    return values.toSorted(function (current, next) { return next - current; }).at(-1);
  }`);
  assert.deepEqual(
    findings.map((finding: Finding) => [finding.line, /maximum/.test(finding.message)]),
    [
      [3, false],
      [4, true],
      [5, true],
      [6, false],
    ],
  );
  assert.match(findings[0].message, /empty/);
  assert.match(findings[0].message, /NaN/);
});

test('preserves observable mutations, retained sorting and unused or assigned endpoints', () => {
  const findings = scan(`export function process(values: number[]) {
    const maximum = values.sort((first, second) => second - first)[0];
    const sorted = values.toSorted((first, second) => first - second);
    const second = sorted.at(1);
    values.toSorted((first, second) => first - second)[0] = 0;
    void [...values].sort((first, second) => second - first)[0];
    [...values].sort((first, second) => first - second).at(0);
    return values.slice().sort((first, second) => first - second)[0];
  }`);
  assert.deepEqual(findings, []);
});

test('skips unknown numeric domains, custom methods, complex comparisons and non-endpoint indices', () => {
  const findings = scan(`declare const custom: { toSorted(fn: (first:number,second:number)=>number): number[] };
  export function load(values: number[], unknowns: any[], records: { score: number }[]) {
    const fake = custom.toSorted((first, second) => second - first)[0];
    const untyped = unknowns.toSorted((first: number, second: number) => first - second).at(0);
    const ranking = records.toSorted((first, second) => first.score - second.score)[0];
    const arbitrary = values.toSorted((first, second) => Math.abs(first) - Math.abs(second))[0];
    const tail = values.toSorted((first, second) => second - first).at(-2);
    const defaultSort = values.toSorted()[0];
    const factory = { from: Array.from };
    const customCopy = factory.from(values).sort((first, second) => first - second)[0];
    return [fake, untyped, ranking, arbitrary, tail, defaultSort];
  }`);
  assert.deepEqual(findings, []);
});
