'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { withProgram } = require('../performance/helpers.cjs');
const { createSummaries } = require('../../lib/security/taint/summaries.cjs');

test('call-site summaries preserve source order and cache resolved calls by declaration', () => {
  const source = "export function record(value: string) { return value; }\nrecord('first');\nrecord('second');";
  withProgram(source, { 'separate.ts': source }, (program, main) => {
    const checker = program.getTypeChecker();
    let signatureLookups = 0;
    const summaries = createSummaries({
      getSourceFiles: () => program.getSourceFiles(),
      getTypeChecker: () => ({
        getResolvedSignature(call) {
          signatureLookups++;
          return checker.getResolvedSignature(call);
        },
      }),
    });
    const separate = program.getSourceFiles().find((file) => file.fileName.endsWith('/separate.ts'));
    for (const file of [main, separate]) {
      const [declaration, ...callStatements] = file.statements;
      const calls = callStatements.map(({ expression }) => expression);
      assert.deepEqual(summaries.callSites(declaration), calls);
      const firstLookupCount = signatureLookups;
      assert.deepEqual(summaries.callSites(declaration), calls);
      assert.equal(signatureLookups, firstLookupCount);
    }
  });
});
