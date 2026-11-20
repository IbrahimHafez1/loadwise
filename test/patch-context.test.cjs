'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const ts = require('typescript');
const {patchMappingContext} = require('../lib/advisory-context.cjs');

const fields = Array.from({length: 14}, (_, index) => 'field' + index);
const copies = fields.map(field => `if (input.${field} !== undefined) entity.${field} = input.${field};`);
function context(lines, score = 16) {
  const file = ts.createSourceFile('example.ts', 'function patch(entity,input) {' + lines.join('\n') + '}', ts.ScriptTarget.Latest);
  return patchMappingContext(file.statements[0].body, score, 15);
}

test('flat independent presence-checked copies can explain a branch score', () => {
  assert.ok(context(copies));
  assert.ok(context([...copies,
    'if (input.email !== undefined) entity.email = input.email?.trim() ?? null;',
    'if (input.x !== undefined && input.y !== undefined) { entity.x = input.x; entity.y = input.y; entity.at = input.x !== null ? new Date() : null; }']));
});

test('validation, persistence, fallback branches, repeated targets and insufficient evidence remain visible', () => {
  for (const special of [
    'if (input.name !== undefined) entity.name = notify(input.name);',
    'if (input.name !== undefined) persist(entity);',
    'if (input.x !== undefined) entity.x = input.x; else entity.x = fallback;',
    'if (input.x !== undefined) { if (!input.x) throw Error(); entity.x = input.x; }',
    'if (input.x !== undefined) entity.field0 = input.x;',
    'if (input.x !== undefined) other.x = input.x;',
    'if (other.x !== undefined) entity.x = other.x;',
    'if (input.x) entity.x = input.x;',
  ]) assert.equal(context([...copies,special]), undefined, special);
  assert.equal(context(copies.slice(1)), undefined);
  assert.equal(context(copies, 30), undefined);
});
