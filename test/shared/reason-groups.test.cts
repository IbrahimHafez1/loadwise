import assert from 'node:assert/strict';
import test from 'node:test';
import { printFindings } from '../../lib/performance/finding-text.cjs';
import type { Finding } from '../../lib/shared/types.cjs';

const reason: Finding = {
  ruleId: 'array-repeated-membership',
  impactLevel: 'medium',
  message: 'Each includes() rescans.',
};
const example = { language: 'typescript', code: 'const lookup = new Set(values);' };

function printed(findings: Finding[]) {
  const lines: string[] = [];
  printFindings(findings, 'npx loadwise perf', (line: string) => lines.push(line));
  return lines;
}

test('findings that share a reason print it once, above each location and its own details', () => {
  const lines = printed([
    { ...reason, id: 'a1', file: 'a.ts', line: 2, column: 3, example },
    { ...reason, ruleId: 'other-rule', id: 'b1', file: 'b.ts', line: 1, column: 1 },
    { ...reason, id: 'a2', file: 'c.ts', line: 9, column: 4, example },
  ]);
  assert.deepEqual(lines, [
    '[array-repeated-membership] medium: Each includes() rescans. (2 findings)',
    '  a.ts:2:3 #a1',
    '  c.ts:9:4 #a2',
    '  Example (generic, adapt it to this code):',
    '    const lookup = new Set(values);',
    'b.ts:1:1 [other-rule #b1] medium: Each includes() rescans.',
  ]);
});

test('a different message or contextual reason keeps findings apart', () => {
  const lines = printed([
    { ...reason, id: 'a1', file: 'a.ts', line: 2, column: 3 },
    { ...reason, id: 'a2', file: 'a.ts', line: 5, column: 3, message: 'Each indexOf() rescans.' },
    { ...reason, id: 'a3', file: 'a.ts', line: 7, column: 3, contextualReason: 'Test or example source.' },
  ]);
  assert.equal(lines.length, 3);
  assert.ok(lines.every((line) => line.startsWith('a.ts:')));
});
