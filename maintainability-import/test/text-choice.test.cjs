'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const ts = require('typescript');
const { analyzeFunctions } = require('../lib/functions.cjs');

const values = Array.from({ length: 16 }, (_, index) => `s${index}: flag ? "short" : "long"`).join(',');
const content = Array.from({ length: 16 }, () => '<p>{flag ? "short" : "long"}</p>').join('');
function finding(source) {
  const file = ts.createSourceFile('view.tsx', source, ts.ScriptTarget.Latest, true);
  assert.equal(file.parseDiagnostics.length, 0);
  return analyzeFunctions(file, 'view.tsx').find((row) => row.ruleId === 'high-branch-complexity');
}

test('standalone data and static markup with one repeated selector are contextual', () => {
  for (const source of [
    `const labels = flag => ({${values}});`,
    `function catalog(kind) {const flag = kind === Mode.small; const titles={${values}}; return {titles};}`,
    `const intro = flag => <section>${content}</section>;`,
  ])
    assert.ok(finding(source).contextualReason);
});

test('operations, other decisions, dynamic attributes and other components keep their advisory', () => {
  for (const source of [
    `function labels(flag){saveDraft(); return {${values}};}`,
    `function labels(flag){const state = useState(); return {${values}};}`,
    `function labels(flag){if (!allowed) return {}; return {${values}};}`,
    `const labels = flag => ({${values}, state: enabled ? "ready" : "busy"});`,
    `const labels = flag => ({${values}, total: run()});`,
    `const view = flag => <button onClick={submit}>${content}</button>;`,
    `const view = flag => <Panel>${content}</Panel>;`,
  ])
    assert.equal(finding(source).contextualReason, undefined);
});
