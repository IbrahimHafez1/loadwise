import assert from 'node:assert/strict';
import test from 'node:test';
import ts from 'typescript';
import type * as MaintainabilitySiteFixesBranches from '../../lib/maintainability/site-fixes/branches.cjs';
const branchesModule: typeof MaintainabilitySiteFixesBranches = require('../../lib/maintainability/site-fixes/branches.cjs');
const build = branchesModule.default['high-branch-complexity'];

const names = ['first', 'second', 'third'];
const source = [
  'function decode(read: (name: string) => unknown) {',
  ...names.flatMap((name) => [
    `  const raw_${name} = read('${name}');`,
    `  const ${name}: unknown = typeof raw_${name} === 'string' ? JSON.parse(raw_${name}) : raw_${name};`,
  ]),
  '  return [first, second, third];',
  '}',
].join('\n');

function rewrite(text: string) {
  const sourceFile = ts.createSourceFile('service.ts', text, ts.ScriptTarget.Latest, true);
  const [declaration] = sourceFile.statements;
  assert.ok(declaration && ts.isFunctionDeclaration(declaration));
  const result = build({
    sourceFile,
    node: declaration.name,
    finding: { ruleId: 'high-branch-complexity', message: 'complex' },
    load: () => null,
  });
  if (!result) return undefined;
  assert.ok(result.edits);
  for (const edit of result.edits.sort((left, right) => right.start - left.start))
    text = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
  return text;
}

test('reuses the same JSON operation and preserves input order, identity and parse failures', () => {
  const edited = rewrite(source);
  assert.ok(edited);
  assert.equal((edited.match(/JSON\.parse\(/g) ?? []).length, 1);
  assert.equal(rewrite(edited), undefined);
  const object = { existing: true };
  for (const program of [source, edited]) {
    const decode: (read: (name: string) => unknown) => unknown[] = new Function(
      ts.transpile(program) + '\nreturn decode;',
    )();
    const calls: string[] = [];
    const values: Record<string, unknown> = { first: '{"ok":true}', second: object, third: null };
    const read = (name: string) => {
      calls.push(name);
      return values[name];
    };
    const result = decode(read);
    assert.deepEqual(calls, names);
    assert.deepEqual(result, [{ ok: true }, object, null]);
    assert.equal(result[1], object);
    calls.length = 0;
    values.second = '{';
    assert.throws(() => decode(read), SyntaxError);
    assert.deepEqual(calls, ['first', 'second']);
  }
});

test('keeps custom parsers, mutable inputs, changed fallbacks, incompatible types and name collisions untouched', () => {
  for (const text of [
    source.replace('  const raw_first', '  const JSON = customParser;\n  const raw_first'),
    source.replace('const raw_second', 'let raw_second'),
    source.replace('function decode(read:', 'function decode(parseJsonIfString: unknown, read:'),
    source.replace(': raw_second;', ': undefined;'),
    source.replace('third: unknown', 'third: string[]'),
    source.replace('  const raw_first', '  const parseJsonIfString = read;\n  const raw_first'),
  ])
    assert.equal(rewrite(text), undefined);
});
