'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { scan } = require('../../lib/maintainability/scan.cjs');

const policy = { exclude: [], boundaries: [], placement: [] };

async function scanFindings(files, scanned = '.') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'maint-mocha-'));
  try {
    for (const [name, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
      fs.writeFileSync(path.join(root, name), text);
    }
    const report = await scan(path.join(root, scanned), policy);
    return report.findings
      .filter((finding) => /^unused-export$|^unreferenced-file$/.test(finding.ruleId))
      .map((finding) => `${finding.ruleId} ${finding.file}`)
      .sort();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('mocha spec globs, folders and loaded files in package.json scripts are entry points', async () => {
  const findings = await scanFindings({
    'package.json': JSON.stringify({
      main: 'src/index.js',
      scripts: { test: 'nyc mocha --recursive "checks/**/*.js" --require setup/hook.js --timeout 5000 suites' },
    }),
    'src/index.js': 'module.exports = 1;',
    'checks/deep/one.js': 'it("a", () => {});',
    'setup/hook.js': 'global.ready = true;',
    'suites/two.js': 'it("b", () => {});',
    'src/orphan.js': 'module.exports = 2;',
  });
  assert.deepEqual(findings, ['unreferenced-file src/orphan.js']);
});

test('a .mocharc.yml spec list and a package.json mocha spec folder are entry points', async () => {
  const findings = await scanFindings({
    'package.json': '{"main":"src/index.js","mocha":{"spec":"specs"}}',
    '.mocharc.yml': 'spec:\n  - checks/**/*.js\nrequire: setup/hook.js # loaded first\n',
    'src/index.js': 'module.exports = 1;',
    'checks/one.js': 'it("a", () => {});',
    'setup/hook.js': 'global.ready = true;',
    'specs/two.js': 'it("b", () => {});',
    'src/orphan.js': 'module.exports = 2;',
  });
  assert.deepEqual(findings, ['unreferenced-file src/orphan.js']);
});

test('files in a folder served by express.static are entry points', async () => {
  const findings = await scanFindings({
    'package.json': '{"main":"src/server.js"}',
    'src/server.js':
      'const express = require("express");\nconst path = require("path");\napp.use(express.static(path.join(__dirname, "assets")));',
    'src/assets/client.js': 'window.ready = true;',
    'src/orphan.js': 'module.exports = 2;',
  });
  assert.deepEqual(findings, ['unreferenced-file src/orphan.js']);
});

test('a static folder reached through ".." segments is served too', async () => {
  const findings = await scanFindings({
    'package.json': '{"main":"src/server.js"}',
    'src/server.js':
      'const express = require("express");\nconst path = require("path");\napp.use(express.static(path.join(__dirname, "..", "public")));',
    'public/client.js': 'window.ready = true;',
    'src/orphan.js': 'module.exports = 2;',
  });
  assert.deepEqual(findings, ['unreferenced-file src/orphan.js']);
});

test('aliases of a tsconfig above the scanned folder resolve through its extends chain', async () => {
  const findings = await scanFindings(
    {
      'tsconfig.json': '{"extends":"./tsconfig.base.json","include":["server"]}',
      'tsconfig.base.json': '{"compilerOptions":{"baseUrl":".","paths":{"@server/*":["server/*"]}}}',
      'server/package.json': '{"main":"index.ts"}',
      'server/index.ts': 'import { used } from "@server/utils/helper";\nconsole.log(used);',
      'server/utils/helper.ts': 'export const used = 1;\nexport const spare = 2;',
    },
    'server',
  );
  assert.deepEqual(findings, ['unused-export utils/helper.ts']);
});
