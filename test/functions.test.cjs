'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const ts = require('typescript');
const { analyzeFunctions } = require('../lib/functions.cjs');

function analyze(source) {
  const file = 'src/example.ts';
  return analyzeFunctions(ts.createSourceFile(file, source, ts.ScriptTarget.Latest), file);
}

function guards(count) {
  return Array.from({ length: count }, (_, index) => `if (status === ${index}) return ${index};`).join('\n');
}

test('reports the deepest nested decision once for a function, including an ordinary else body', () => {
  const findings = analyze([
    'function update() {',
    '  if (ready) {} else {',
    '    for (const user of users) {',
    '      switch (user.kind) {',
    '        case "active":',
    '          if (user.enabled) notify();',
    '          if (user.owner) audit();',
    '      }',
    '    }',
    '  }',
    '}',
  ].join('\n'));
  assert.equal(findings.length, 1);
  assert.deepEqual([findings[0].file, findings[0].line, findings[0].column, findings[0].ruleId],
    ['src/example.ts', 6, 11, 'deep-control-flow']);
  assert.match(findings[0].message, /4 nested levels/);
  assert.deepEqual(analyze('function f() { if (a) for (;;) while (b) act(); }'), []);
});

test('counts an else-if chain at the exact complexity boundary without increasing its depth', () => {
  const chain = count => `const classify = () => { ${guards(count).replaceAll('\nif', ' else if')} };`;
  assert.deepEqual(analyze(chain(13)), []);
  const findings = analyze(chain(14));
  assert.equal(findings.length, 1);
  assert.deepEqual([findings[0].ruleId, findings[0].line, findings[0].column], ['high-branch-complexity', 1, 7]);
  assert.match(findings[0].message, /complexity of 15/);
});

test('counts explicit decisions including ternaries and catches while flat dispatch and defaults stay small', () => {
  const cases = Array.from({ length: 40 }, (_, index) => `case ${index}: return values[${index}] ?? fallback;`).join('\n');
  assert.deepEqual(analyze(`function read(key) { switch (key) { ${cases} } }`), []);
  const findings = analyze(`class Runner { execute() {
    ${guards(10)}
    try { for (const job of jobs) use(job); } catch (error) { warn(error); }
    switch (kind) { case 1: break; }
    return ok ? handle() : stop();
  } }`);
  assert.deepEqual(findings.map(finding => finding.ruleId), ['high-branch-complexity']);
  assert.match(findings[0].message, /complexity of 15/);
});

test('callbacks and local classes keep their own complexity and nesting, even inside a deep function', () => {
  const source = `function outer() {
    ${guards(11)}
    if (list) for (const entry of list) {
      visit(entry, () => { if (ok) if (valid) use(); });
      class Local { code = condition ? a : condition2 ? b : c; check() { if (ok) return value; } }
    }
  }`;
  assert.deepEqual(analyze(source), []);
  const findings = analyze(`function outer() { ${guards(3)}
    jobs.map(job => { ${guards(14)} });
  }`);
  assert.deepEqual(findings.map(finding => finding.ruleId), ['high-branch-complexity']);
  assert.match(findings[0].message, /complexity of 15/);
});

test('annotated instance queries report direct field writes at their targets', () => {
  const findings = analyze([
    'class Inventory {',
    '  /** @maintainabilityQuery */',
    '  inspect(input = this.readCount++) {',
    '    this.cache = input;',
    '    this.count += 1;',
    '    ++this.metadata.version;',
    "    delete this.metadata['expired'];",
    '    this.#cached ??= input;',
    '    [this.status = fallback, ...this.rest] = input;',
    '    ({ value: this.details.value } = input);',
    '    for (this.current of input) log(this.current);',
    '    (() => { this.metadata.updated = true; })();',
    '  }',
    '}',
  ].join('\n'));
  assert.deepEqual(findings.map(({ line, column, ruleId }) => [line, column, ruleId]), [
    [3, 19], [4, 5], [5, 5], [6, 7], [7, 12], [8, 5], [9, 6], [9, 33],
    [10, 15], [11, 10], [12, 14],
  ].map(([line, column]) => [line, column, 'query-mutates-state']));
});

test('the explicit query contract leaves local writes, aliases, reads and deferred callbacks alone', () => {
  const source = [
    'class Store {',
    '  /** @maintainabilityQuery */',
    '  inspect() {',
    '    const local = { value: this.data.count }; local.value++;',
    '    const alias = this.data; alias.count++;',
    '    this.data.push(local); this.getData().value = 1;',
    '    const later = () => { this.count++; };',
    '    (function () { this.foreign = 1; })();',
    '    return () => delete this.cache;',
    '  }',
    '  /** @maintainabilityQueryDescription */',
    '  other() { this.value++; }',
    '  /** @maintainabilityQuery */',
    '  static inspectGlobal() { this.value++; }',
    '  readValue() { this.value++; }',
    '}',
    'const object = {',
    '  /** @maintainabilityQuery */',
    '  inspect() { this.value++; }',
    '};',
  ].join('\n');
  assert.deepEqual(analyze(source), []);
});
