import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import type { Statement } from 'typescript';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { applyChangesToText, applyFix } from '../../lib/maintainability/apply-fix.js';
import type { Finding, FindingFix, FixChange } from '../../lib/shared/types.js';
import type { FunctionWithBody } from '../../lib/maintainability/types/site-fix-nodes.js';
import type { FileMap } from '../types/project-files.js';
import { parseReport } from '../types/cli-report.js';
import { fixOf } from '../types/finding-fix.js';
import { fixNoteOf } from '../types/fix-note.js';
import { evaluateCommonJs as load, type EvaluatedFunction } from '../types/evaluated-module.js';
import { extractionEdit, ownStatements } from '../../lib/maintainability/site-fixes/extract-block.js';
interface DayComparer {
  sameDay(first: string, second: string): boolean;
}

interface GroupIndexModule {
  index(groups: unknown, seen: Set<number>): Iterable<unknown>;
}

interface GroupIndex {
  seen: Set<number>;
  build(groups: unknown): Iterable<unknown>;
}

const cli = path.join(import.meta.dirname, '../../bin/loadwise.js');

function project(context: TestContext, files: FileMap) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'maintainability-fix-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(directory, name)), { recursive: true });
    fs.writeFileSync(path.join(directory, name), content);
  }
  return directory;
}

function run(directory: string, ...args: string[]) {
  return spawnSync(process.execPath, [cli, 'maint', ...args], { cwd: directory, encoding: 'utf8' });
}

function findingsOf(directory: string): Finding[] {
  const result = run(directory, '--json', '--include-contextual');
  assert.equal(result.status, 0, result.stderr);
  return parseReport(result.stdout).findings;
}

function fixedFiles(directory: string, fix: FindingFix): Record<string, string> {
  const files: Record<string, string> = {};
  const access = {
    readFile: (file: string) => fs.readFileSync(path.join(directory, file), 'utf8'),
    writeFile: (file: string, text: string) => (files[file] = text),
  };
  const result = applyFix(fix, access);
  assert.equal(result.error, undefined);
  return files;
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
  assert.match(
    change.after,
    /^ {4}\/\/ Loadwise deep-control-flow: .*\n {4}\/\/ .*\n {4}if \(!row\.active\) continue;\n {4}for \(const tag of row\.tags\) \{/,
  );
  const rewritten = load(fixedFiles(directory, fixOf(finding))['collect.cjs']).collect;
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
    fixOf(finding).changes[0].after,
    /if \(\(flag \|\| item\.forced\) && item\.value > 1\) total \+= item\.value;/,
  );
  const rewritten = load(fixedFiles(directory, fixOf(finding))['pick.cjs']).pick;
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
  const files = fixedFiles(directory, fixOf(finding));
  assert.doesNotMatch(files['label.cjs'], /else/);
  const rewritten = load(files['label.cjs']).label;
  const original = load(source).label;
  for (const values of [[], [1, -1, 2], [0]])
    for (const mode of ['loud', 'quiet']) assert.equal(rewritten(values, mode), original(values, mode));
});

test('deep-control-flow rewrites no if that would need intent, and extracts the loop instead', (context) => {
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
  assert.match(fixNoteOf(fixOf(finding)), /^Moves the innermost levels into processCell/);
  const text = fixedFiles(directory, fixOf(finding))['scan.cjs'];
  assert.match(text, /\n {6}hits = processCell\(cell, hits\);\n/);
  const grid = [[[1, 0, 2], []], [[0]]];
  assert.equal(load(text).scan(grid), load(source).scan(grid));
});

