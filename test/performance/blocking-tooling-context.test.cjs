'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { withProgram } = require('./helpers.cjs');
const { analyzeFile } = require('../../lib/performance/analyze.cjs');

const loopingRead = `import { readFileSync } from 'node:fs';
export async function load(files: string[]) {
  for (const file of files) readFileSync(file, 'utf8');
}`;

function fsFindingsByFile(files) {
  return withProgram('', files, (program) =>
    Object.fromEntries(
      Object.keys(files).map((filename) => {
        const file = program
          .getSourceFiles()
          .find((item) => item.fileName.replaceAll('\\', '/').endsWith('/' + filename));
        const [finding] = analyzeFile(program, file).filter(
          (candidate) => candidate.ruleId === 'node-sync-fs-in-async',
        );
        return [filename, finding];
      }),
    ),
  );
}

test('a looping sync read in a build config, container tooling or test support is contextual, a service stays reported', () => {
  const findings = fsFindingsByFile({
    'tsup.config.ts': loopingRead,
    'docker/box/build.ts': loopingRead,
    'tests-next/shared/database.ts': loopingRead,
    'src/orders/order.service.ts': loopingRead,
  });
  assert.match(findings['tsup.config.ts'].contextualReason, /build or tool configuration/);
  assert.match(findings['docker/box/build.ts'].contextualReason, /container, boot, codemod, tooling or test-support/);
  assert.match(findings['tests-next/shared/database.ts'].contextualReason, /test-support/);
  assert.equal(findings['src/orders/order.service.ts'].contextualReason, undefined);
});

const repeatedFind = `export function join(items: { id: number }[], rows: { id: number }[]) {
  return items.map((item) => rows.find((row) => row.id === item.id));
}`;

test('a repeated find in container or script tooling is contextual, the same lookup in a service stays reported', () => {
  const files = { 'tools/gx/verify.ts': repeatedFind, 'src/orders/join.service.ts': repeatedFind };
  const findings = withProgram('', files, (program) =>
    Object.fromEntries(
      Object.keys(files).map((filename) => {
        const file = program
          .getSourceFiles()
          .find((item) => item.fileName.replaceAll('\\', '/').endsWith('/' + filename));
        return [filename, analyzeFile(program, file).find((finding) => finding.ruleId === 'array-repeated-find')];
      }),
    ),
  );
  assert.match(findings['tools/gx/verify.ts'].contextualReason, /operator or container tooling/);
  assert.equal(findings['src/orders/join.service.ts'].contextualReason, undefined);
});
