'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const ts = require('typescript');
const { analyzeFunctions } = require('../../lib/maintainability/functions.cjs');

function review(items, body = '') {
  const source = `function inspect(kind, input) { switch (kind) { case 'details': ${body} return [${items.join(',')}]; } }`;
  const file = ts.createSourceFile('rules.ts', source, ts.ScriptTarget.Latest, true);
  return analyzeFunctions(file, 'rules.ts').find((finding) => finding.ruleId === 'high-branch-complexity');
}

const fields = Array.from(
  { length: 16 },
  (_, index) => `...((input.part${index} ?? []).length > 1 ? [] : ['part ${index}'])`,
);

test('flat lists of optional literal messages with simple predicates remain available as context', () => {
  assert.match(review([...fields, "...(externalCheck(input) ? [] : ['detail'])"]).contextualReason, /literal messages/);
});

test('actions, complex values, and enough remaining decisions retain the default review', () => {
  const opaque = Array.from({ length: 14 }, (_, index) => `...(check${index}(input) ? [] : ['detail'])`);
  for (const finding of [
    review(fields, 'save();'),
    review([...fields, '...(input.status ? [] : [calculate()])']),
    review([...fields, ...opaque]),
  ])
    assert.equal(finding.contextualReason, undefined);
});
