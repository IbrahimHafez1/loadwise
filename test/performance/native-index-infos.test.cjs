'use strict';

// The native checker adapter answers getIndexInfosOfType in the TypeScript 6 shape, so rules that read an
// accumulator's index signature analyse the file instead of skipping it.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const onNativeEngine = process.env.PERF_CHECK_TEST_NATIVE === '1';
const skip = !onNativeEngine && 'runs with PERF_CHECK_TEST_NATIVE=1';

const reduceSource = [
  'type Row = { id: string };',
  'export function byId(rows: Row[]) {',
  '  return rows.reduce<Record<string, Row>>((index, row) => ({ ...index, [row.id]: row }), {});',
  '}',
].join('\n');

test('a typed reduce spread file is analysed on the native engine', { skip }, () => {
  const { lint } = require('./native-fixture.cjs');
  const findings = lint(reduceSource);
  assert.deepEqual(
    findings.map(({ ruleId, line }) => [ruleId, line]),
    [['reduce-copy-accumulator', 3]],
  );
});

test('getIndexInfosOfType returns key type, value type and readonly flag', { skip }, (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'loadwise-native-index-infos-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'index.ts');
  fs.writeFileSync(file, 'export declare const byId: { readonly [id: string]: number };\n');
  const { analyzeNative } = require('../../lib/performance/native.cjs');
  let infos;
  const probe = {
    pillar: 'performance',
    analyzeFile(program, sourceFile) {
      const checker = program.getTypeChecker();
      const [statement] = sourceFile.statements;
      const name = statement.declarationList.declarations[0].name;
      infos = checker.getIndexInfosOfType(checker.getTypeAtLocation(name));
      return [];
    },
  };
  const result = analyzeNative({ files: [file], analyzers: [probe] });
  // Read after the run: the native engine selects the syntax the flags belong to.
  const { syntax: ts } = require('../../lib/performance/compiler.cjs');
  assert.deepEqual(result.skippedFiles ?? [], []);
  assert.equal(infos.length, 1);
  assert.ok(infos[0].keyType.flags & ts.TypeFlags.String);
  assert.ok(infos[0].type.flags & ts.TypeFlags.Number);
  assert.equal(infos[0].isReadonly, true);
});