test('combining matching conditional labels preserves evaluation order and short circuiting', (context) => {
  const source = [
    'module.exports = function status(first, second, fallback, flags) {',
    ...Array.from({ length: 12 }, (_, index) => `  if (flags[${index}]) Math.abs(${index});`),
    '  return (first() ?? fallback()) ? "ready" : (second() ? "ready" : "pending");',
    '};',
  ].join('\n');
  const directory = project(context, { 'status.cjs': source });
  const [finding] = ruleFindings(directory, 'high-branch-complexity');
  assert.ok(finding.fix && !finding.fix.requiresReview);
  const updated = fixedFiles(directory, fixOf(finding))['status.cjs'];
  assert.match(updated, /\(first\(\) \?\? fallback\(\)\) \|\| second\(\) \? "ready" : "pending"/);
  function evaluate(text: string, values: unknown[]) {
    const calls: number[] = [];
    const functions = values.map((value, index: number) => () => {
      calls.push(index);
      return value;
    });
    return [load<EvaluatedFunction>(text)(...functions, []), calls];
  }
  for (const values of [
    [true, false, null],
    [0, true, 1],
    [null, false, 1],
    [undefined, null, false],
  ])
    assert.deepEqual(evaluate(updated, values), evaluate(source, values));
  for (const branch of ['"other"', '/* keep */ "ready"', 'getLabel()']) {
    const different = source.replace('second() ? "ready"', 'second() ? ' + branch);
    fs.writeFileSync(path.join(directory, 'status.cjs'), different);
    const [remaining] = ruleFindings(directory, 'high-branch-complexity');
    assert.ok(!remaining.fix || fixedFiles(directory, remaining.fix)['status.cjs'].includes('second() ? ' + branch));
  }
});

