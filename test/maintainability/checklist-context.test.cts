import assert from 'node:assert/strict';
import test from 'node:test';
import ts from 'typescript';
import { analyzeFunctions } from '../../lib/maintainability/functions.cjs';

function review(items: readonly string[], body = '') {
  const source = `function inspect(kind, input) { switch (kind) { case 'details': ${body} return [${items.join(',')}]; } }`;
  const file = ts.createSourceFile('rules.ts', source, ts.ScriptTarget.Latest, true);
  return analyzeFunctions(file, 'rules.ts').find((finding) => finding.ruleId === 'high-branch-complexity');
}

const fields = Array.from(
  { length: 16 },
  (_, index) => `...((input.part${index} ?? []).length > 1 ? [] : ['part ${index}'])`,
);

test('flat lists of optional literal messages with simple predicates remain available as context', () => {
  assert.match(
    String(review([...fields, "...(externalCheck(input) ? [] : ['detail'])"])?.contextualReason),
    /literal messages/,
  );
});

test('actions, complex values, and enough remaining decisions retain the default review', () => {
  const opaque = Array.from({ length: 14 }, (_, index) => `...(check${index}(input) ? [] : ['detail'])`);
  for (const finding of [
    review(fields, 'save();'),
    review([...fields, '...(input.status ? [] : [calculate()])']),
    review([...fields, ...opaque]),
  ]) {
    assert.ok(finding);
    assert.equal(finding.contextualReason, undefined);
  }
});
