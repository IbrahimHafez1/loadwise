import assert from 'node:assert/strict';
import test from 'node:test';
import { applyChangesToText, applyFix } from '../apply-fix.cjs';

const source = [
  'import x from "y";',
  '',
  'async function load() {',
  '  const found = await repo.findOne(where);',
  '}',
  '',
];

test('a change replaces the original lines and keeps the file line endings', () => {
  const change = {
    file: 'source.ts',
    line: 4,
    before: '  const found = await repo.findOne(where);',
    after: '  const found = await repo.exists(where);',
  };
  const result = applyChangesToText(source.join('\r\n'), [change]);
  assert.equal(result.text, source.join('\r\n').replace('findOne', 'exists'));
});

test('a change still applies after lines were added above it', () => {
  const shifted = ['// added', '// added', ...source].join('\n');
  const change = {
    file: 'source.ts',
    line: 4,
    before: '  const found = await repo.findOne(where);',
    after: '  const found = true;',
  };
  assert.equal(applyChangesToText(shifted, [change]).text, shifted.replace('await repo.findOne(where)', 'true'));
});

test('edited code refuses the stale fix instead of guessing', () => {
  const edited = source.join('\n').replace('findOne(where)', 'findOne(other)');
  const change = {
    file: 'source.ts',
    line: 4,
    before: '  const found = await repo.findOne(where);',
    after: '  const found = true;',
  };
  assert.match(String(applyChangesToText(edited, [change]).error), /changed since the scan/);
});

test('a shifted fix with two matching source blocks asks for a rescan', () => {
  const change = { file: 'source.ts', line: 2, before: 'read();', after: 'await read();' };
  assert.match(String(applyChangesToText('read();\n// changed\nread();', [change]).error), /changed since the scan/);
});

test('a replacement beside the same rewritten line still applies to the flagged line', () => {
  const change = { file: 'source.ts', line: 2, before: 'read();', after: 'await read();' };
  assert.equal(applyChangesToText('await read();\nread();', [change]).text, 'await read();\nawait read();');
});

test('an insertion that is already present is not inserted twice', () => {
  const entity = ['@Entity()', 'export class Order {}'].join('\n');
  const change = { file: 'source.ts', line: 1, before: '@Entity()', after: "@Index(['status'])\n@Entity()" };
  const once = applyChangesToText(entity, [change]).text;
  assert.equal(once, "@Index(['status'])\n@Entity()\nexport class Order {}");
  assert.equal(applyChangesToText(once, [change]).error, 'already applied');
});

test('a change shared with an applied fix is skipped while the fix applies its other changes', () => {
  const helper = {
    file: 'source.ts',
    line: 2,
    before: 'async function ids() {}',
    after: 'async function ids() {}\nasync function idsMany() {}',
  };
  const call = { file: 'source.ts', line: 3, before: 'for (const x of xs) await ids(x);', after: 'await idsMany(xs);' };
  const applied = ['async function ids() {}', 'async function idsMany() {}', 'for (const x of xs) await ids(x);'];
  const result = applyChangesToText(applied.join('\n'), [helper, call]);
  assert.equal(result.text, [...applied.slice(0, 2), 'await idsMany(xs);'].join('\n'));
});

test('every file of a fix is checked before any file is written', () => {
  const files = new Map([
    ['a.ts', 'const one = 1;'],
    ['b.ts', 'const two = 2;'],
  ]);
  const writes: string[] = [];
  const fix = {
    changes: [
      { file: 'a.ts', line: 1, before: 'const one = 1;', after: 'const one = 10;' },
      { file: 'b.ts', line: 1, before: 'const two = 3;', after: 'const two = 20;' },
    ],
  };
  const result = applyFix(fix, { readFile: (file) => files.get(file), writeFile: (file) => writes.push(file) });
  assert.match(String(result.error), /^b\.ts: /);
  assert.deepEqual(writes, []);
});

test('a file that another fix already changed is skipped while the rest of the fix applies', () => {
  const files = new Map([
    ['helper.ts', 'export async function ids() {}\nexport async function idsMany() {}'],
    ['caller.ts', 'for (const x of xs) await ids(x);'],
  ]);
  const writes = new Map<string, string>();
  const fix = {
    changes: [
      {
        file: 'helper.ts',
        line: 1,
        before: 'export async function ids() {}',
        after: 'export async function ids() {}\nexport async function idsMany() {}',
      },
      { file: 'caller.ts', line: 1, before: 'for (const x of xs) await ids(x);', after: 'await idsMany(xs);' },
    ],
  };
  const result = applyFix(fix, {
    readFile: (file) => files.get(file),
    writeFile: (file, text: string) => writes.set(file, text),
  });
  assert.deepEqual(result.files, ['caller.ts']);
  assert.equal(writes.get('caller.ts'), 'await idsMany(xs);');
});

test('fixes that each add names to one import line compose in any order', () => {
  const original = "import { eq, sql } from 'drizzle-orm';";
  const file = [original, '', 'db.update(a);', 'db.update(b);'].join('\n');
  const addOrNe = {
    file: 'source.ts',
    line: 1,
    before: original,
    after: "import { eq, sql, or, ne } from 'drizzle-orm';",
  };
  const addNe = { file: 'source.ts', line: 1, before: original, after: "import { eq, sql, ne } from 'drizzle-orm';" };
  const first = applyChangesToText(file, [addOrNe]).text;
  assert.ok(first);
  assert.equal(applyChangesToText(first, [addNe]).error, 'already applied');
  const addedNe = applyChangesToText(file, [addNe]).text;
  assert.ok(addedNe);
  const reversed = applyChangesToText(addedNe, [addOrNe]).text;
  assert.ok(reversed);
  assert.equal(reversed.split('\n')[0], "import { eq, sql, ne, or } from 'drizzle-orm';");
});

test('an import merge never targets another module or an import missing the original names', () => {
  const original = "import { eq } from 'drizzle-orm';";
  const change = { file: 'source.ts', line: 1, before: original, after: "import { eq, ne } from 'drizzle-orm';" };
  assert.match(String(applyChangesToText("import { eq } from 'other';", [change]).error), /changed since the scan/);
  assert.match(
    String(applyChangesToText("import { sql } from 'drizzle-orm';", [change]).error),
    /changed since the scan/,
  );
});
