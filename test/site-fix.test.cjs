'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');
const assert = require('node:assert/strict');
const test = require('node:test');
const { applyChangesToText, applyFix } = require('../lib/apply-fix.cjs');
const cli = path.join(__dirname, '../bin/maintainability-check.cjs');

function project(context, files) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'maintainability-fix-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(directory, name)), { recursive: true });
    fs.writeFileSync(path.join(directory, name), content);
  }
  return directory;
}

function run(directory, ...args) {
  return spawnSync(process.execPath, [cli, ...args], { cwd: directory, encoding: 'utf8' });
}

function findingsOf(directory) {
  const result = run(directory, '--json', '--include-contextual');
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout).findings;
}

function fixedFiles(directory, fix) {
  const files = {};
  const access = {
    readFile: (file) => fs.readFileSync(path.join(directory, file), 'utf8'),
    writeFile: (file, text) => (files[file] = text),
  };
  const result = applyFix(fix, access);
  assert.equal(result.error, undefined);
  return files;
}

// Loads CommonJS source text as a module, so the original and rewritten functions can be compared by running them.
function load(text) {
  const module = { exports: {} };
  new Function('module', 'exports', text)(module, module.exports);
  return module.exports;
}

const nestedLoops = [
  'function collect(rows, limit) {',
  '  const found = [];',
  '  for (const row of rows) {',
  '    if (row.active) {',
  '      for (const tag of row.tags) {',
  '        if (tag.length > limit) {',
  '          found.push(tag);',
  '        }',
  '      }',
  '    }',
  '  }',
  '  return found;',
  '}',
  'module.exports = { collect };',
  '',
].join('\n');

