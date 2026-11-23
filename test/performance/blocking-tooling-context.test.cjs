'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');
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

// The package root has to exist on disk, because project roots are found through real package.json files.
test('a looping sync read in a package inside a repository test folder is contextual, the app package stays reported', (context) => {
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), 'loadwise-test-package-'));
  context.after(() => fs.rmSync(repository, { recursive: true, force: true }));
  const files = { sandbox: 'tests/sandbox/src/steps/docker.ts', app: 'api/src/services/files.ts' };
  fs.mkdirSync(path.join(repository, '.git'));
  for (const file of Object.values(files)) {
    const packageRoot = path.join(repository, file.split('/src/')[0]);
    fs.mkdirSync(path.join(packageRoot, 'src', path.dirname(file.split('/src/')[1])), { recursive: true });
    fs.writeFileSync(path.join(packageRoot, 'package.json'), '{}');
    fs.writeFileSync(path.join(repository, file), loopingRead);
  }
  const program = ts.createProgram(
    Object.values(files).map((file) => path.join(repository, file)),
    { strict: true, skipLibCheck: true, types: [] },
  );
  const reasonFor = (file) =>
    analyzeFile(program, program.getSourceFile(path.join(repository, file))).find(
      (finding) => finding.ruleId === 'node-sync-fs-in-async',
    ).contextualReason;
  assert.match(reasonFor(files.sandbox), /test-support/);
  assert.equal(reasonFor(files.app), undefined);
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
