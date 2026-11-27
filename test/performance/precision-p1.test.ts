import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lint } from './helpers.js';
import type { Finding } from '../../lib/shared/types.js';

function classified(source: string, ruleId: string) {
  return lint(source)
    .filter((finding: Finding) => finding.ruleId === ruleId)
    .map(({ line, contextualReason }) => [line, Boolean(contextualReason)]);
}

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
