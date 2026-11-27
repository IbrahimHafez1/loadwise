import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import ts from 'typescript';
import { checkStrayConsole } from '../../lib/maintainability/stray-console.js';
import { buildFix, createFileCache } from '../../lib/maintainability/site-fix.js';
import { parseReport } from '../types/cli-report.js';
import type { TestContext } from 'node:test';
import type { Finding } from '../../lib/shared/types.js';

const cli = path.join(import.meta.dirname, '../../bin/loadwise.js');
const serverImport = "import http from 'node:http';\n";

// The classifier reads package.json, so each test project gets its own root with one.
function project(context: TestContext, manifest: object = {}): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stray-console-'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(manifest));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function writeSource(root: string, file: string, source: string): void {
  const absolute = path.join(root, file);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, source);
}

function check(root: string, file: string, source: string): Finding[] {
  writeSource(root, file, source);
  const sourceFile = ts.createSourceFile(path.join(root, file), source, ts.ScriptTarget.Latest, true);
  return checkStrayConsole(sourceFile, file, {});
}

test('flags every console call in server code and says where the output goes', (context) => {
  const root = project(context);
  const findings = check(
    root,
    'src/server/orders.ts',
    `${serverImport}export function handle() {\n  console.log('start');\n  console.error('failed');\n  console.table([]);\n}\n`,
  );
  assert.deepEqual(
    findings.map((finding) => [finding.ruleId, finding.line]),
    [
      ['stray-console', 3],
      ['stray-console', 4],
      ['stray-console', 5],
    ],
  );
  assert.match(findings[0].message, /stdout/);
  assert.match(findings[1].message, /stderr/);
  assert.equal(findings[0].fix, undefined);
});

test('does not flag browser code', (context) => {
  const root = project(context);
  const tsx = "export function Cart() {\n  console.warn('empty');\n  return <div />;\n}\n";
  assert.deepEqual(check(root, 'src/components/Cart.tsx', tsx), []);
  const plain = `${serverImport}console.log('x');\n`;
  for (const file of ['src/client/api.ts', 'src/web/api.ts', 'public/app.ts', 'src/ui/api.ts']) {
    assert.deepEqual(check(root, file, plain), [], file);
  }
  const domGlobal = `${serverImport}export function open() {\n  console.log(window.location.href);\n}\n`;
  assert.deepEqual(check(root, 'src/open.ts', domGlobal), []);
  const reactImport = "import { useState } from 'react';\nexport const state = useState;\nconsole.log('x');\n";
  assert.deepEqual(check(root, 'src/state.ts', reactImport), []);
});

test('honours eslint-disable comments for no-console', (context) => {
  const root = project(context);
  const body = "export function handle() {\n  console.log('x');\n}\n";
  assert.deepEqual(check(root, 'src/server/a.ts', `/* eslint-disable no-console */\n${serverImport}${body}`), []);
  assert.deepEqual(check(root, 'src/server/b.ts', `/* eslint-disable */\n${serverImport}${body}`), []);
  const nextLine = `${serverImport}export function handle() {\n  // eslint-disable-next-line no-console\n  console.log('x');\n  console.log('y');\n}\n`;
  assert.deepEqual(
    check(root, 'src/server/c.ts', nextLine).map((finding) => finding.line),
    [5],
  );
  const sameLine = `${serverImport}export function handle() {\n  console.log('x'); // eslint-disable-line no-console\n}\n`;
  assert.deepEqual(check(root, 'src/server/d.ts', sameLine), []);
  const otherRule = `/* eslint-disable no-alert */\n${serverImport}${body}`;
  assert.equal(check(root, 'src/server/e.ts', otherRule).length, 1);
  const reenabled = `${serverImport}/* eslint-disable no-console */\nconsole.log('a');\n/* eslint-enable no-console */\nconsole.log('b');\n`;
  assert.deepEqual(
    check(root, 'src/server/f.ts', reenabled).map((finding) => finding.line),
    [5],
  );
});

test('skips vendored, generated, sample and story files', (context) => {
  const root = project(context);
  const source = `${serverImport}console.log('x');\n`;
  for (const file of [
    'vendor/lib.ts',
    'third_party/lib.ts',
    'src/assets/lib.js',
    'src/lib.min.js',
    'docs/sample.ts',
    'examples/app.ts',
    'playground/app.ts',
    '.github/scripts-helper.ts',
    'src/__fixtures__/app.ts',
    'src/Button.stories.ts',
  ]) {
    assert.deepEqual(check(root, file, source), [], file);
  }
  const bundled = `/** @license MIT */\n${serverImport}console.log('x');\n${'// padding\n'.repeat(6000)}`;
  assert.deepEqual(check(root, 'src/server/three.js', bundled), []);
});

