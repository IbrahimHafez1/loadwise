import assert from 'node:assert/strict';
import test from 'node:test';
import ts from 'typescript';
import { analyzeFunctions } from '../../lib/maintainability/functions.js';
import type { SiteFixInput } from '../../lib/shared/types.js';
import controlFlow from '../../lib/maintainability/site-fixes/control-flow.js';
const build = controlFlow['deep-control-flow'];

// The deep-control-flow builder also reads the offset of the finding, which SiteFixInput does not
// declare.
type DeepControlFlowInput = SiteFixInput & { offset: number };

function rewrite(text: string) {
  const sourceFile = ts.createSourceFile('loop.cjs', text, ts.ScriptTarget.Latest, true);
  const finding = analyzeFunctions(sourceFile, sourceFile.fileName).find(
    (issue) => issue.ruleId === 'deep-control-flow',
  );
  if (!finding) return;
  assert.ok(finding.line !== undefined && finding.column !== undefined);
  const offset = sourceFile.getPositionOfLineAndCharacter(finding.line - 1, finding.column - 1);
  const input: DeepControlFlowInput = {
    sourceFile,
    offset,
    node: ts.getTokenAtPosition(sourceFile, offset),
    finding,
    load: () => null,
  };
  const result = build(input);
  if (!result) return;
  assert.ok(result.edits);
  for (const edit of result.edits.toSorted((left, right) => right.start - left.start))
    text = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
  return text;
}

const guardedSearch = [
  'function search(enabled, groups) {',
  '  if (enabled())',
  '    for (const group of groups)',
  '      for (const item of group) {',
  '        if (item) return item;',
  '      }',
  '}',
].join('\n');

test('lifts an unbraced terminal loop, keeping condition evaluation and iterator closing', () => {
  const edited = rewrite(guardedSearch);
  assert.ok(edited);
  assert.match(edited, /if \(!enabled\(\)\) return;\n  for/);
  assert.equal(rewrite(edited), undefined);
  for (const text of [guardedSearch, edited]) {
    const search = new Function(text + '\nreturn search;')();
    const events: string[] = [];
    function* groups() {
      events.push('started');
      try {
        yield [false, 'found'];
        throw new Error('iterated too far');
      } finally {
        events.push('closed');
      }
    }
    const condition = (value: boolean) => () => {
      events.push('condition');
      return value;
    };
    assert.equal(search(condition(false), groups()), undefined);
    assert.equal(search(condition(true), groups()), 'found');
    assert.deepEqual(events, ['condition', 'condition', 'started', 'closed']);
  }
});

test('turns the first alternative into a continue and preserves the order of both branches', () => {
  const source = [
    'function collect(groups, append) {',
    '  for (const group of groups) {',
    '    if (group.special) append("special");',
    '    else',
    '      for (const item of group) {',
    '        if (item) append(item);',
    '      }',
    '  }',
    '}',
  ].join('\n');
  const edited = rewrite(source);
  assert.ok(edited);
  assert.match(edited, /append\("special"\);\n      continue;\n    \}\n    for/);
  assert.equal(rewrite(edited), undefined);
  for (const text of [source, edited]) {
    const collect = new Function(text + '\nreturn collect;')();
    const seen: unknown[] = [];
    collect([['first'], { special: true }, ['', 'last']], (item: unknown) => seen.push(item));
    assert.deepEqual(seen, ['first', 'special', 'last']);
  }
});

test('retains loop guards with an intervening comment, a multiline literal, or following work', () => {
  for (const text of [
    guardedSearch.replace('    for', '    // Keep the iterator lazy.\n    for'),
    guardedSearch.replace('return item;', 'return `first\n        last`;'),
    guardedSearch.replace('\n}', '\n  enabled();\n}'),
  ])
    assert.equal(rewrite(text), undefined);
});

test('lifting a declaration may not shadow the condition or extend a resource lifetime', () => {
  const source = [
    'const enabled = true;',
    'function search(groups) {',
    '  if (enabled) {',
    '    const enabled = groups.length;',
    '    for (const group of groups)',
    '      for (const item of group)',
    '        if (item === enabled) return item;',
    '  }',
    '}',
  ].join('\n');
  assert.equal(rewrite(source), undefined);
  const resource = source
    .replace('const enabled = groups.length', 'using resource = acquire()')
    .replace('=== enabled', '=== resource');
  assert.equal(rewrite(resource), undefined);
});

test('does not copy a return expression into a scope with a different binding', () => {
  const source = [
    'function search(active, enabled, groups) {',
    '  const result = "outside";',
    '  if (active) {',
    '    const result = "inside";',
    '    if (enabled)',
    '      for (const group of groups)',
    '        for (const item of group)',
    '          if (item) return result;',
    '  }',
    '  return result;',
    '}',
  ].join('\n');
  assert.equal(rewrite(source), undefined);
});