test('deep-control-flow fix turns the if that ends a loop body into a continue guard', (context) => {
  const directory = project(context, { 'collect.cjs': nestedLoops });
  const [finding] = findingsOf(directory).filter((item) => item.ruleId === 'deep-control-flow');
  assert.ok(finding.fix, 'expected a fix');
  const [change] = finding.fix.changes;
  assert.equal(change.file, 'collect.cjs');
  assert.match(change.after, /^ {4}if \(!row\.active\) continue;\n {4}for \(const tag of row\.tags\) \{/);
  const rewritten = load(fixedFiles(directory, finding.fix)['collect.cjs']).collect;
  const original = load(nestedLoops).collect;
  const rows = [
    { active: true, tags: ['a', 'long tag', 'xyz'] },
    { active: false, tags: ['ignored tag'] },
    { active: 1, tags: [] },
  ];
  for (const limit of [0, 2, 5]) assert.deepEqual(rewritten(rows, limit), original(rows, limit));
});

test('deep-control-flow fix merges an if whose only statement is another if', (context) => {
  const source = [
    'function pick(items, flag) {',
    '  let total = 0;',
    '  for (const item of items) {',
    '    if (item) {',
    '      if (flag || item.forced) {',
    '        if (item.value > 1) total += item.value;',
    '      }',
    '    }',
    '    total += 1;',
    '  }',
    '  return total;',
    '}',
    'module.exports = { pick };',
  ].join('\n');
  const directory = project(context, { 'pick.cjs': source });
  const [finding] = findingsOf(directory).filter((item) => item.ruleId === 'deep-control-flow');
  assert.match(
    finding.fix.changes[0].after,
    /if \(\(flag \|\| item\.forced\) && item\.value > 1\) total \+= item\.value;/,
  );
  const rewritten = load(fixedFiles(directory, finding.fix)['pick.cjs']).pick;
  const original = load(source).pick;
  const items = [null, { value: 3 }, { value: 1, forced: true }, { value: 5, forced: true }];
  for (const flag of [true, false]) assert.equal(rewritten(items, flag), original(items, flag));
});

test('deep-control-flow fix drops an else after a branch that already returns', (context) => {
  const source = [
    'function label(values, mode) {',
    '  if (!values.length) {',
    '    return "none";',
    '  } else {',
    '    let text = "";',
    '    for (const value of values) {',
    '      if (mode === "loud") {',
    '        text += "?";',
    '        if (value > 0) text += "!";',
    '      }',
    '      text += ".";',
    '    }',
    '    return text;',
    '  }',
    '}',
    'module.exports = { label };',
  ].join('\n');
  const directory = project(context, { 'label.cjs': source });
  const [finding] = findingsOf(directory).filter((item) => item.ruleId === 'deep-control-flow');
  const files = fixedFiles(directory, finding.fix);
  assert.doesNotMatch(files['label.cjs'], /else/);
  const rewritten = load(files['label.cjs']).label;
  const original = load(source).label;
  for (const values of [[], [1, -1, 2], [0]])
    for (const mode of ['loud', 'quiet']) assert.equal(rewritten(values, mode), original(values, mode));
});

test('deep-control-flow offers no fix when every rewrite would need intent', (context) => {
  const source = [
    'function scan(grid) {',
    '  let hits = 0;',
    '  for (const row of grid) {',
    '    for (const cell of row) {',
    '      for (const part of cell) {',
    '        if (part) hits++;',
    '      }',
    '    }',
    '  }',
    '  return hits;',
    '}',
    'module.exports = { scan };',
  ].join('\n');
  const directory = project(context, { 'scan.cjs': source });
  const [finding] = findingsOf(directory).filter((item) => item.ruleId === 'deep-control-flow');
  assert.equal(finding.fix, undefined);
});

test('high-branch-complexity fix applies every exact simplification and reports the new complexity', (context) => {
  const source = [
    'function score(input) {',
    '  let points = 0;',
    '  if (!input.name) input.name = "anonymous";',
    '  if (input.blocked) return -1;',
    '  if (input.deleted) return -1;',
    '  const verified = input.email ? true : false;',
    ...Array.from({ length: 11 }, (_, index) => `  if (input.level === ${index}) points += ${index};`),
    '  return points + (verified ? 1 : 0);',
    '}',
    'module.exports = { score };',
  ].join('\n');
  const directory = project(context, { 'score.cjs': source });
  const [finding] = findingsOf(directory).filter((item) => item.ruleId === 'high-branch-complexity');
  assert.match(finding.fix.note, /from 17 to 14\./);
  const text = fixedFiles(directory, finding.fix)['score.cjs'];
  assert.match(text, /input\.name \|\|= "anonymous";/);
  assert.match(text, /if \(input\.blocked \|\| input\.deleted\) return -1;/);
  assert.match(text, /const verified = Boolean\(input\.email\);/);
  const rewritten = load(text).score;
  const original = load(source).score;
  for (const input of [{ level: 3, email: 'x' }, { blocked: true }, { deleted: 1, name: 'n' }, { level: 10 }]) {
    const first = { ...input };
    const second = { ...input };
    assert.equal(rewritten(first), original(second));
    assert.deepEqual(first, second);
  }
});

test('duplicate-implementation fix makes the copy call the exported function', async (context) => {
  const shared = [
    'export function sameDay(first, second) {',
    '  const left = new Date(first);',
    '  const right = new Date(second);',
    '  return left.getUTCFullYear() === right.getUTCFullYear() && left.getUTCDate() === right.getUTCDate();',
    '}',
    '',
  ].join('\n');
  const service = [
    "import { strict } from 'node:assert';",
    '',
    'export class Usage {',
    '  sameDay(first, second) {',
    '    const left = new Date(first);',
    '    const right = new Date(second);',
    '    return left.getUTCFullYear() === right.getUTCFullYear() && left.getUTCDate() === right.getUTCDate();',
    '  }',
    '  check() {',
    '    strict.ok(this);',
    '  }',
    '}',
    '',
  ].join('\n');
  const directory = project(context, { 'utils/day.mjs': shared, 'usage.mjs': service });
  const [finding] = findingsOf(directory).filter((item) => item.ruleId === 'duplicate-implementation');
  assert.ok(finding.fix, 'expected a fix');
  assert.ok(finding.fix.changes.every((change) => change.file === 'usage.mjs'));
  const files = fixedFiles(directory, finding.fix);
  assert.match(files['usage.mjs'], /import \{ sameDay \} from '\.\/utils\/day';/);
  assert.match(files['usage.mjs'], /sameDay\(first, second\) \{\n {4}return sameDay\(first, second\);\n {2}\}/);
  // Node needs the extension; the fix follows the file's extensionless import style.
  fs.writeFileSync(path.join(directory, 'usage.mjs'), files['usage.mjs'].replace("'./utils/day'", "'./utils/day.mjs'"));
  const { Usage } = await import(pathToFileURL(path.join(directory, 'usage.mjs')));
  const { sameDay } = await import(pathToFileURL(path.join(directory, 'utils/day.mjs')));
  for (const [first, second] of [
    ['2024-01-01T01:00Z', '2024-01-01T23:00Z'],
    ['2024-01-01T01:00Z', '2024-01-02T01:00Z'],
  ])
    assert.equal(new Usage().sameDay(first, second), sameDay(first, second));
});

test('duplicate-implementation offers no fix when the copies read this', (context) => {
  const method = [
    '  total(items) {',
    '    let sum = this.base;',
    '    for (const item of items) sum += item.price * item.count;',
    '    return sum > this.limit ? this.limit : sum;',
    '  }',
  ];
  const directory = project(context, {
    'a.mjs': ['export class A {', ...method, '}', ''].join('\n'),
    'b.mjs': ['export class B {', ...method, '}', ''].join('\n'),
  });
  const [finding] = findingsOf(directory).filter((item) => item.ruleId === 'duplicate-implementation');
  assert.equal(finding.fix, undefined);
});

test('dependency-cycle fix turns a type-only import into import type', (context) => {
  const directory = project(context, {
    'tsconfig.json': JSON.stringify({ compilerOptions: { verbatimModuleSyntax: true } }),
    'a.ts': [
      "import { Shape } from './b';",
      'export const unit = 1;',
      'export const area = (shape: Shape) => shape.size * unit;',
      '',
    ].join('\n'),
    'b.ts': [
      "import { unit } from './a';",
      'export interface Shape { size: number }',
      'export const scale = unit * 2;',
      '',
    ].join('\n'),
  });
  const [finding] = findingsOf(directory).filter((item) => item.ruleId === 'dependency-cycle');
  assert.deepEqual(finding.fix.changes, [
    { file: 'a.ts', line: 1, before: "import { Shape } from './b';", after: "import type { Shape } from './b';" },
  ]);
});

test('apply refuses stale code, keeps line endings and never applies a fix twice', () => {
  const change = { file: 'f.ts', line: 2, before: 'if (a) {\n  b();\n}', after: 'if (!a) return;\nb();' };
  const text = 'function f(a) {\r\nif (a) {\r\n  b();\r\n}\r\n}';
  const applied = applyChangesToText(text, [change]);
  assert.equal(applied.text, 'function f(a) {\r\nif (!a) return;\r\nb();\r\n}');
  assert.match(applyChangesToText('x\n' + text, [change]).text, /if \(!a\) return;/);
  assert.match(applyChangesToText(text.replace('b()', 'c()'), [change]).error, /changed since the scan/);
  const insertion = { file: 'f.ts', line: 1, before: 'one', after: 'zero\none' };
  const once = applyChangesToText('one\ntwo', [insertion]).text;
  assert.equal(applyChangesToText(once, [insertion]).error, 'already applied');
});

test('text output shows the fix diff, and --fix --yes applies it', (context) => {
  const directory = project(context, { 'collect.cjs': nestedLoops });
  const text = run(directory);
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /Fix \(collect\.cjs:4\):/);
  assert.match(text.stdout, /\+ if \(!row\.active\) continue;/);

  const refused = run(directory, '--fix');
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /--fix --yes/);
  assert.equal(run(directory, '--yes').status, 2);
  assert.equal(run(directory, '--fix', '--json').status, 2);

  const fixed = run(directory, '--fix', '--yes');
  assert.equal(fixed.status, 0, fixed.stderr);
  assert.match(fixed.stdout, /Applied 1 of 1 automatic fix/);
  assert.match(fs.readFileSync(path.join(directory, 'collect.cjs'), 'utf8'), /if \(!row\.active\) continue;/);
  assert.equal(findingsOf(directory).length, 0);
});