test('skips programs run from a terminal, detected by shebang or argv', (context) => {
  const root = project(context);
  const argv = `${serverImport}const [name] = process.argv.slice(2);\nconsole.log(name);\n`;
  assert.deepEqual(check(root, 'src/server/run.ts', argv), []);
  const exit = `${serverImport}export function stop() {\n  console.log('bye');\n  process.exit(0);\n}\n`;
  assert.deepEqual(check(root, 'src/server/stop.ts', exit), []);
});

test('a process.exit in a shutdown handler does not hide other console calls', (context) => {
  const root = project(context);
  const source = `${serverImport}process.on('SIGTERM', () => {\n  console.log('bye');\n  process.exit(0);\n});\nexport function handle() {\n  console.log('x');\n}\n`;
  assert.deepEqual(
    check(root, 'src/server/main.ts', source).map((finding) => finding.line),
    [7],
  );
});

test('skips a failure report directly followed by throw', (context) => {
  const root = project(context);
  const source = `${serverImport}export function start(port?: number) {\n  if (!port) {\n    console.error('PORT is required');\n    throw new Error('PORT is required');\n  }\n  console.error('late');\n}\n`;
  assert.deepEqual(
    check(root, 'src/server/start.ts', source).map((finding) => finding.line),
    [7],
  );
});

test('does not flag scripts, CLIs, tests, configs or unclassified files', (context) => {
  const root = project(context);
  const source = `${serverImport}console.log('x');\n`;
  for (const file of [
    'scripts/build.ts',
    'src/commands/run.ts',
    'src/orders.test.ts',
    'tests/helpers.ts',
    'vite.config.ts',
    'db/seeds/users.ts',
    'db/migrations/001.ts',
    'bin/serve.ts',
  ]) {
    assert.deepEqual(check(root, file, source), [], file);
  }
  assert.deepEqual(check(root, 'src/plain.ts', "console.log('x');\n"), []);
  assert.deepEqual(check(root, 'src/shebang.ts', `#!/usr/bin/env node\n${source}`), []);
});

test('does not flag a package that ships a CLI binary', (context) => {
  const root = project(context, { bin: { tool: 'src/main.js' } });
  assert.deepEqual(check(root, 'src/main.ts', `${serverImport}console.log('x');\n`), []);
});

test('skips calls guarded by a development check', (context) => {
  const root = project(context);
  const findings = check(
    root,
    'src/server/dev.ts',
    [
      serverImport,
      "if (process.env.NODE_ENV !== 'production') console.log('a');",
      "if (__DEV__) { console.log('b'); }",
      "if (import.meta.env.DEV && true) console.debug('c');",
      "process.env.NODE_ENV === 'production' ? 0 : console.log('d');",
      "if (process.env.NODE_ENV === 'production') { console.log('prod'); } else { console.log('e'); }",
      "export const x = process.env.NODE_ENV !== 'production' && console.log('f');",
    ].join('\n'),
  );
  assert.deepEqual(
    findings.map((finding) => finding.line),
    [7],
  );
});

test('skips files and functions that implement a logger', (context) => {
  const root = project(context);
  assert.deepEqual(check(root, 'src/server/logger.ts', `${serverImport}console.log('x');\n`), []);
  assert.deepEqual(
    check(
      root,
      'src/server/observability.ts',
      `${serverImport}export function createLogger() {\n  return { info: (message: string) => console.info(message) };\n}\n`,
    ),
    [],
  );
  assert.deepEqual(
    check(
      root,
      'src/server/sink.ts',
      `${serverImport}export class ConsoleLogger {\n  write(message: string) { console.log(message); }\n}\n`,
    ),
    [],
  );
});

test('skips last-resort error reporting', (context) => {
  const root = project(context);
  const findings = check(
    root,
    'src/server/main.ts',
    [
      serverImport,
      "process.on('uncaughtException', (error) => { console.error(error); });",
      "process.on('unhandledRejection', function (reason) { console.error(reason); });",
      'main().catch((error) => {',
      '  console.error(error);',
      '  process.exit(1);',
      '});',
      'function main() { return Promise.resolve(); }',
      'export function other() { return main().catch((error) => console.error(error)); }',
    ].join('\n'),
  );
  assert.deepEqual(
    findings.map((finding) => finding.line),
    [10],
  );
});

test('skips React error boundaries', (context) => {
  const root = project(context);
  const source =
    "import React from 'react';\nexport class Boundary extends React.Component {\n  componentDidCatch(error: Error) { console.error(error); }\n}\n";
  assert.deepEqual(check(root, 'src/Boundary.tsx', source), []);
});

