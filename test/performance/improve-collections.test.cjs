'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { lint } = require('./helpers.cjs');
const { scanWithFixes, onlyChange } = require('./site-fix-helpers.cjs');

const loopCopy = 'loop-copy-accumulator';
const reduceCopy = 'reduce-copy-accumulator';

function copyFindings(source) {
  return lint(source)
    .filter(({ ruleId }) => ruleId === loopCopy || ruleId === reduceCopy)
    .map(({ ruleId, line }) => [ruleId, line]);
}

function findingsFor(context, ruleId, source, filename = 'app.ts') {
  const { findings } = scanWithFixes(context, { [filename]: source });
  return findings.filter((finding) => finding.ruleId === ruleId);
}

function changeFor(context, ruleId, source, filename) {
  const [finding] = findingsFor(context, ruleId, source, filename);
  assert.ok(finding, 'rule should report');
  return { change: onlyChange(finding), note: finding.fix?.note };
}

function assertNoFix(context, ruleId, source, filename) {
  const findings = findingsFor(context, ruleId, source, filename);
  assert.ok(findings.length > 0, 'rule should report');
  assert.deepEqual(
    findings.map((finding) => finding.fix),
    findings.map(() => undefined),
  );
}

const existence = 'filter-for-existence';

test('filter length compared with one or wrapped in Boolean() becomes some()', (context) => {
  const cases = [
    ['items.filter((item) => item.active).length >= 1', 'items.some((item) => item.active)'],
    ['items.filter((item) => item.active).length < 1', '!items.some((item) => item.active)'],
    ['1 <= items.filter((item) => item.active).length', 'items.some((item) => item.active)'],
    ['1 > items.filter((item) => item.active).length', '!items.some((item) => item.active)'],
    ['Boolean(items.filter((item) => item.active).length)', 'Boolean(items.some((item) => item.active))'],
  ];
  for (const [before, after] of cases) {
    const { change } = changeFor(
      context,
      existence,
      `export function check(items: { active: boolean }[]) {
  return ${before};
}`,
    );
    assert.deepEqual(change, { before: `return ${before};`, after: `return ${after};` });
  }
});
