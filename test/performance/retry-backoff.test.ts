import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lint } from './helpers.js';
import type { Finding } from '../../lib/shared/types.js';

const files = {
  'node_modules/axios-retry/index.d.ts': `
    declare function axiosRetry(client: object, options?: { retries?: number; retryDelay?: (count: number) => number }): void;
    declare namespace axiosRetry { function exponentialDelay(count: number): number }
    export default axiosRetry;
  `,
  'node_modules/got/index.d.ts': `declare const got: { get(url: string): Promise<string> }; export default got;`,
};

function check(source: string) {
  return lint(source, files).filter((finding: Finding) => finding.ruleId === 'retry-without-backoff');
}

test('reports a fetch retried in a counted loop with no wait', () => {
  const findings = check(
    [
      'export async function load(url: string) {',
      '  for (let attempt = 0; attempt < 3; attempt++) {',
      '    try {',
      '      return await fetch(url);',
      '    } catch {',
      '      continue;',
      '    }',
      '  }',
      '}',
    ].join('\n'),
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].contextualReason, undefined);
  assert.match(findings[0].message, /backoff with jitter/);
});

test('reports while (true) and a decrementing counter, and a got call', () => {
  const findings = check(
    [
      "import got from 'got';",
      'export async function a(url: string) {',
      '  while (true) { try { return await fetch(url); } catch (error) { console.warn(error); } }',
      '}',
      'export async function b(url: string) {',
      '  let retries = 3;',
      '  while (retries-- > 0) { try { return await got.get(url); } catch {} }',
      '}',
    ].join('\n'),
  );
  assert.equal(findings.length, 2);
});

test('ignores a loop that waits, including a custom sleep and a timers promise', () => {
  const findings = check(
    [
      "import { setTimeout as pause } from 'node:timers/promises';",
      'declare function sleep(ms: number): Promise<void>;',
      'export async function a(url: string) {',
      '  for (let attempt = 0; attempt < 3; attempt++) {',
      '    try { return await fetch(url); } catch { await sleep(2 ** attempt * 100); }',
      '  }',
      '}',
      'export async function b(url: string) {',
      '  for (let attempt = 0; attempt < 3; attempt++) {',
      '    try { return await fetch(url); } catch { await new Promise((resolve) => setTimeout(resolve, 100)); }',
      '  }',
      '}',
      'export async function c(url: string) {',
      '  for (let attempt = 0; attempt < 3; attempt++) {',
      '    try { return await fetch(url); } catch { await pause(100); }',
      '  }',
      '}',
    ].join('\n'),
  );
  assert.equal(findings.length, 0);
});

test('ignores a loop over items, a call outside try and an unrelated while loop', () => {
  const findings = check(
    [
      'export async function a(urls: string[]) {',
      '  const results = [];',
      '  for (const url of urls) { try { results.push(await fetch(url)); } catch {} }',
      '  for (let index = 0; index < urls.length; index++) { await fetch(urls[index]); }',
      '  const queue = [...urls];',
      '  while (queue.length) { try { return await fetch(queue.pop()!); } catch {} }',
      '  return results;',
      '}',
    ].join('\n'),
  );
  assert.equal(findings.length, 0);
});

test('reports axios-retry without retryDelay as contextual', () => {
  const findings = check(
    [
      "import axiosRetry from 'axios-retry';",
      'declare const client: object;',
      'axiosRetry(client, { retries: 3 });',
      'axiosRetry(client);',
      'axiosRetry(client, { retries: 3, retryDelay: axiosRetry.exponentialDelay });',
    ].join('\n'),
  );
  assert.equal(findings.length, 2);
  assert.ok(findings.every((finding: Finding) => finding.contextualReason));
});
