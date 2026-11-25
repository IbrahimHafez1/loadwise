import assert from 'node:assert/strict';
import test from 'node:test';
import { withProgram } from './helpers.js';
import { analyzeFile } from '../../lib/performance/analyze.js';
import type { ProgramAdapter } from '../../lib/shared/types.js';
import type { FileMap } from '../types/project-files.js';
import { reasonOf } from '../types/finding-reason.js';
import { sourceFileEndingWith } from '../types/program-files.js';

const loopingRead = `import { readFileSync } from 'node:fs';
export async function load(files: string[]) {
  for (const file of files) readFileSync(file, 'utf8');
}`;

function fsFindingsByFile(files: FileMap) {
  return withProgram('', files, (program: ProgramAdapter) =>
    Object.fromEntries(
      Object.keys(files).map((filename) => {
        const file = sourceFileEndingWith(program, filename);
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
  assert.match(reasonOf(findings['tsup.config.ts']), /build or tool configuration/);
  assert.match(reasonOf(findings['docker/box/build.ts']), /container, boot, codemod, tooling or test-support/);
  assert.match(reasonOf(findings['tests-next/shared/database.ts']), /test-support/);
  const service = findings['src/orders/order.service.ts'];
  assert.ok(service);
  assert.equal(service.contextualReason, undefined);
});

const repeatedFind = `export function join(items: { id: number }[], rows: { id: number }[]) {
  return items.map((item) => rows.find((row) => row.id === item.id));
}`;

test('a repeated find in container or script tooling is contextual, the same lookup in a service stays reported', () => {
  const files = { 'tools/gx/verify.ts': repeatedFind, 'src/orders/join.service.ts': repeatedFind };
  const findings = withProgram('', files, (program: ProgramAdapter) =>
    Object.fromEntries(
      Object.keys(files).map((filename) => {
        const file = sourceFileEndingWith(program, filename);
        return [filename, analyzeFile(program, file).find((finding) => finding.ruleId === 'array-repeated-find')];
      }),
    ),
  );
  assert.match(reasonOf(findings['tools/gx/verify.ts']), /operator or container tooling/);
  const service = findings['src/orders/join.service.ts'];
  assert.ok(service);
  assert.equal(service.contextualReason, undefined);
});
