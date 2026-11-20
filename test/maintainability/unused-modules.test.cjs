'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { scan } = require('../../lib/maintainability/scan.cjs');

const policy = { exclude: [], boundaries: [], placement: [] };

async function scanProject(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'maint-unused-'));
  try {
    for (const [name, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
      fs.writeFileSync(path.join(root, name), text);
    }
    const report = await scan(root, policy);
    return report.findings.filter((finding) => /^unused-export$|^unreferenced-file$/.test(finding.ruleId));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const summary = (findings) => findings.map((finding) => `${finding.ruleId} ${finding.file}`).sort();

test('an export nothing imports and a file nothing imports are reported', async () => {
  const findings = await scanProject({
    'package.json': '{"main":"src/index.ts"}',
    'src/index.ts': 'import { used } from "./helpers";\nused();',
    'src/helpers.ts': 'export const used = () => 1;\nexport const unused = () => 2;',
    'src/orphan.ts': 'export const lonely = 1;',
  });
  assert.deepEqual(summary(findings), ['unreferenced-file src/orphan.ts', 'unused-export src/helpers.ts']);
  const unused = findings.find((finding) => finding.ruleId === 'unused-export');
  assert.deepEqual([unused.line, unused.column], [2, 14]);
  assert.match(unused.message, /`unused`/);
});

test('type imports, namespace imports, require and literal dynamic imports count as use', async () => {
  const findings = await scanProject({
    'package.json': '{"main":"src/index.ts"}',
    'src/index.ts': [
      'import type { Shape } from "./types";',
      'import * as math from "./math";',
      'const legacy = require("./legacy");',
      'export const lazy = () => import("./lazy");',
      'export const shape: Shape = math.area(legacy);',
    ].join('\n'),
    'src/types.ts': 'export interface Shape { size: number }',
    'src/math.ts': 'export const area = (x) => x;\nexport const perimeter = (x) => x;',
    'src/legacy.js': 'module.exports = 1;',
    'src/lazy.ts': 'export default 1;',
  });
  assert.deepEqual(findings, []);
});

test('re-exports and export-star forward use to the original module', async () => {
  const findings = await scanProject({
    'package.json': '{"main":"src/index.ts"}',
    'src/index.ts': 'import { a, c } from "./barrel";\nexport const all = [a, c];',
    'src/barrel.ts': 'export { a, b as renamed } from "./one";\nexport * from "./two";',
    'src/one.ts': 'export const a = 1;\nexport const b = 2;',
    'src/two.ts': 'export const c = 3;\nexport const d = 4;',
  });
  assert.deepEqual(summary(findings), ['unused-export src/one.ts', 'unused-export src/two.ts']);
  assert.deepEqual(findings.map((finding) => finding.message.match(/`(.+?)`/)[1]).sort(), ['b', 'd']);
});

test('entry points and framework conventions are never reported', async () => {
  const findings = await scanProject({
    'package.json':
      '{"main":"dist/main.js","bin":{"tool":"bin/tool.js"},"scripts":{"seed":"ts-node tools/seed-data.ts"}}',
    'nest-cli.json': '{"entryFile":"worker"}',
    'src/main.ts': 'export const boot = 1;',
    'src/worker.ts': 'export const run = 1;',
    'bin/tool.js': 'module.exports = 1;',
    'tools/seed-data.ts': 'export const seed = 1;',
    'src/user.entity.ts': 'export class User {}',
    'src/users.spec.ts': 'export const fixture = 1;',
    'jest.config.ts': 'export default {};',
    'migrations/1700000000000-init.ts': 'export class Init {}',
    'pages/index.tsx': 'export default function Page() {}',
    'src/orphan.service.ts': 'export class Orphan {}',
  });
  assert.deepEqual(summary(findings), ['unreferenced-file src/orphan.service.ts']);
});

test('a non-literal dynamic import makes findings contextual', async () => {
  const findings = await scanProject({
    'package.json': '{"main":"src/index.ts"}',
    'src/index.ts': 'export const load = (name) => import(name);',
    'src/orphan.ts': 'export const lonely = 1;',
  });
  assert.equal(findings.length, 1);
  assert.match(findings[0].contextualReason, /non-literal/);
});

test('a dynamic import with a relative prefix only affects that folder', async () => {
  const findings = await scanProject({
    'package.json': '{"main":"src/index.ts"}',
    'src/index.ts': 'export const load = (name) => import(`./locales/${name}`);',
    'src/locales/en.ts': 'export const messages = {};',
    'src/other/orphan.ts': 'export const lonely = 1;',
  });
  assert.deepEqual(
    findings.map((finding) => [finding.file, Boolean(finding.contextualReason)]),
    [
      ['src/locales/en.ts', true],
      ['src/other/orphan.ts', false],
    ],
  );
});
