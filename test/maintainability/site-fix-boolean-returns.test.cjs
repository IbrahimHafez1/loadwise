'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const ts = require('typescript');
const { booleanGuardReturns } = require('../../lib/maintainability/site-fixes/boolean-returns.cjs');

function rewrite(source, filename = 'example.cjs') {
  const file = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
  const fn = file.statements[0];
  const edits = booleanGuardReturns(fn.body, fn, file);
  assert.ok(edits.length <= 1);
  const [edit] = edits;
  if (edit) return source.slice(0, edit.start) + edit.text + source.slice(edit.end);
}

test('boolean guard returns preserve short-circuiting, nonboolean values and call order', () => {
  const fallback = 'next()';
  for (const [matched, otherwise] of [
    ['true', fallback],
    ['false', fallback],
    [fallback, 'true'],
    [fallback, 'false'],
    ['false', 'true'],
    ['true', 'false'],
  ]) {
    const source = `function choose(check, next) {
  if (check()) return ${matched};
  return ${otherwise};
}`;
    const fixed = rewrite(source);
    assert.ok(fixed);
    const run = (body, value) => {
      const calls = [];
      const choose = new Function('return ' + body)();
      const result = choose(
        () => (calls.push('check'), value),
        () => (calls.push('next'), null),
      );
      return [result, calls];
    };
    for (const value of [false, null, 0, '', {}, true]) assert.deepEqual(run(fixed, value), run(source, value));
  }
});

test('a parenthesized comparison is returned as is instead of being converted twice', () => {
  const source = `function same(a, b) {
  if ((a === b)) return true;
  return false;
}`;
  assert.match(rewrite(source), /return a === b;\n/);
  assert.match(
    rewrite(source.replace('return true;', 'return false;').replace('return false;\n}', 'return true;\n}')),
    /return !\(a === b\);\n/,
  );
});

test('a mixed expression retains its grouping and the original semicolon style', () => {
  const source = `function active(check, first, second) {
  if (!check) return false
  return first ?? second
}`;
  assert.match(rewrite(source), /return !!check && \(first \?\? second\)\n/);
});

test('boolean guard returns preserve comments, multiple statements and inferred TypeScript return types', () => {
  const source = `function allowed(input) {
  if (input === true) return true;
  return input === 1;
}`;
  for (const unsupported of [
    source.replace('return true;', '{ observe(); return true; }'),
    source.replace('return true;', 'return true; // audit'),
    source.replace('  return input', '  /* decision */\n  return input'),
    source.replace('return true;', 'return input;'),
  ])
    assert.equal(rewrite(unsupported), undefined);
  assert.equal(rewrite(source, 'example.ts'), undefined);
  const annotated = source.replace('(input)', '(input: unknown): boolean');
  assert.match(rewrite(annotated, 'example.ts'), /return input === true \|\| input === 1;/);
});
