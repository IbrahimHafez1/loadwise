'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { applyChangesToText, applyFix } = require('../apply-fix.cjs');

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
    line: 4,
    before: '  const found = await repo.findOne(where);',
    after: '  const found = await repo.exists(where);',
  };
  const result = applyChangesToText(source.join('\r\n'), [change]);
  assert.equal(result.text, source.join('\r\n').replace('findOne', 'exists'));
});

test('a change still applies after lines were added above it', () => {
  const shifted = ['// added', '// added', ...source].join('\n');
  const change = { line: 4, before: '  const found = await repo.findOne(where);', after: '  const found = true;' };
  assert.equal(applyChangesToText(shifted, [change]).text, shifted.replace('await repo.findOne(where)', 'true'));
});

test('edited code refuses the stale fix instead of guessing', () => {
  const edited = source.join('\n').replace('findOne(where)', 'findOne(other)');
  const change = { line: 4, before: '  const found = await repo.findOne(where);', after: '  const found = true;' };
  assert.match(applyChangesToText(edited, [change]).error, /changed since the scan/);
});

test('an insertion that is already present is not inserted twice', () => {
  const entity = ['@Entity()', 'export class Order {}'].join('\n');
  const change = { line: 1, before: '@Entity()', after: "@Index(['status'])\n@Entity()" };
  const once = applyChangesToText(entity, [change]).text;
  assert.equal(once, "@Index(['status'])\n@Entity()\nexport class Order {}");
  assert.equal(applyChangesToText(once, [change]).error, 'already applied');
});

test('every file of a fix is checked before any file is written', () => {
  const files = new Map([
    ['a.ts', 'const one = 1;'],
    ['b.ts', 'const two = 2;'],
  ]);
  const writes = [];
  const fix = {
    changes: [
      { file: 'a.ts', line: 1, before: 'const one = 1;', after: 'const one = 10;' },
      { file: 'b.ts', line: 1, before: 'const two = 3;', after: 'const two = 20;' },
    ],
  };
  const result = applyFix(fix, { readFile: (file) => files.get(file), writeFile: (file) => writes.push(file) });
  assert.match(result.error, /^b\.ts: /);
  assert.deepEqual(writes, []);
});
