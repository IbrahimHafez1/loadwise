'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');
const { analyzeFunctions } = require('../lib/functions.cjs');

function analyze(source) {
  const file = ts.createSourceFile('sample.ts', source, ts.ScriptTarget.Latest, true);
  assert.equal(file.parseDiagnostics.length, 0);
  return analyzeFunctions(file, file.fileName);
}

const parseRecords = `function parse(records) {
  let result = '';
  for (const record of records) {
    if (record.enabled) {
      if (record.kind === 'flag') {
        if (record.append) {
          result += 'added';
        } else {
          result += 'empty';
        }
      } else {
        result += 'other';
      }
      continue;
    }
    result += 'off';
  }
  return result;
}`;

test('loop rewrite reuses the existing continue, preserves each branch and points to real source', () => {
  const nesting = analyze(parseRecords).find((finding) => finding.ruleId === 'deep-control-flow');
  const { before, code, line, inline } = nesting.comparison;
  assert.match(inline, /record.kind !== 'flag'/);
  assert.equal(line, 5);
  const start = parseRecords.indexOf('      if (record.kind');
  const indent = (text) =>
    text
      .split('\n')
      .map((line) => '      ' + line)
      .join('\n');
  const replacement = parseRecords.replace(indent(before), indent(code));
  assert.equal(parseRecords.indexOf(indent(before)), start);
  assert.notEqual(replacement, parseRecords);
  const cases = [
    [],
    [{ enabled: false }],
    [
      { enabled: true, kind: 'other' },
      { enabled: true, kind: 'flag', append: true },
      { enabled: true, kind: 'flag', append: false },
    ],
  ];
  for (const records of cases) {
    assert.equal(
      vm.runInNewContext(replacement + '\nparse(records)', { records }),
      vm.runInNewContext(parseRecords + '\nparse(records)', { records }),
    );
  }
  assert.ok(!analyze(replacement).some((finding) => finding.ruleId === 'deep-control-flow'));
});

test('declared bindings, literal indentation and fallthrough stay out of suggested loop rewrites', () => {
  for (const altered of [
    parseRecords.replace('      continue;', '      result += "tail";'),
    parseRecords.replace('        if (record.append)', '        const local = record;\n        if (local.append)'),
    parseRecords.replace("result += 'empty';", 'result += `x\n          y`;'),
  ]) {
    const finding = analyze(altered).find((issue) => issue.ruleId === 'deep-control-flow');
    assert.ok(finding.suggestion);
    assert.equal(finding.comparison, undefined);
  }
});

test('the recommended branch range follows this scope and excludes unrelated inner functions', () => {
  const guards = Array.from({ length: 15 }, (_, index) => '    if (flags[' + index + ']) emit();').join('\n');
  const source = `function process(flags) {
  const other = () => {
${guards}
  };
  for (const item of flags) {
${guards}
  }
}`;
  const findings = analyze(source).filter((finding) => finding.ruleId === 'high-branch-complexity');
  assert.equal(findings.length, 2);
  const outer = findings.find((finding) => finding.line === 1);
  assert.match(outer.suggestion, /per-iteration work at lines 19–35/);
});
