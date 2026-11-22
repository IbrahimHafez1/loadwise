'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');
const { attachSiteFixes } = require('../../lib/maintainability/site-fix.cjs');
const { applyBulkFixes } = require('../../lib/shared/fix.cjs');

const schema =
  'export interface Config { fields: Array<{ parse(value: unknown): unknown; format(value: unknown): unknown }> };';
const callbacks = [
  '    parse: (value) => {',
  '      if (value == null) return null;',
  "      if (value === '') throw new Error('empty');",
  '      return Number(value) + bias;',
  '    },',
  '    format: (value) => {',
  "      if (value == null) return '';",
  "      if (typeof value === 'string') return value.trim();",
  '      return String(value);',
  '    },',
].join('\n');
const source = [
  "import type { Config } from './schema';",
  'const bias = 2;',
  '/** Field configuration. */',
  'export const config: Config = {',
  '  fields: [',
  '  {',
  callbacks,
  '  },',
  '  {',
  callbacks,
  '  },',
  '  ],',
  '};',
  '',
].join('\n');

function proposed(context, input = source, types = schema) {
  const base = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Temp', 'AI-Work') : os.tmpdir();
  fs.mkdirSync(base, { recursive: true });
  const directory = fs.mkdtempSync(path.join(base, 'loadwise-callbacks-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = 'fields.ts';
  fs.writeFileSync(path.join(directory, file), input);
  fs.writeFileSync(path.join(directory, 'schema.ts'), types);
  const findings = ['parse', 'format'].map((name) => {
    const sites = input
      .split('\n')
      .flatMap((line, index) =>
        line.startsWith('    ' + name + ': (value) =>')
          ? [{ file, line: index + 1, column: line.indexOf('(value)') + 1 }]
          : [],
      );
    return { ...sites[0], related: sites.slice(1), ruleId: 'duplicate-implementation', id: name, checker: 'maint' };
  });
  attachSiteFixes(findings, directory);
  return { directory, findings, filename: path.join(directory, file) };
}

function execute(input) {
  const js = ts.transpileModule(input, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const exported = {};
  Function('exports', js)(exported);
  return exported.config.fields;
}

test('two duplicated column callbacks apply together, keep their behavior and reference one shared helper', (context) => {
  const { findings, directory, filename } = proposed(context);
  assert.ok(findings.every((finding) => finding.fix?.requiresReview));
  assert.equal(applyBulkFixes(findings, directory).changedFiles, 0);
  assert.equal(applyBulkFixes(findings, directory, { includeReview: true }).changedFiles, 1);
  const original = execute(source),
    updated = execute(fs.readFileSync(filename, 'utf8'));
  for (const key of ['parse', 'format']) {
    // Sharing one function across fields is safe: it reads no `this` or `arguments`, takes the callback's one
    // parameter, and each field is still its own property that can be replaced independently.
    assert.equal(updated[0][key], updated[1][key]);
    assert.equal(updated[0][key].name, 'config' + key[0].toUpperCase() + key.slice(1));
    assert.equal(updated[0][key].length, original[0][key].length);
    for (const value of [1, null, ' 22 ']) assert.equal(updated[0][key](value), original[0][key](value));
    updated[0][key] = () => false;
    assert.equal(updated[1][key](3), original[1][key](3));
  }
  assert.throws(() => updated[1].parse(''), /empty/);
});

test('skips unverified context, eval, helper collisions and changes that capture a different value', (context) => {
  for (const types of [
    schema.replaceAll('unknown', 'any'),
    schema.replaceAll('): unknown', '): string'),
    'export type Config = any;',
  ]) {
    assert.ok(proposed(context, source, types).findings.every((finding) => !finding.fix));
  }
  for (const text of [
    source.replaceAll('Number(value) + bias', "eval('value')"),
    source + 'const configParse=0;',
    source.replace('Number(value) + bias', 'Number(value) + 4'),
  ]) {
    assert.equal(proposed(context, text).findings[0].fix, undefined);
  }
});
