'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { lint } = require('./helpers.cjs');

function classified(source, ruleId) {
  return lint(source)
    .filter((finding) => finding.ruleId === ruleId)
    .map(({ line, contextualReason }) => [line, Boolean(contextualReason)]);
}

test('sync fs in a startup function is contextual while a request-time function stays a finding', () => {
  const source = [
    "import { readFileSync } from 'node:fs';",
    "async function bootstrap() { readFileSync('config.json'); }",
    "export async function loadReport() { readFileSync('report.json'); }",
  ].join('\n');
  assert.deepEqual(classified(source, 'node-sync-fs-in-async'), [
    [2, true],
    [3, false],
  ]);
});

test('a repeated sync fs call in a startup function remains a finding', () => {
  const source = [
    "import { readFileSync } from 'node:fs';",
    'async function bootstrap(files: string[]) { for (const file of files) readFileSync(file); }',
  ].join('\n');
  assert.deepEqual(classified(source, 'node-sync-fs-in-async'), [[2, false]]);
});

test('reducers over a short constant list are contextual, unbounded input stays a finding', () => {
  const source = [
    "const channels = ['email', 'sms', 'push'];",
    'channels.reduce<string[]>((list, name) => [...list, name], []);',
    'export function collect(names: string[]) {',
    '  return names.reduce<string[]>((list, name) => [...list, name], []);',
    '}',
  ].join('\n');
  assert.deepEqual(classified(source, 'reduce-copy-accumulator'), [
    [2, true],
    [4, false],
  ]);
});
