'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { reviewedReason } = require('../../lib/security/files/review-directive.cjs');

const bin = path.resolve(__dirname, '../../bin/loadwise.cjs');
const tsconfig = '{"compilerOptions":{"types":[]},"include":["*.ts"]}';
const rootDockerfile = 'FROM node:22\nCMD ["node"]\n';

function repository(context, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loadwise-scope-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), text);
  }
  spawnSync('git', ['-C', root, 'init', '-q']);
  spawnSync('git', ['-C', root, 'add', '-f', '.']);
  return root;
}

function sec(cwd, ...args) {
  return spawnSync(process.execPath, [bin, 'sec', ...args], { cwd, encoding: 'utf8', windowsHide: true });
}

test('a # directive on the line above or at the end of the line reviews the rule it names', () => {
  const above = ['# loadwise-reviewed dockerfile-runs-as-root -- builder image only', 'FROM node:22'];
  assert.equal(reviewedReason(above, 2, 'dockerfile-runs-as-root'), 'Reviewed in source: builder image only');
  const inline = ['JWT_SECRET=abc # loadwise-reviewed committed-secret -- rotated, test tenant'];
  assert.match(reviewedReason(inline, 1, 'committed-secret'), /rotated/);
  assert.equal(reviewedReason(above, 2, 'committed-secret'), undefined);
  assert.equal(reviewedReason(['FROM node:22 # loadwise-reviewed dockerfile-runs-as-root', 'x'], 2, 'x'), undefined);
});

test('a reviewed Dockerfile finding is contextual and the full report hides it by default', (context) => {
  const root = repository(context, {
    'tsconfig.json': tsconfig,
    'a.ts': 'export const a = 1;\n',
    Dockerfile: '# loadwise-reviewed dockerfile-runs-as-root -- one-off job image\nFROM node:22.11\n',
  });
  assert.equal(sec(root).status, 0);
  const shown = JSON.parse(sec(root, '--json', '--include-contextual').stdout);
  assert.equal(shown.findings[0].contextualReason, 'Reviewed in source: one-off job image');
});

test('--staged prints a # dismiss command for Dockerfile and env findings', (context) => {
  const root = repository(context, {
    'tsconfig.json': tsconfig,
    'a.ts': 'export const a = 1;\n',
    Dockerfile: rootDockerfile,
  });
  const run = sec(root, '--staged');
  assert.equal(run.status, 1, run.stderr);
  assert.match(run.stdout, /^ {2}dismiss: # loadwise-reviewed dockerfile-runs-as-root -- <reason>$/m);
  assert.doesNotMatch(run.stdout, /dismiss: \/\//);
});

test('inside a monorepo the git top-level config files are checked once, without recursing into other folders', (context) => {
  const root = repository(context, {
    Dockerfile: rootDockerfile,
    'docs/Dockerfile': rootDockerfile,
    'apps/api/tsconfig.json': tsconfig,
    'apps/api/a.ts': 'export const a = 1;\n',
    'apps/api/Dockerfile': rootDockerfile,
  });
  const report = JSON.parse(sec(root, '-p', 'apps/api/tsconfig.json', '--json').stdout);
  const files = report.findings.map((finding) => finding.file);
  assert.equal(files.filter((file) => file === 'Dockerfile').length > 0, true);
  assert.ok(files.includes('apps/api/Dockerfile'));
  assert.ok(!files.includes('docs/Dockerfile'));
  assert.equal(new Set(report.findings.map((finding) => finding.id)).size, report.findings.length);
});
