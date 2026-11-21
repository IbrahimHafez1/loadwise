'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');
const { buildFix, createFileCache } = require('../../lib/maintainability/site-fix.cjs');
const { applyBulkFixes } = require('../../lib/shared/fix.cjs');

const record = [
  'interface Packet {',
  '  when: Date;',
  ...Array.from({ length: 20 }, (_, index) => `  field${index}: Array<string | null>;`),
  '}',
].join('\n');
const contents = `${record}\nexport function inspect(packet: Packet) { return packet.when; }\n`;
const finding = { file: 'api.ts', line: 1, column: 1, ruleId: 'large-module', id: 'packet' };

function project(context) {
  const base = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Temp', 'AI-Work') : os.tmpdir();
  fs.mkdirSync(base, { recursive: true });
  const directory = fs.mkdtempSync(path.join(base, 'loadwise-record-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, 'package.json'), '{"type":"module"}');
  return directory;
}

function generate(directory, source) {
  fs.writeFileSync(path.join(directory, finding.file), source);
  return buildFix(finding, createFileCache(directory));
}

function emit(directory) {
  const output = new Map();
  const program = ts.createProgram([path.join(directory, finding.file)], {
    module: ts.ModuleKind.NodeNext,
    types: [],
    declaration: true,
    strict: true,
    skipLibCheck: true,
  });
  assert.deepEqual(
    ts.getPreEmitDiagnostics(program).map(({ messageText }) => messageText),
    [],
  );
  program.emit(undefined, (file, text) => output.set(path.basename(file), text));
  return output;
}

test('extracts a substantial private record, preserving NodeNext JavaScript and declaration emit', (context) => {
  const directory = project(context);
  const fix = generate(directory, contents);
  assert.ok(fix.requiresReview);
  const original = emit(directory);
  assert.equal(applyBulkFixes([{ ...finding, fix }], directory).changedFiles, 0);
  assert.equal(applyBulkFixes([{ ...finding, fix }], directory, { includeReview: true }).changedFiles, 2);
  const rewritten = emit(directory);
  assert.equal(rewritten.get('api.js'), original.get('api.js'));
  assert.match(rewritten.get('api.d.ts'), /import type \{ Packet \} from '.\/api.types.js'/);
  assert.match(rewritten.get('api.types.d.ts'), /export interface Packet/);
  assert.equal(buildFix(finding, createFileCache(directory)), undefined);
});

test('rejects dependent, merged, public, annotated, and small records and existing file collisions', (context) => {
  const directory = project(context);
  for (const source of [
    'class Date {}\n' + contents,
    contents.replace('when: Date;', 'when: User;'),
    contents.replace('when: Date;', '[flag]: Date;'),
    'export ' + contents,
    'interface Packet {}\n' + contents,
    '/** @internal */\n' + contents,
    contents.replace(record, 'interface Packet { when: Date }'),
    contents + 'declare global { interface Window { current: Packet } }',
  ])
    assert.equal(generate(directory, source), undefined);

  const fix = generate(directory, contents);
  fs.writeFileSync(path.join(directory, 'api.types.ts'), 'export const prior = 1;');
  assert.throws(() => applyBulkFixes([{ ...finding, fix }], directory, { includeReview: true }), /already exists/);
  assert.equal(fs.readFileSync(path.join(directory, finding.file), 'utf8'), contents);
  assert.equal(generate(directory, contents), undefined);
});
