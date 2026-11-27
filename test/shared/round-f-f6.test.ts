import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { createWriteTracker, formatUpdates } from '../../lib/shared/fix-presentation.js';
import type { FixChange } from '../../lib/shared/types.js';

// A folder with no Prettier above it, so fixes keep the file's own style instead.
function projectWithoutPrettier(context: TestContext) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'loadwise-style-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

// Applies one change replacing rows `[row, row + removed)` of `before` with `afterRows`, without
// Prettier.
function styledChange(
  context: TestContext,
  before: string,
  row: number,
  removed: number,
  afterRows: readonly string[],
  fileName = 'run.ts',
) {
  const file = path.join(projectWithoutPrettier(context), fileName);
  const rows = before.split('\n');
  const after = [...rows.slice(0, row), ...afterRows, ...rows.slice(row + removed)].join('\n');
  const savedError = console.error;
  console.error = () => {};
  try {
    const { texts, hunks } = formatUpdates(path.dirname(file), [
      { file, before, after, hunks: [{ key: 'change', row, removed, added: afterRows.length }] },
    ]);
    return { text: texts.get(file) ?? after, hunk: hunks.get('change') };
  } finally {
    console.error = savedError;
  }
}

const noSemicolonTabs = [
  'import { load } from "./load"',
  'const first = load("a")',
  'const second = load("b")',
  'function run(items) {',
  '\tconst count = items.length',
  '\tif (count) {',
  '\t\tfirst.add(count)',
  '\t}',
  '\tconst result = []',
  '\tfor (const item of items) {',
  '\t\tresult.push(item)',
  '\t}',
  '\treturn result',
  '}',
  '',
].join('\n');

test('changed rows take the file semicolons, tabs and double quotes; unchanged rows and `before` stay', (context) => {
  const { text, hunk } = styledChange(context, noSemicolonTabs, 9, 3, [
    '\tconst seen = new Set();',
    '\tfor (const item of items) {',
    '\t  if (seen.has(item)) continue;',
    '\t  seen.add(item);',
    "\t  result.push(item + 'x');",
    '\t}',
  ]);
  assert.ok(hunk);
  assert.equal(
    hunk.after,
    [
      '\tconst seen = new Set()',
      '\tfor (const item of items) {',
      '\t\tif (seen.has(item)) continue',
      '\t\tseen.add(item)',
      '\t\tresult.push(item + "x")',
      '\t}',
    ].join('\n'),
  );
  assert.equal(hunk.before, '\tfor (const item of items) {\n\t\tresult.push(item)\n\t}');
  assert.ok(text.startsWith(noSemicolonTabs.split('\n').slice(0, 9).join('\n')));
});

test('a semicolon stays where the next line could continue the statement', (context) => {
  const { hunk } = styledChange(context, noSemicolonTabs, 12, 1, [
    '\tconst copy = result;',
    '\tcopy.push(1);',
    '\t[copy].pop()',
    '\treturn copy',
  ]);
  assert.ok(hunk);
  assert.equal(hunk.after, '\tconst copy = result\n\tcopy.push(1);\n\t[copy].pop()\n\treturn copy');
});

test('a semicolon file gets the semicolons a fix left out, and 4-space nesting', (context) => {
  const before = [
    "const first = load('a');",
    'function run(items) {',
    '    const result = [];',
    '    if (items) {',
    '        result.push(items);',
    '    }',
    '    return result;',
    '}',
    '',
  ].join('\n');
  const { hunk } = styledChange(context, before, 6, 1, [
    '    if (!result.length) {',
    '      return []',
    '    }',
    '    return result;',
  ]);
  assert.ok(hunk);
  assert.equal(hunk.after, '    if (!result.length) {\n        return [];\n    }\n    return result;');
});

test('strings holding a quote, template text and comments keep their text; code inside a template follows the file', (context) => {
  const before = ['const first = "a"', 'const second = "b"', 'const other = "e"', 'const third = "c"', ''].join('\n');
  const { hunk } = styledChange(context, before, 3, 1, [
    "const third = 'it\"s' + `a 'x' ${'b'}` // 'c';",
    "const fourth = 'd'",
  ]);
  assert.ok(hunk);
  assert.equal(hunk.after, "const third = 'it\"s' + `a 'x' ${\"b\"}` // 'c';\nconst fourth = \"d\"");
});

test('a file without a clear style is left as the fix wrote it', (context) => {
  const before = ['const first = "a";', "const second = 'b'", ''].join('\n');
  const { hunk } = styledChange(context, before, 1, 1, ["const second = 'b';"]);
  assert.equal(hunk, undefined);
});

test('the per-checker --fix keeps the file style of each written change', (context) => {
  const file = path.join(projectWithoutPrettier(context), 'run.js');
  const rows = noSemicolonTabs.split('\n');
  const changed = ['\tconst seen = new Set();', ...rows.slice(9, 12)];
  fs.writeFileSync(file, [...rows.slice(0, 9), ...changed, ...rows.slice(12)].join('\n'));
  const recorded: FixChange = { file, line: 10, before: rows.slice(9, 12).join('\n'), after: changed.join('\n') };
  const tracker = createWriteTracker();
  tracker.recordWrites([{ ...recorded, file, owner: recorded }]);
  const savedError = console.error;
  console.error = () => {};
  try {
    tracker.format(path.dirname(file));
  } finally {
    console.error = savedError;
  }
  assert.equal(recorded.after, ['\tconst seen = new Set()', ...rows.slice(9, 12)].join('\n'));
  assert.ok(fs.readFileSync(file, 'utf8').includes('\tconst seen = new Set()\n\tfor'));
});
