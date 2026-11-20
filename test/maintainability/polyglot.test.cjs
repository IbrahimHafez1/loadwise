'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { analyzePolyglot } = require('../../lib/maintainability/polyglot.cjs');

let nativeAvailable = false;
try {
  nativeAvailable = Boolean(require('@ast-grep/cli/postinstall.js').resolveBinaryPath());
} catch (error) {
  if (error.code !== 'MODULE_NOT_FOUND') throw error;
}
const nativeOnly = { skip: !nativeAvailable && 'Optional parser is unavailable' };

function fixture(context) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'maintainability-polyglot-'));
  const files = [];
  context.after(() => {
    for (const file of files) fs.unlinkSync(path.join(root, file));
    fs.rmdirSync(root);
  });
  return {
    root,
    files,
    write(name, source) {
      fs.writeFileSync(path.join(root, name), source);
      files.push(name);
    },
  };
}

const braced = (prefix, decision, work, suffix) => (depth) =>
  [prefix, ...Array(depth).fill(decision + ' {'), work, ...Array(depth).fill('}'), suffix].join('\n');
const fixtures = [
  [
    'Python',
    '.py',
    (depth) =>
      [
        'def f(ok):',
        ...Array.from({ length: depth }, (_, i) => '    '.repeat(i + 1) + 'if ok:'),
        '    '.repeat(depth + 1) + 'pass',
      ].join('\n'),
  ],
  ['Go', '.go', braced('package sample\nfunc test(ok bool) {', 'if ok', 'return', '}')],
  ['Java', '.java', braced('class Sample { void test(boolean ok) {', 'if (ok)', 'return;', '} }')],
  ['C#', '.cs', braced('class Sample { void Test(bool ok) {', 'if (ok)', 'return;', '} }')],
  ['Rust', '.rs', braced('fn test(ok: bool) {', 'if ok', 'return;', '}')],
  ['PHP', '.php', braced('<?php function sample($ok) {', 'if ($ok)', 'return;', '}')],
  [
    'Ruby',
    '.rb',
    (depth) => ['def test(ok)', ...Array(depth).fill('if ok'), 'return', ...Array(depth + 1).fill('end')].join('\n'),
  ],
  ['Kotlin', '.kt', braced('fun test(ok: Boolean) {', 'if (ok)', 'return', '}')],
  ['C', '.c', braced('void test(int ok) {', 'if (ok)', 'return;', '}')],
  ['C++', '.cpp', braced('void test(bool ok) {', 'if (ok)', 'return;', '}')],
];

for (const [language, extension, source] of fixtures) {
  test(
    language + ' counts four nested control bodies once and leaves shallower code clean',
    nativeOnly,
    async (context) => {
      const { root, files, write } = fixture(context);
      write('deep sample' + extension, source(6));
      write('shallow' + extension, source(3));
      const { findings, languageCounts } = await analyzePolyglot({ root, files });
      assert.deepEqual(languageCounts, { [language]: 2 });
      assert.deepEqual(
        findings.map((item) => [item.file, item.ruleId, item.line]),
        [[files[0], 'deep-control-flow', language === 'Go' ? 6 : 5]],
      );
    },
  );
}

test(
  'else-if chains, literal source text, and nested callables do not accumulate depth',
  nativeOnly,
  async (context) => {
    const { root, files, write } = fixture(context);
    write(
      'Branch.java',
      'class Branch { void f(boolean x) { if (x) {} else if (x) {} else if (x) {} else if (x) {} else if (x) {} } }',
    );
    write('nested.py', 'def f(x):\n if x:\n  if x:\n   if x:\n    def inner(y):\n     if y:\n      pass\n');
    write('text.rs', 'fn main() { let _ = "if a { if b { if c { if d {"; }');
    assert.deepEqual((await analyzePolyglot({ root, files })).findings, []);
  },
);

test('an else suite shares the enclosing decision depth across grammar wrappers', nativeOnly, async (context) => {
  const { root, files, write } = fixture(context);
  write('alternative.py', 'def f(x):\n if x:\n  return\n else:\n  if x:\n   if x:\n    if x:\n     pass\n');
  write(
    'alternative.rb',
    'def f(x)\n if x\n  return\n else\n  if x\n   if x\n    if x\n     return\n    end\n   end\n  end\n end\nend\n',
  );
  write('alternative.php', '<?php function f($x) { if ($x) {} elseif ($x) { if ($x) { if ($x) { if ($x) {} } } } }');
  write('alternative.rs', 'fn f(x: bool) { if x {} else { if x { if x { if x {} } } } }');
  for (const extension of ['c', 'cpp']) {
    write('alternative.' + extension, 'void f(int x) { if (x) {} else { if (x) { if (x) { if (x) {} } } } }');
  }
  const { findings } = await analyzePolyglot({ root, files });
  assert.deepEqual(findings.map((finding) => finding.file).sort(), [...files].sort());
});

test('explicit files are accounted for and parse errors fail the scan', nativeOnly, async (context) => {
  const { root, write } = fixture(context);
  write('empty.py', '');
  assert.deepEqual((await analyzePolyglot({ root, files: ['empty.py', 'empty.py'] })).languageCounts, { Python: 1 });
  write('invalid.py', 'def @@@:\n');
  await assert.rejects(analyzePolyglot({ root, files: ['invalid.py'] }), /invalid.py/);
  await assert.rejects(analyzePolyglot({ root, files: ['absent.py'] }), /absent.py/);
});

test(
  'explicit selection supports header extensions, scripts, uppercase names and multiple input batches',
  nativeOnly,
  async (context) => {
    const { root, files, write } = fixture(context);
    function implementation(name) {
      return (
        'def ' +
        name +
        '(values):\n' +
        [
          '    total = 0',
          '    for value in values:',
          '        if value > 0:',
          '            total += value * 2',
          '    normalized = total + len(values)',
          '    return normalized',
        ].join('\n') +
        '\n'
      );
    }
    for (let i = 0; i < 401; i++) {
      const source = i === 0 || i === 400 ? implementation('calculate_' + i) : 'pass\n';
      write('job' + i + '.py', source);
    }
    write('MODULE.PY', 'pass\n');
    write('driver.h', 'int read_count(void);\n');
    for (const extension of ['cc', 'cxx', 'hh', 'hpp', 'hxx']) write('decl.' + extension, 'class Job {};\n');
    write('script.kts', 'val enabled = true\n');
    const { findings, languageCounts } = await analyzePolyglot({ root, files });
    assert.equal(findings.length, 1);
    assert.equal(findings[0].ruleId, 'duplicate-implementation');
    assert.deepEqual(languageCounts, { Python: 402, C: 1, 'C++': 5, Kotlin: 1 });
  },
);
