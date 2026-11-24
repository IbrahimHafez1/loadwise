// Guards that pin a request value before it reaches a sink.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withContext, sinkArgument, stubs } from './helpers.cjs';
import type { SourceFile } from 'typescript';
import type { SecurityRuleContext } from '../../lib/shared/types.cjs';

// The trace label at sink(), or null when the value is clean; checked with and without the
// installed types.
function tracedLabel(body: string) {
  const source = [
    "import express from 'express';",
    'declare function sink(value: unknown): void;',
    "const ALLOWED = ['name', 'date'];",
    'const app = express();',
    `app.get('/items', (req, res) => { const { sort } = req.query; ${body} });`,
  ].join('\n');
  const labelWith = (files: Record<string, string>) =>
    withContext(
      source,
      files,
      (context: SecurityRuleContext, sourceFile: SourceFile) =>
        context.taint.trace(sinkArgument(sourceFile), 'sql')?.label ?? null,
    );
  const typed = labelWith(stubs.express);
  const untyped = labelWith({});
  assert.ok(untyped === null || untyped === typed, 'traced only without types');
  return typed;
}

test('typeof and Number checks pin a value to a number', () => {
  assert.equal(tracedLabel("if (typeof sort !== 'number') return; sink(sort);"), null);
  assert.equal(tracedLabel("if (typeof sort === 'number') sink(sort);"), null);
  assert.equal(tracedLabel('if (!Number.isInteger(sort)) throw new Error(); sink(sort);'), null);
  assert.equal(tracedLabel("if (typeof sort === 'string') sink(sort);"), 'req.query');
});

test('equality with literals and literal-set includes pin a value', () => {
  assert.equal(tracedLabel("if (sort !== 'asc' && sort !== 'desc') return; sink(sort);"), null);
  assert.equal(tracedLabel("sink(sort === 'asc' ? sort : 'desc');"), null);
  assert.equal(tracedLabel("if (sort === 'asc' || sort === 'desc') sink(sort);"), null);
  assert.equal(tracedLabel("if (['asc', 'desc'].includes(sort)) sink(sort);"), null);
  assert.equal(tracedLabel('if (!ALLOWED.includes(sort)) return; sink(sort);'), null);
  assert.equal(tracedLabel("if (sort === 'asc' || sort.length < 5) sink(sort);"), 'req.query');
  assert.equal(tracedLabel("if (sort !== 'asc') console.log(sort); sink(sort);"), 'req.query');
});

test('switch cases over literals pin the value, default and fallthrough from default do not', () => {
  assert.equal(tracedLabel("switch (sort) { case 'asc': case 'desc': sink(sort); break; }"), null);
  assert.equal(tracedLabel("switch (sort) { case 'asc': sink(sort); break; default: sink(sort); }"), null);
  assert.equal(tracedLabel('switch (sort) { default: sink(sort); }'), 'req.query');
  assert.equal(tracedLabel("switch (sort) { default: case 'asc': sink(sort); }"), 'req.query');
});

test('a guard does not hold when the value is reassigned or the guard comes after the use', () => {
  assert.equal(
    tracedLabel("let value = sort; if (value !== 'asc') return; value = req.query.other; sink(value);"),
    'req.query',
  );
  assert.equal(tracedLabel("sink(sort); if (sort !== 'asc') return;"), 'req.query');
});
