import assert from 'node:assert/strict';
import test from 'node:test';
import { exampleFor } from '../../lib/editor/accessibility-examples.js';

const accessibilityRules = [
  'a11y-img-missing-alt',
  'a11y-button-missing-type',
  'a11y-clickable-non-interactive',
  'a11y-invalid-aria',
  'a11y-missing-form-label',
  'a11y-html-missing-lang',
  'a11y-iframe-missing-title',
  'a11y-positive-tabindex',
  'a11y-viewport-zoom-disabled',
];

test('every accessibility rule has a before and after example in JSX and in HTML', () => {
  for (const ruleId of accessibilityRules) {
    for (const languageId of ['typescriptreact', 'javascriptreact', 'html', 'vue', 'svelte']) {
      const example = exampleFor(ruleId, languageId);
      assert.ok(example?.before && example.code && example.note, `${ruleId} has no ${languageId} example`);
      assert.notEqual(example.before, example.code, ruleId);
    }
  }
});

test('accessibility examples are not offered for other languages or rules', () => {
  assert.equal(exampleFor('a11y-img-missing-alt', 'python'), undefined);
  assert.equal(exampleFor('swallowed-error', 'html'), undefined);
});
