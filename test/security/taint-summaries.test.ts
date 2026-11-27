import assert from 'node:assert/strict';
import { test } from 'node:test';
import { withProgram } from '../performance/helpers.js';
import { createSummaries } from '../../lib/security/taint/summaries.js';
import ts from 'typescript';
import type { CallExpression, SourceFile } from 'typescript';
import type { ProgramAdapter } from '../../lib/shared/types.js';

test('call-site summaries preserve source order and cache resolved calls by declaration', () => {
  const source = "export function record(value: string) { return value; }\nrecord('first');\nrecord('second');";
  withProgram(source, { 'separate.ts': source }, (program: ProgramAdapter, main: SourceFile) => {
    const checker = program.getTypeChecker();
    assert.ok(program.getSourceFiles);
    const sourceFiles = program.getSourceFiles();
    let signatureLookups = 0;
    const summaries = createSummaries({
      getCompilerOptions: () => program.getCompilerOptions(),
      getSourceFiles: () => sourceFiles,
      getTypeChecker: () => ({
        ...checker,
        getResolvedSignature(call: CallExpression) {
          signatureLookups++;
          return checker.getResolvedSignature(call);
        },
      }),
    });
    const separate = sourceFiles.find((file) => file.fileName.endsWith('/separate.ts'));
    assert.ok(separate);
    for (const file of [main, separate]) {
      const [declaration, ...callStatements] = file.statements;
      assert.ok(declaration && ts.isFunctionDeclaration(declaration));
      const calls = callStatements.map((statement) => {
        assert.ok(ts.isExpressionStatement(statement));
        return statement.expression;
      });
      assert.deepEqual(summaries.callSites(declaration), calls);
      const firstLookupCount = signatureLookups;
      assert.deepEqual(summaries.callSites(declaration), calls);
      assert.equal(signatureLookups, firstLookupCount);
    }
  });
});

test('call sites include calls spelled through an import alias', () => {
  const declaration = 'export function consume(value: string) { return value; }';
  const caller = "import { consume as run } from './consume.js';\nrun('first');";
  withProgram(caller, { 'consume.ts': declaration }, (program: ProgramAdapter) => {
    const summaries = createSummaries(program);
    const consume = program
      .getSourceFiles?.()
      .flatMap((file) => file.statements)
      .find((statement) => ts.isFunctionDeclaration(statement) && statement.name?.text === 'consume');
    assert.ok(consume && ts.isFunctionDeclaration(consume));
    assert.equal(summaries.callSites(consume).length, 1);
  });
});
