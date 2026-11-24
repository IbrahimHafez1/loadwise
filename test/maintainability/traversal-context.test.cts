import assert from 'node:assert/strict';
import test from 'node:test';
import ts from 'typescript';
import { analyzeFunctions } from '../../lib/maintainability/functions.cjs';

function context(leaf: string) {
  const text =
    'function reduce(values) { for (const a of values) { for (const b of a) { for (const item of b) {' + leaf + '}}}}';
  const source = ts.createSourceFile('data.ts', text, ts.ScriptTarget.Latest, true);
  const finding = analyzeFunctions(source, 'data.ts').find((row) => row.ruleId === 'deep-control-flow');
  assert.ok(finding);
  return finding.contextualReason;
}

test('single extrema and visited-item admissions retain their nested traversal context', () => {
  assert.ok(context('if (item < smallest) smallest = item;'));
  assert.ok(context('if (value > heights[item]) heights[item] = value;'));
  assert.ok(context('if (allowed[item] && !seen[item]) { seen[item] = 1; pending.push(item); }'));
  assert.ok(context('if (item < 0) continue; if (item > best) best = item;'));
});

test('additional work, independent decisions and raw guards remain visible', () => {
  for (const leaf of [
    'if (item > best) { best = item; index = pos; }',
    'if (item > best) best = compute(item);',
    'if (item < limit) continue;',
    'if (!seen[item]) { seen[item] = true; pending.push(other); }',
    'if (item > best) best = item; if (active) publish(item);',
    'if (item > best) best = item; else reset();',
  ])
    assert.equal(context(leaf), undefined, leaf);
});
