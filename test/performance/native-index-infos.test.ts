// The native checker adapter answers getIndexInfosOfType in the TypeScript 6 shape, so rules that
// read an accumulator's index signature analyse the file instead of skipping it.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { SourceFile, Statement, VariableStatement } from 'typescript';
import type { CheckerAdapter, ProgramAdapter } from '../../lib/shared/types.js';
import type { SourceAnalyzer } from '../../lib/performance/types/source-analyzer.js';
import { analyzeNative } from '../../lib/performance/native.js';
import * as compiler from '../../lib/performance/compiler.js';

// The native syntax tree has no `ts.isVariableStatement`, so the statement is told apart by its
// shape.
const declaresVariables = (statement: Statement): statement is VariableStatement => 'declarationList' in statement;

const onNativeEngine = process.env.PERF_CHECK_TEST_NATIVE === '1';
const skip = !onNativeEngine && 'runs with PERF_CHECK_TEST_NATIVE=1';
const nativeFixture = onNativeEngine ? await import('./native-fixture.js') : undefined;

const reduceSource = [
  'type Row = { id: string };',
  'export function byId(rows: Row[]) {',
  '  return rows.reduce<Record<string, Row>>((index, row) => ({ ...index, [row.id]: row }), {});',
  '}',
].join('\n');

test('a typed reduce spread file is analysed on the native engine', { skip }, () => {
  assert.ok(nativeFixture);
  const findings = nativeFixture.lint(reduceSource, {});
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
  const capturedInfos: ReturnType<CheckerAdapter['getIndexInfosOfType']>[] = [];
  const probe: SourceAnalyzer = {
    pillar: 'performance',
    analyzeFile(program: ProgramAdapter, sourceFile: SourceFile) {
      const checker = program.getTypeChecker();
      const [statement] = sourceFile.statements;
      assert.ok(declaresVariables(statement));
      const name = statement.declarationList.declarations[0].name;
      capturedInfos.push(checker.getIndexInfosOfType(checker.getTypeAtLocation(name)));
      return [];
    },
  };
  const result = analyzeNative({ files: [file], analyzers: [probe] });
  // Read after the run: the native engine selects the syntax the flags belong to.
  const ts = compiler.loadSyntax();
  assert.deepEqual(('skippedFiles' in result ? result.skippedFiles : undefined) ?? [], []);
  const [infos] = capturedInfos;
  assert.ok(infos);
  assert.equal(infos.length, 1);
  assert.ok(infos[0].keyType.flags & ts.TypeFlags.String);
  assert.ok(infos[0].type.flags & ts.TypeFlags.Number);
  assert.equal(infos[0].isReadonly, true);
});
