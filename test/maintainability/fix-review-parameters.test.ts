import assert from 'node:assert/strict';
import test from 'node:test';
import ts from 'typescript';
import { checkSizeLimits } from '../../lib/maintainability/size-limits.js';
import { buildFix } from '../../lib/maintainability/site-fix.js';
import { applyFix } from '../../lib/maintainability/apply-fix.js';

const printWidth = 120;
const signature = 'const draw = (a: number, b: number, c: number | undefined, d: number[], e: number, f?: number) =>';

function sourceWith(callText: string, newline = '\n') {
  return [
    'export function render() {',
    '  ' + signature,
    '    [a, b, c, d, e, f];',
    '  const one = 1, two = 2, three = 3, four = [4], five = 5;',
    '',
    '  // filler rows keep the declaration and the call in separate hunks',
    '  const spacer = 0;',
    '  void spacer;',
    '  return ' + callText + ';',
    '}',
  ].join(newline);
}

function fixFor(text: string) {
  const sourceFile = ts.createSourceFile('render.ts', text, ts.ScriptTarget.Latest, true);
  const entry = {
    text,
    sourceFile,
    absolute: 'render.ts',
    filename: 'render.ts',
    lineStarts: [...sourceFile.getLineStarts()],
    scriptKind: sourceFile.scriptKind,
  };
  const [finding] = checkSizeLimits(sourceFile, 'render.ts').filter(({ ruleId }) => ruleId === 'long-parameter-list');
  return buildFix(finding, () => entry);
}

function applied(text: string) {
  const fix = fixFor(text);
  assert.ok(fix, 'a fix is offered');
  let after: string | undefined;
  const result = applyFix(fix, { readFile: () => text, writeFile: (_file, value) => (after = value) });
  assert.equal(result.error, undefined);
  assert.equal(typeof after, 'string');
  assert.ok(after !== undefined);
  return after;
}

function syntaxErrors(text: string) {
  const { parseDiagnostics } = ts.createSourceFile('render.ts', text, ts.ScriptTarget.Latest, true);
  assert.ok(parseDiagnostics);
  return parseDiagnostics.length;
}

const layouts = {
  inline: 'draw(one, two, undefined, four, five)',
  'one per line': 'draw(\n    one,\n    two,\n    undefined,\n    four,\n    five\n  )',
  'one per line with a trailing comma': 'draw(\n    one,\n    two,\n    undefined,\n    four,\n    five,\n  )',
  'one per line without a dropped undefined': 'draw(\n    one,\n    two,\n    three,\n    four,\n    five,\n  )',
  'full argument list': 'draw(\n    one,\n    two,\n    three,\n    four,\n    five,\n    6,\n  )',
};

for (const [name, callText] of Object.entries(layouts)) {
  for (const newline of ['\n', '\r\n']) {
    test(`a ${name} call keeps parsing after grouping (${JSON.stringify(newline)})`, () => {
      const text = sourceWith(callText.replaceAll('\n', newline), newline);
      assert.equal(syntaxErrors(text), 0);
      const after = applied(text);
      assert.equal(syntaxErrors(after), 0, after);
      assert.match(after, /draw\(\{/);
      assert.ok(!/\)\s*\)\s*;/.test(after) && !/}\s*,\s*\)/.test(after), 'no argument list is left behind');
      assert.ok(newline === '\r\n' ? !/(?<!\r)\n/.test(after) : !after.includes('\r'), 'line endings are kept');
    });
  }
}

test('a one-per-line call becomes one object that opens and closes with the call', () => {
  const after = applied(sourceWith(layouts['one per line with a trailing comma']));
  assert.ok(
    after.includes('draw({\n    a: one,\n    b: two,\n    c: undefined,\n    d: four,\n    e: five,\n  });'),
    after,
  );
});

test('generated lines stay within the print width without Prettier', () => {
  const parameters = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth'].map((name) => `${name}Amount: number`);
  const text = [
    'export function render() {',
    `  const draw = (${parameters.join(', ')}) => 0;`,
    '  const value = 1;',
    '  void value;',
    '  void value;',
    '  void value;',
    '  void value;',
    '  return draw(value, value, value, value, value, value);',
    '}',
  ].join('\n');
  const after = applied(text);
  assert.equal(syntaxErrors(after), 0);
  const longest = Math.max(...after.split('\n').map((line) => line.length));
  assert.ok(longest <= printWidth, after);
});