test('high-branch-complexity fix applies every exact simplification and reports the new complexity', (context) => {
  const source = [
    'function score(input) {',
    '  let points = 0;',
    '  const record = input;',
    '  if (!record.name) record.name = "anonymous";',
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
  assert.match(fixNoteOf(fixOf(finding)), /from 17 to 14\./);
  const text = fixedFiles(directory, fixOf(finding))['score.cjs'];
  assert.match(text, /record\.name \|\|= "anonymous";/);
  assert.match(text, /if \(input\.blocked \|\| input\.deleted\) return -1;/);
  assert.match(text, /const verified = !!input\.email;/);
  const rewritten = load(text).score;
  const original = load(source).score;
  for (const input of [{ level: 3, email: 'x' }, { blocked: true }, { deleted: 1, name: 'n' }, { level: 10 }]) {
    const first = { ...input };
    const second = { ...input };
    assert.equal(rewritten(first), original(second));
    assert.deepEqual(first, second);
  }
});

test('literal cases that repeat the default preserve decoding and its side effects', (context) => {
  const source = [
    'function decode(input) {',
    '  const character = input.value;',
    '  let decoded = "";',
    '  let consumed = 0;',
    '  if (character === "x") {',
    '    decoded += "x";',
    '    consumed += 2;',
    '  } else if (character === "y") {',
    '    decoded += "y";',
    '    consumed += 2;',
    '  } else if (character === "n") {',
    '    decoded += "\\n";',
    '    consumed += 2;',
    '  } else {',
    '    decoded += character;',
    '    consumed += 2;',
    '  }',
    ...Array.from({ length: 11 }, (_, index) => `  if (consumed === ${index + 5}) Math.abs(${index});`),
    '  return [decoded, consumed];',
    '}',
    'module.exports = { decode };',
  ].join('\n');
  const directory = project(context, { 'decode.cjs': source });
  const [finding] = ruleFindings(directory, 'high-branch-complexity');
  const rewritten = fixedFiles(directory, fixOf(finding))['decode.cjs'];
  assert.doesNotMatch(rewritten, /character === "[xy]"/);
  assert.match(rewritten, /if \(character === "n"\)/);
  for (const value of ['x', 'y', 'n', 'z', undefined]) {
    let reads = 0;
    const input = {
      get value() {
        reads++;
        return value;
      },
    };
    assert.deepEqual(load(rewritten).decode(input), load(source).decode(input));
    assert.equal(reads, 2);
  }
  for (const unsafe of [
    source.replace('const character', 'let character'),
    source.replace('else if (character === "n")', 'else if (input.value === "n")'),
    source.replace('else if (character === "n")', 'else if (character === "x")'),
    source.replace('    decoded += "x";', '    /* keep this explanation */ decoded += "x";'),
    source.replace('    decoded += "x";', '    decoded += "X";'),
  ]) {
    fs.writeFileSync(path.join(directory, 'decode.cjs'), unsafe);
    const [remaining] = ruleFindings(directory, 'high-branch-complexity');
    const text = remaining.fix ? fixedFiles(directory, remaining.fix)['decode.cjs'] : unsafe;
    assert.match(text, /character === "x"/);
  }
});

test('branch rewrites preserve a getter that rebinds its receiver and native boolean coercion', (context) => {
  const source = [
    'function update(value, Boolean) {',
    '  const replacement = {};',
    '  let current = { get name() { current = replacement; return ""; } };',
    '  if (!current.name) current.name = "assigned";',
    '  const active = value ? true : false;',
    '  let selected = "";',
    '  const scope = { get selected() { delete this.selected; return ""; } };',
    '  with (scope) {',
    '    if (!selected) selected = "assigned";',
    '  }',
    ...Array.from({ length: 13 }, (_, index) => `  if (value === ${index}) Math.abs(${index});`),
    '  return [replacement.name, selected, active];',
    '}',
    'module.exports = { update };',
  ].join('\n');
  const directory = project(context, { 'update.cjs': source });
  const [finding] = ruleFindings(directory, 'high-branch-complexity');
  const rewritten = fixedFiles(directory, fixOf(finding))['update.cjs'];
  assert.match(rewritten, /if \(!current\.name\) current\.name = "assigned"/);
  assert.match(rewritten, /if \(!selected\) selected = "assigned"/);
  for (const value of ['', 'truthy']) {
    const blocked = () => assert.fail('the original expression never calls Boolean');
    assert.deepEqual(load(rewritten).update(value, blocked), load(source).update(value, blocked));
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
  assert.ok(finding.fix.changes.every((change: FixChange) => change.file === 'usage.mjs'));
  const files = fixedFiles(directory, fixOf(finding));
  assert.match(files['usage.mjs'], /import \{ sameDay \} from '\.\/utils\/day';/);
  assert.match(files['usage.mjs'], /sameDay\(first, second\) \{\n {4}return sameDay\(first, second\);\n {2}\}/);
  // Node needs the extension; the fix follows the file's extensionless import style.
  fs.writeFileSync(path.join(directory, 'usage.mjs'), files['usage.mjs'].replace("'./utils/day'", "'./utils/day.mjs'"));
  const { Usage }: { Usage: new () => DayComparer } = await import(
    pathToFileURL(path.join(directory, 'usage.mjs')).href
  );
  const { sameDay }: { sameDay: DayComparer['sameDay'] } = await import(
    pathToFileURL(path.join(directory, 'utils/day.mjs')).href
  );
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
  assert.deepEqual(fixOf(finding).changes, [
    {
      file: 'a.ts',
      line: 1,
      before: "import { Shape } from './b';",
      after:
        '// Loadwise dependency-cycle: The shared piece moved out of the cycle, so the\n' +
        '// modules no longer import each other.\n' +
        "import type { Shape } from './b';",
    },
  ]);
});

test('apply refuses stale code, keeps line endings and never applies a fix twice', () => {
  const change = { file: 'f.ts', line: 2, before: 'if (a) {\n  b();\n}', after: 'if (!a) return;\nb();' };
  const text = 'function f(a) {\r\nif (a) {\r\n  b();\r\n}\r\n}';
  const applied = applyChangesToText(text, [change]);
  assert.equal(applied.text, 'function f(a) {\r\nif (!a) return;\r\nb();\r\n}');
  const shifted = applyChangesToText('x\n' + text, [change]);
  assert.ok(shifted.text !== undefined);
  assert.match(shifted.text, /if \(!a\) return;/);
  const stale = applyChangesToText(text.replace('b()', 'c()'), [change]);
  assert.ok(stale.error !== undefined);
  assert.match(stale.error, /changed since the scan/);
  const insertion = { file: 'f.ts', line: 1, before: 'one', after: 'zero\none' };
  const once = applyChangesToText('one\ntwo', [insertion]).text;
  assert.ok(once !== undefined);
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

function ruleFindings(directory: string, ruleId: string) {
  return findingsOf(directory).filter((item) => item.ruleId === ruleId);
}

test('deep-control-flow guard clause drops the jump it would leave unreachable', (context) => {
  const source = [
    'function grace(stored, strict) {',
    '  if (stored) {',
    '    stored.seen = true;',
    '    if (stored.active) {',
    '      if (!strict && stored.expires > 0) {',
    '        if (stored.user === null) return null;',
    '        return stored.user;',
    '      }',
    '      return null;',
    '    }',
    '  }',
    '  return "none";',
    '}',
    'module.exports = { grace };',
  ].join('\n');
  const directory = project(context, { 'grace.cjs': source });
  const [finding] = ruleFindings(directory, 'deep-control-flow');
  const text = fixedFiles(directory, fixOf(finding))['grace.cjs'];
  assert.match(text, /if \(strict \|\| !\(stored\.expires > 0\)\) return null;\n {6}if \(stored\.user === null\)/);
  assert.match(text, /return stored\.user;\n {4}\}\n {2}\}/, 'the unreachable return null is removed');
  const rewritten = load(text).grace;
  const original = load(source).grace;
  const inputs = [null, { active: false }, { active: true, expires: 1, user: 'u' }, { active: true, expires: 0 }];
  for (const stored of inputs)
    for (const strict of [true, false])
      assert.equal(rewritten(stored && { ...stored }, strict), original(stored && { ...stored }, strict));
});

test('a guard keeps the fallback only when the hoisted try or catch can reach it', (context) => {
  const source = [
    'function parse(value, type) {',
    '  switch (type) {',
    '    case "json":',
    '    case "array": {',
    '      if (typeof value === "string") {',
    '        try {',
    '          return JSON.parse(value);',
    '        } catch {',
    '          // A comma-separated list is also accepted for arrays.',
    '          if (type === "array") {',
    '            return value',
    '              .split(",")',
    '              .map((part) => part.trim())',
    '              .filter((part) => part.length > 0);',
    '          }',
    '          return null;',
    '        }',
    '      }',
    '      return Array.isArray(value) ? value : false;',
    '    }',
    '  }',
    '}',
    'module.exports = { parse };',
  ].join('\n');
  const fallback = 'return Array.isArray(value) ? value : false;';
  const parseVariants: [string, number][] = [
    [source, 1],
    [source.replace('          return null;', ''), 2],
  ];
  for (const [variant, expected] of parseVariants) {
    const root = project(context, { 'parse.cjs': variant });
    const [finding] = ruleFindings(root, 'deep-control-flow');
    const rewritten = fixedFiles(root, fixOf(finding))['parse.cjs'];
    assert.match(rewritten, /if \(typeof value !== "string"\) return Array/);
    assert.equal(rewritten.split(fallback).length - 1, expected);
    const original = load(variant).parse;
    const modified = load(rewritten).parse;
    for (const type of ['array', 'json'])
      for (const value of ['[2]', 'a,b', [3], null]) assert.deepEqual(modified(value, type), original(value, type));
  }
});

test('a guard cannot move fallback evaluation inside an enclosing try', (context) => {
  const source = [
    'function visit(enabled, groups, fallback) {',
    '  try {',
    '    if (enabled) {',
    '      for (const group of groups) {',
    '        for (const item of group) {',
    '          if (item.active) item.seen = true;',
    '        }',
    '      }',
    '    }',
    '  } catch {',
    '    return "caught";',
    '  }',
    '  return fallback();',
    '}',
    'module.exports = { visit };',
  ].join('\n');
  const root = project(context, { 'visit.cjs': source });
  const [finding] = ruleFindings(root, 'deep-control-flow');
  const rewritten = finding.fix ? fixedFiles(root, fixOf(finding))['visit.cjs'] : source;
  assert.throws(
    () =>
      load(rewritten).visit(false, [], () => {
        throw Error('outside the catch');
      }),
    /outside the catch/,
  );
});

test('negated guard conditions use De Morgan instead of a double negation', (context) => {
  const source = [
    'function fill(rows, names) {',
    '  for (const row of rows) {',
    '    row.seen = true;',
    '    for (const key of row.keys) {',
    '      row.count = (row.count ?? 0) + 1;',
    '      if (!(key in names) && key in row) {',
    '        row.found = key;',
    '        if (row[key]) row.truthy = key;',
    '      }',
    '    }',
    '  }',
    '}',
    'module.exports = { fill };',
  ].join('\n');
  const directory = project(context, { 'fill.cjs': source });
  const [finding] = ruleFindings(directory, 'deep-control-flow');
  const text = fixedFiles(directory, fixOf(finding))['fill.cjs'];
  assert.doesNotMatch(text, /!\(!/);
  assert.match(text, /if \(key in names \|\| !\(key in row\)\) continue;/);
  const rows = () => [{ keys: ['a', 'b', 'c'], b: 1, c: 0 }, { keys: [] }];
  const names = { a: 1 };
  const expected = rows();
  const actual = rows();
  load(source).fill(expected, names);
  load(text).fill(actual, names);
  assert.deepEqual(actual, expected);
});

test('high-branch-complexity groups && inside || and withholds merged conditions that read worse', (context) => {
  const long = 'input.someRatherLongPropertyName.anotherFairlyLongPropertyName';
  const source = [
    'function check(input) {',
    '  if (input.kind === 1 && input.flag) return 0;',
    '  if (input.kind === 2) return 0;',
    '  input.step = 1;',
    `  if (${long} === 1) return 1;`,
    `  if (${long} === 2) return 1;`,
    ...Array.from({ length: 13 }, (_, index) => `  if (input.level === ${index}) input.step += ${index};`),
    '  return input.step;',
    '}',
    'module.exports = { check };',
  ].join('\n');
  const directory = project(context, { 'check.cjs': source });
  const [finding] = ruleFindings(directory, 'high-branch-complexity');
  assert.match(fixNoteOf(fixOf(finding)), /from 18 to 17\./);
  const text = fixedFiles(directory, fixOf(finding))['check.cjs'];
  assert.match(text, /if \(\(input\.kind === 1 && input\.flag\) \|\| input\.kind === 2\) return 0;/);
  assert.match(text, /=== 1\) return 1;\n {2}if \(input\.someRatherLong/, 'the over-long merge is withheld');
});

const nestedGroups = [
  'function index(groups, seen) {',
  '  const result = new Map();',
  '  for (const group of groups) {',
  '    if (group.enabled) {',
  '      for (const member of group.members) {',
  '        if (!seen.has(member.id)) {',
  '          result.set(member.id, group.name);',
  '        }',
  '      }',
  '      result.set(group.name, group.members.length);',
  '    }',
  '    result.set("last", group.name);',
  '  }',
  '  return result;',
  '}',
  'module.exports = { index };',
  '',
].join('\n');

const groups = [
  { enabled: true, name: 'a', members: [{ id: 1 }, { id: 2 }] },
  { enabled: false, name: 'b', members: [{ id: 3 }] },
  { enabled: true, name: 'c', members: [{ id: 2 }, { id: 4 }] },
];

test('deep-control-flow moves a self-contained inner loop into a function declared after its own', (context) => {
  const directory = project(context, { 'index.cjs': nestedGroups });
  const [finding] = ruleFindings(directory, 'deep-control-flow');
  assert.match(fixNoteOf(fixOf(finding)), /processMembers/);
  const text = fixedFiles(directory, fixOf(finding))['index.cjs'];
  assert.match(text, /\n {6}processMembers\(group, seen, result\);\n {6}result\.set\(group\.name/);
  assert.match(
    text,
    /\n {2}return result;\n\}\n\nfunction processMembers\(group, seen, result\) \{\n {2}for \(const member of group\.members\) \{\n {4}if/,
  );
  assert.match(text, /\n {2}\}\n\}\nmodule\.exports/);
  const seen = new Set([2]);
  assert.deepEqual(
    [...load<GroupIndexModule>(text).index(groups, seen)],
    [...load<GroupIndexModule>(nestedGroups).index(groups, seen)],
  );
  fs.writeFileSync(path.join(directory, 'index.cjs'), text);
  assert.equal(ruleFindings(directory, 'deep-control-flow').length, 0);
});

test('the extracted function keeps CRLF line endings and tab indentation', (context) => {
  const source = nestedGroups
    .replaceAll(/^( {2})+/gm, (spaces) => '\t'.repeat(spaces.length / 2))
    .replaceAll('\n', '\r\n');
  const directory = project(context, { 'index.cjs': source });
  const [finding] = ruleFindings(directory, 'deep-control-flow');
  const text = fixedFiles(directory, fixOf(finding))['index.cjs'];
  assert.doesNotMatch(text, /[^\r]\n/);
  assert.match(text, /\r\n\t{3}processMembers\(group, seen, result\);\r\n/);
  assert.match(text, /\r\n\r\nfunction processMembers\(group, seen, result\) \{\r\n\tfor /);
  assert.deepEqual(
    [...load<GroupIndexModule>(text).index(groups, new Set())],
    [...load<GroupIndexModule>(source).index(groups, new Set())],
  );
});

test('a class method gets a private-style method called through this', (context) => {
  const source = [
    'class Index {',
    '  build(groups) {',
    '    const result = new Map();',
    '    for (const group of groups) {',
    '      if (group.enabled) {',
    '        for (const member of group.members) {',
    '          if (!this.seen.has(member.id)) {',
    '            result.set(member.id, group.name);',
    '          }',
    '        }',
    '        result.set(group.name, group.members.length);',
    '      }',
    '      result.set("last", group.name);',
    '    }',
    '    return result;',
    '  }',
    '}',
    'module.exports = { Index };',
  ].join('\n');
  const directory = project(context, { 'index.cjs': source });
  const [finding] = ruleFindings(directory, 'deep-control-flow');
  const text = fixedFiles(directory, fixOf(finding))['index.cjs'];
  assert.match(text, /\n {8}this\.processMembers\(group, result\);\n/);
  assert.match(text, /\n {2}\}\n\n {2}processMembers\(group, result\) \{\n {4}for \(const member/);
  const run = (code: string) => {
    const index = new (load<{ Index: new () => GroupIndex }>(code).Index)();
    index.seen = new Set([2]);
    return [...index.build(groups)];
  };
  assert.deepEqual(run(text), run(source));
});

test('no extraction when the block returns, awaits, leaves an outer loop or is one line', (context) => {
  const variants = {
    'returns.cjs': nestedGroups.replace('result.set(member.id, group.name);', 'return result;'),
    'awaits.cjs': nestedGroups
      .replace('function index', 'async function index')
      .replace('result.set(member.id, group.name);', 'await result.set(member.id, group.name);'),
    'outer.cjs': nestedGroups
      .replace('  for (const group of groups) {', '  outer: for (const group of groups) {')
      .replace('result.set(member.id, group.name);', 'continue outer;'),
    'short.cjs': nestedGroups.replace(
      /for \(const member of group\.members\) \{\n.*\n.*\n.*\n {6}\}/,
      'for (const member of group.members) if (!seen.has(member.id)) if (member) result.set(member.id, 1);',
    ),
  };
  const directory = project(context, variants);
  const findings = ruleFindings(directory, 'deep-control-flow');
  assert.deepEqual(findings.map((finding: Finding) => finding.file).sort(), Object.keys(variants).sort());
  for (const finding of findings) assert.equal(finding.fix, undefined, finding.file ?? 'finding without a file');
});

test('no extraction with more than four parameters, a reassigned parameter or one a closure shares', (context) => {
  const variants = {
    'many.cjs': nestedGroups
      .replace('function index(groups, seen) {', 'function index(groups, seen, first, second) {')
      .replace('result.set(member.id, group.name);', 'result.set(member.id, [group.name, first, second]);'),
    'reassigned.cjs': nestedGroups.replace(
      'result.set(member.id, group.name);',
      'result.set(member.id, group.name);\n          seen = new Set();',
    ),
    'two-lets.cjs': nestedGroups
      .replace('  const result = new Map();', '  const result = new Map();\n  let count = 0;\n  let last;')
      .replace('result.set(member.id, group.name);', 'count++;\n          last = member;'),
    'closure.cjs': nestedGroups
      .replace(
        '  const result = new Map();',
        '  const result = new Map();\n  let count = 0;\n  const bump = () => count++;',
      )
      .replace('result.set(member.id, group.name);', 'count += bump();'),
  };
  const directory = project(context, variants);
  const findings = ruleFindings(directory, 'deep-control-flow');
  assert.deepEqual(findings.map((finding: Finding) => finding.file).sort(), Object.keys(variants).sort());
  for (const finding of findings) assert.equal(finding.fix, undefined, finding.file ?? 'finding without a file');
});

const typedGroups = (guard: string, use: string) =>
  [
    "import { lookup } from './lookup';",
    'type Group = { enabled: boolean; members: { id: string }[] };',
    'export class Tally {',
    '  current?: { name: string | null };',
    '  run(groups: Group[], out: Map<string, string>) {',
    `    ${guard}`,
    '    for (const group of groups) {',
    '      if (group.enabled) {',
    '        for (const member of group.members) {',
    '          if (member.id) {',
    `            out.set(member.id, ${use});`,
    '          }',
    "          out.set('member', member.id);",
    '        }',
    "        out.set('group', 'seen');",
    '      }',
    "      out.set('last', 'seen');",
    '    }',
    '  }',
    '}',
    '',
  ].join('\n');

const lookupModule = 'export function lookup(key: string): string {\n  return key;\n}\n';

test('bulk fix applies an ambiguous hunk at the row an earlier edit of the run moved it to', (context) => {
  const first = typedGroups('const name = this.current?.name;\n    if (!name) return;', 'name');
  const second = first.slice(first.indexOf('export class')).replace('class Tally', 'class Summary');
  const directory = project(context, { 'tally.ts': first + second, 'lookup.ts': lookupModule });
  // The extraction needs individual review, so both fixes are chosen by id.
  const ids = ruleFindings(directory, 'deep-control-flow').map(({ id }) => id);
  const fixed = run(directory, '--fix', '--only', ids.join(','));
  assert.equal(fixed.status, 0, fixed.stderr || fixed.stdout);
  assert.match(fixed.stdout, /Applied 2 of 2 chosen fix\(es\)/);
  assert.deepEqual(ruleFindings(directory, 'deep-control-flow'), []);
  const file = path.join(directory, 'tally.ts');
  assert.deepEqual(typeErrors(file, fs.readFileSync(file, 'utf8')), []);
});

function typeErrors(file: string, text: string) {
  const host = ts.createCompilerHost({});
  const readFile = host.readFile;
  host.readFile = (name) => (path.resolve(name) === path.resolve(file) ? text : readFile(name));
  const options = { strict: true, noEmit: true, target: ts.ScriptTarget.ES2022 };
  const program = ts.createProgram({ rootNames: [file], options, host });
  return ts
    .getPreEmitDiagnostics(program)
    .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
}

test('TypeScript extraction makes a private method with the narrowed parameter types', (context) => {
  const source = typedGroups('const name = this.current?.name;\n    if (!name) return;', 'name');
  const directory = project(context, { 'tally.ts': source, 'lookup.ts': lookupModule });
  assert.deepEqual(typeErrors(path.join(directory, 'tally.ts'), source), []);
  const [finding] = ruleFindings(directory, 'deep-control-flow');
  const text = fixedFiles(directory, fixOf(finding))['tally.ts'];
  assert.match(text, /\n {8}this\.processMembers\(group, out, name\);\n/);
  assert.match(text, /\n {2}private processMembers\(group: Group, out: Map<string, string>, name: string\) \{\n/);
  assert.deepEqual(typeErrors(path.join(directory, 'tally.ts'), text), []);
});

test('no TypeScript extraction when it would lose narrowing or a type cannot be written', (context) => {
  const variants: Record<string, string> = {
    'path.ts': typedGroups('if (!this.current?.name) return;', 'this.current.name'),
    'unknown.ts': typedGroups('const name = lookup("name") as any;', 'name'),
  };
  const directory = project(context, { ...variants, 'lookup.ts': lookupModule });
  for (const file of Object.keys(variants)) {
    assert.deepEqual(typeErrors(path.join(directory, file), variants[file]), []);
    const [finding] = ruleFindings(directory, 'deep-control-flow').filter((item) => item.file === file);
    assert.equal(finding.fix, undefined, file);
  }
});

test('high-branch-complexity returns the one outer let a moved block updates', (context) => {
  const source = [
    'function settle(order, rules) {',
    '  let total = 0;',
    ...Array.from({ length: 13 }, (_, index) => `  if (order.level === ${index}) total += ${index};`),
    '  for (const rule of rules) {',
    '    if (rule.on) {',
    '      total += rule.value;',
    '    }',
    '  }',
    '  return total;',
    '}',
    'module.exports = { settle };',
  ].join('\n');
  const directory = project(context, { 'settle.cjs': source });
  const [finding] = ruleFindings(directory, 'high-branch-complexity');
  assert.match(fixNoteOf(fixOf(finding)), /from 16 to 14\. Moves a self-contained block into processRules/);
  const text = fixedFiles(directory, fixOf(finding))['settle.cjs'];
  assert.match(text, /\n {2}total = processRules\(rules, total\);\n {2}return total;/);
  assert.match(text, /\nfunction processRules\(rules, total\) \{\n[^]*\n {2}return total;\n\}/);
  const rules = [
    { on: true, value: 5 },
    { on: false, value: 7 },
  ];
  for (const level of [0, 4, 20])
    assert.equal(load(text).settle({ level }, rules), load(source).settle({ level }, rules));
  fs.writeFileSync(path.join(directory, 'settle.cjs'), text);
  assert.equal(ruleFindings(directory, 'high-branch-complexity').length, 0);
});

function isFunctionWithBody(node: Statement): node is Statement & FunctionWithBody {
  return ts.isFunctionDeclaration(node) && node.body !== undefined;
}

test('no TypeScript extraction when a parameter would be typed {} or unknown', () => {
  const variants = {
    'empty.ts': [
      "import { Doc } from './doc';",
      'export function collect(doc: Doc, out: string[]) {',
      '  for (const response of Object.values(doc.responses ?? {})) {',
      "    if (!response || '$ref' in response) continue;",
      '    for (const media of Object.values(response.content ?? {})) {',
      '      out.push(media.example);',
      '      out.push(media.schema);',
      '      out.push(media.other);',
      '    }',
      '  }',
      '}',
    ],
    'caught.ts': [
      "import { z } from 'zod';",
      'export function collect(input: string, out: string[]) {',
      '  try {',
      '    JSON.parse(input);',
      '  } catch (error) {',
      '    if (error instanceof z.ZodError) {',
      '      for (const issue of error.issues) {',
      '        out.push(issue.message);',
      '        out.push(issue.path);',
      '      }',
      '    }',
      '  }',
      '}',
    ],
  };
  for (const [file, lines] of Object.entries(variants)) {
    const sourceFile = ts.createSourceFile(file, lines.join('\n'), ts.ScriptTarget.Latest, true);
    const fn = sourceFile.statements.find(isFunctionWithBody);
    assert.ok(fn);
    for (const statement of ownStatements(fn)) {
      const extraction = extractionEdit(statement, fn, sourceFile);
      assert.doesNotMatch(extraction?.edits[1].text ?? '', /\((response|error|media): (\{\}|unknown)/, file);
    }
  }
});

test('extracted block names drop the is or has of a boolean condition', (context) => {
  const source = [
    'function collect(file, out) {',
    ...Array.from({ length: 13 }, (_, index) => `  if (file.level === ${index}) out.push(${index});`),
    '  if (file.isDeclarationFile) {',
    '    for (const reference of file.references) {',
    '      if (reference) out.push(reference);',
    '    }',
    '  }',
    '  return out;',
    '}',
    'module.exports = { collect };',
  ].join('\n');
  const directory = project(context, { 'collect.cjs': source });
  const [finding] = ruleFindings(directory, 'high-branch-complexity');
  assert.match(fixNoteOf(fixOf(finding)), /into handleDeclarationFile/);
});

const batchLines = [
  'function batchLines(groups, blocked) {',
  '  const lines = [];',
  '  for (const group of groups) {',
  '    for (const batch of group.batches) {',
  '      const names = [];',
  '      for (const member of batch) {',
  '        if (!blocked.has(member.id)) {',
  '          names.push(member.name);',
  '        }',
  '      }',
  "      lines.push(group.name + ':' + names.join(','));",
  '    }',
  '  }',
  '  return lines;',
  '}',
  'module.exports = { batchLines };',
  '',
].join('\n');

const namedGroups = [
  { name: 'a', batches: [[{ id: 1, name: 'x' }], [{ id: 2, name: 'y' }]] },
  { name: 'b', batches: [[{ id: 3, name: 'z' }]] },
  {
    name: 'c',
    batches: [
      [
        { id: 2, name: 'w' },
        { id: 4, name: 'v' },
      ],
    ],
  },
];

test('an extracted loop that only fills the collection declared above creates and returns it', (context) => {
  const directory = project(context, { 'lines.cjs': batchLines });
  const [finding] = ruleFindings(directory, 'deep-control-flow');
  assert.match(fixNoteOf(fixOf(finding)), /buildNames/);
  const text = fixedFiles(directory, fixOf(finding))['lines.cjs'];
  assert.match(text, /\n {6}const names = buildNames\(batch, blocked\);\n {6}lines\.push/);
  assert.match(text, /\nfunction buildNames\(batch, blocked\) \{\n {2}const names = \[\];\n {2}for \(const member/);
  assert.match(text, /\n {2}return names;\n\}\nmodule\.exports/);
  const blocked = new Set([2]);
  assert.deepEqual(load(text).batchLines(namedGroups, blocked), load(batchLines).batchLines(namedGroups, blocked));
  fs.writeFileSync(path.join(directory, 'lines.cjs'), text);
  assert.equal(ruleFindings(directory, 'deep-control-flow').length, 0);
});

test('an extracted loop that also changes another collection keeps passing the collections in', (context) => {
  const source = batchLines
    .replace('(groups, blocked) {', '(groups, blocked, audit) {')
    .replace('names.push(member.name);', 'names.push(member.name);\n          audit.push(member.id);');
  const directory = project(context, { 'lines.cjs': source });
  const [finding] = ruleFindings(directory, 'deep-control-flow');
  const text = fixedFiles(directory, fixOf(finding))['lines.cjs'];
  assert.doesNotMatch(text, /const names = build/);
  assert.match(text, /\n {6}processBatch\(/);
});
