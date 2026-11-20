'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const vm = require('node:vm');
const { controlFlowComparison } = require('../control-flow-comparison.cjs');

function comparison(source, row, options = {}, supplied) {
  const lines = source.split('\n');
  return controlFlowComparison(
    { languageId: 'typescript', lineAt: (index) => ({ text: lines[index] }), lineCount: lines.length, ...options },
    {
      source: 'warden-maint',
      code: 'deep-control-flow',
      comparison: supplied,
      range: { start: { line: row, character: lines[row].indexOf('if') } },
    },
  );
}

test('analyzer comparisons must match the saved source and include the reported line', () => {
  const before = 'if (ready) {\n  if (eligible) act();\n}';
  const source = before
    .split('\n')
    .map((line) => '    ' + line)
    .join('\n');
  const supplied = {
    before,
    line: 1,
    code: 'if (ready && eligible) act();',
    inline: 'Combine the two guards.',
    note: 'Short-circuit evaluation is preserved.',
  };
  assert.equal(comparison(source, 1, {}, supplied), supplied);
  assert.equal(comparison(source.replace('eligible', 'disabled'), 1, {}, supplied), undefined);
  assert.equal(comparison(source, 1, { isDirty: true }, supplied), undefined);
  assert.equal(comparison(source, 1, {}, { ...supplied, line: 3 }), undefined);
});

test('shows the actual Simbel-style assignment with the same lazy write and one getter access', () => {
  const source = [
    '  const post = await this.posts.findOne({ where: { externalPostId } });',
    '  // Publication is terminal.',
    '  if (post && post.status !== PostStatus.PUBLISHED) {',
    "    if (status === 'published' || status === 'success') {",
    '      post.status = PostStatus.PUBLISHED;',
    '      if (!post.publishedAt) post.publishedAt = new Date();',
    "    } else if (status === 'failed') {",
  ].join('\n');
  const result = comparison(source, 5);
  assert.equal(result.before, 'if (!post.publishedAt) post.publishedAt = new Date();');
  assert.equal(result.code, 'post.publishedAt ||= new Date();');
  assert.equal(result.inline, result.before + ' → ' + result.code);
  for (const initial of [undefined, null, false, 0, '', 'published']) {
    const run = (body) =>
      vm.runInNewContext(
        `let reads = 0, writes = 0, dates = 0;
        class Date { constructor() { dates++; } }
        const post = { get publishedAt() { reads++; return initial; }, set publishedAt(value) { writes++; } };
        ${body}
        JSON.stringify([reads, writes, dates]);`,
        { initial },
      );
    assert.equal(run(result.before), run(result.code));
  }
});

test('combines nested guards without changing short-circuit order or the enclosed statement', () => {
  const source = ['    if (ready()) {', '      if (!closed()) {', '        save();', '      }', '    }'].join('\n');
  const result = comparison(source, 1);
  assert.equal(result.before, 'if (ready()) {\n  if (!closed()) {\n    save();\n  }\n}');
  assert.equal(result.code, 'if (ready() && !closed()) {\n  save();\n}');
  for (const open of [false, true])
    for (const shut of [false, true]) {
      const run = (body) => {
        const calls = [];
        const record = (name, value) => (calls.push(name), value);
        vm.runInNewContext(body, {
          ready: () => record('ready', open),
          closed: () => record('closed', shut),
          save: () => record('save'),
        });
        return calls;
      };
      assert.deepEqual(run(result.code), run(result.before));
    }
});

test('unproven receiver stability, else clauses, extended statements and stale source use the fallback', () => {
  const guarded = 'if (!post.time) post.time = clock();';
  for (const source of [
    guarded,
    'let post = first;\n' + guarded,
    'const post = first;\n{ let post = other;\n' + guarded,
    'const post = first;\n' + guarded + '\nelse log();',
    'const post = first;\n' + guarded + ' audit();',
    'const post = first;\nif (!post.time) post.time = clock(), audit();',
  ]) {
    const row = source.split('\n').findIndex((line) => line.startsWith('if'));
    assert.equal(comparison(source, row), undefined, source);
  }
  const nested = 'if (ready) {\n  if (allowed) {\n    work();\n  }\n}';
  for (const suffix of [' else other();', '\nelse other();', '\n/* gap */ else other();'])
    assert.equal(comparison(nested + suffix, 1), undefined);
  assert.equal(comparison(nested.replace('  }', '    more();\n  }'), 1), undefined);
  assert.equal(comparison(nested, 1, { isDirty: true }), undefined);
  assert.equal(comparison(nested, 1, { languageId: 'python' }), undefined);
});