test('fix rewrites to the logger already imported, with review required', (context) => {
  const root = project(context);
  const source = `${serverImport}import { logger } from './logger.js';\nexport function handle() {\n  console.log('start');\n  console.error('failed');\n  console.trace();\n}\n`;
  const findings = check(root, 'src/server/orders.ts', source);
  const fixes = findings.map((finding) => buildFix(finding, createFileCache(root), { comments: false }));
  assert.equal(fixes[0]?.requiresReview, true);
  assert.ok(fixes[0]?.note);
  assert.match(fixes[0]?.changes[0].after ?? '', /logger\.info\('start'\)/);
  assert.match(fixes[1]?.changes[0].after ?? '', /logger\.error\('failed'\)/);
  assert.equal(fixes[2], undefined);
});

test('fix uses this.logger.log inside a Nest class with a Logger field', (context) => {
  const root = project(context);
  const source = [
    "import { Injectable, Logger } from '@nestjs/common';",
    '@Injectable()',
    'export class OrdersService {',
    '  private readonly logger = new Logger(OrdersService.name);',
    '  place() {',
    "    console.log('placing');",
    "    console.warn('slow');",
    '  }',
    '}',
  ].join('\n');
  const findings = check(root, 'src/orders.service.ts', source);
  const fixes = findings.map((finding) => buildFix(finding, createFileCache(root), { comments: false }));
  assert.match(fixes[0]?.changes[0].after ?? '', /this\.logger\.log\('placing'\)/);
  assert.match(fixes[1]?.changes[0].after ?? '', /this\.logger\.warn\('slow'\)/);
});

test('fix does not use this.logger where this is not the Nest class', (context) => {
  const root = project(context);
  const source = [
    "import { Logger } from '@nestjs/common';",
    'export class OrdersService {',
    '  private readonly logger = new Logger(OrdersService.name);',
    '  static {',
    "    console.log('boot');",
    '  }',
    '  place() {',
    '    return {',
    "      run() { console.log('inside object'); },",
    "      get label() { console.warn('read'); return 'x'; },",
    '    };',
    '  }',
    '  keep() {',
    "    console.error('kept');",
    '  }',
    '}',
  ].join('\n');
  const findings = check(root, 'src/orders.service.ts', source);
  const fixes = findings.map((finding) => buildFix(finding, createFileCache(root), { comments: false }));
  assert.equal(findings.length, 4);
  assert.deepEqual(fixes.slice(0, 3), [undefined, undefined, undefined]);
  assert.match(fixes[3]?.changes[0].after ?? '', /this\.logger\.error\('kept'\)/);
});

test('a project checked out under a tools directory is still scanned', (context) => {
  const root = project(context);
  const nested = path.join(root, 'tools', 'app');
  fs.mkdirSync(nested, { recursive: true });
  fs.writeFileSync(path.join(nested, 'package.json'), '{}');
  const source = `${serverImport}console.log('x');\n`;
  fs.mkdirSync(path.join(nested, 'src'), { recursive: true });
  fs.writeFileSync(path.join(nested, 'src/app.ts'), source);
  const result = spawnSync(process.execPath, [cli, 'maint', nested, '--json'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const strays = parseReport(result.stdout).findings.filter((finding) => finding.ruleId === 'stray-console');
  assert.deepEqual(
    strays.map((finding) => finding.file),
    ['src/app.ts'],
  );
});

test('reports without a fix when the file has no logger', (context) => {
  const root = project(context);
  const findings = check(
    root,
    'src/server/orders.ts',
    `${serverImport}console.log('x');\nconst log = (text: string) => text;\n`,
  );
  assert.equal(findings.length, 1);
  assert.equal(buildFix(findings[0], createFileCache(root), { comments: false }), undefined);
});

test('maint CLI reports stray console calls in a server project', (context) => {
  const root = project(context, { dependencies: { express: '^4.0.0' } });
  writeSource(
    root,
    'src/app.ts',
    "import express from 'express';\nexport const app = express();\nconsole.log('listening');\n",
  );
  writeSource(root, 'scripts/seed.ts', "console.log('seeding');\n");
  const result = spawnSync(process.execPath, [cli, 'maint', root, '--json'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const strays = parseReport(result.stdout).findings.filter((finding) => finding.ruleId === 'stray-console');
  assert.equal(strays.length, 1);
  assert.equal(strays[0].file, 'src/app.ts');
});

test('does not flag a src/cli directory of an express project', (context) => {
  const root = project(context, { dependencies: { express: '^4.0.0' } });
  const source = "import express from 'express';\nconsole.log('x');\n";
  assert.deepEqual(check(root, 'src/cli/x.ts', source), []);
  assert.equal(check(root, 'src/server/x.ts', source).length, 1);
});
