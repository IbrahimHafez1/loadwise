import assert from 'node:assert/strict';
import test from 'node:test';
import ts from 'typescript';
import { exampleFor } from '../../lib/editor/maintainability-examples.js';

test('JS, TS and React modes have parseable illustrative code for every source rule', () => {
  const rules = [
    'deep-control-flow',
    'duplicate-implementation',
    'high-branch-complexity',
    'dependency-cycle',
    'folder-boundary',
    'query-mutates-state',
  ];
  for (const language of ['javascript', 'typescript', 'javascriptreact', 'typescriptreact']) {
    for (const rule of rules) {
      const example = exampleFor(rule, language, '');
      assert.ok(example);
      const typed = language.startsWith('typescript');
      assert.equal(example.language, typed ? 'typescript' : 'javascript');
      const parsed = ts.createSourceFile(typed ? 'example.ts' : 'example.js', example.code, ts.ScriptTarget.Latest);
      assert.ok(parsed.parseDiagnostics);
      assert.equal(parsed.parseDiagnostics.length, 0, rule);
      assert.ok(example.note);
    }
  }
});

test('each supported nesting language gets a matching loop guard and supported duplicates get a shared predicate', () => {
  const duplicateLanguages = new Set(['python', 'go', 'java', 'csharp', 'rust']);
  for (const language of [...duplicateLanguages, 'php', 'ruby', 'kotlin', 'c', 'cpp']) {
    const guard = exampleFor('deep-control-flow', language, '');
    assert.ok(guard);
    assert.equal(guard.language, language);
    assert.match(guard.code, /continue|next unless/);
    assert.equal(
      exampleFor('duplicate-implementation', language, '')?.language,
      duplicateLanguages.has(language) ? language : undefined,
    );
    assert.equal(exampleFor('query-mutates-state', language, ''), undefined);
  }
  assert.equal(exampleFor('deep-control-flow', 'elixir', ''), undefined);
  assert.equal(exampleFor('unrecognized', 'javascript', ''), undefined);
});

test('layout examples use the project rule when its target is explicit and handle arbitrary policies', () => {
  const single = exampleFor(
    'file-placement',
    'python',
    'The project places files ending in _adapter.py under connectors.\nMove the file.',
  );
  assert.ok(single);
  assert.equal(single.code, 'connectors/example_adapter.py');
  const several = exampleFor('file-placement', 'plaintext', 'The project places files ending in .txt under a or b.');
  assert.ok(several);
  assert.equal(several.language, 'plaintext');
  assert.match(several.code, /allowed directories/);
});
