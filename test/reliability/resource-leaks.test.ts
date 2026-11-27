import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { checkResourceLeaks } from '../../lib/reliability/resource-leaks.js';
import { buildFix, createFileCache, loadBuilders } from '../../lib/performance/site-fix.js';
import { withProgram } from '../performance/helpers.js';
import type { Finding } from '../../lib/shared/types.js';

const typeormStub = [
  'export declare class QueryRunner {',
  '  connect(): Promise<void>;',
  '  release(): Promise<void>;',
  '  manager: { query(sql: string): Promise<unknown> };',
  '}',
  'export declare class DataSource {',
  '  createQueryRunner(): QueryRunner;',
  '  manager: { connection: DataSource };',
  '}',
  '',
].join('\n');
const packages = { 'node_modules/typeorm/index.d.ts': typeormStub };
const bin = path.resolve(import.meta.dirname, '../../bin/loadwise.js');

function scan(source: string, file = 'main.ts'): Finding[] {
  return withProgram(source, packages, (program, sourceFile) =>
    checkResourceLeaks(sourceFile, file, program.getTypeChecker()),
  );
}

function ruleIds(source: string): string[] {
  return scan(source).map(({ ruleId }) => ruleId);
}

function lines(...rows: string[]): string {
  return rows.join('\n') + '\n';
}

// Builds the fix for the only finding, the way `loadwise rel --fix` does, and returns the changed text.
async function fixedHunks(context: TestContext, source: string) {
  await loadBuilders();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'loadwise-leak-fix-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'main.ts');
  fs.writeFileSync(file, source);
  const [finding] = scan(source, file);
  assert.ok(finding, 'a finding to fix');
  const fix = buildFix({ ...finding, file }, createFileCache());
  return fix;
}

test('file-handle-not-closed reports a handle that is never closed or closed outside finally', () => {
  const never = lines(
    "import { open } from 'node:fs/promises';",
    'export async function head(path: string) {',
    "  const handle = await open(path, 'r');",
    '  const { size } = await handle.stat();',
    '  return size;',
    '}',
  );
  const [finding] = scan(never);
  assert.equal(finding.ruleId, 'file-handle-not-closed');
  assert.equal(finding.line, 3);
  assert.match(finding.message, /never called/);
  const afterWork = lines(
    "import * as fsp from 'fs/promises';",
    'export async function head(path: string) {',
    "  const handle = await fsp.open(path, 'r');",
    '  await handle.readFile();',
    '  await handle.close();',
    '}',
  );
  const [outside] = scan(afterWork);
  assert.match(outside.message, /not in a finally block/);
});

test('file-handle-not-closed follows fs.promises, aliases and require', () => {
  const sources = [
    "import fs from 'node:fs';\nasync function f() { const h = await fs.promises.open('a'); await h.stat(); }",
    "import { promises as p } from 'fs';\nasync function f() { const h = await p.open('a'); await h.stat(); }",
    "import { promises } from 'fs';\nasync function f() { const h = await promises.open('a'); await h.stat(); }",
    "import { open as openFile } from 'fs/promises';\nasync function f() { const h = await openFile('a'); await h.stat(); }",
    "const { open } = require('fs/promises');\nasync function f() { const h = await open('a'); await h.stat(); }",
  ];
  for (const source of sources) assert.deepEqual(ruleIds(source), ['file-handle-not-closed'], source);
});

test('file-handle-not-closed stays quiet when the handle is safe or not an fs handle', () => {
  const quiet = [
    "import { open } from 'fs/promises';\nasync function f() { const h = await open('a'); try { await h.stat(); } finally { await h.close(); } }",
    "import { open } from 'fs/promises';\nasync function f() { await using h = await open('a'); await h.stat(); }",
    "import { open } from 'fs/promises';\nasync function f() { const h = await open('a'); return h; }",
    "import { open } from 'fs/promises';\nasync function f(reg: Set<unknown>) { const h = await open('a'); reg.add(h); await h.stat(); }",
    "import { open } from 'fs/promises';\nclass A { h?: unknown; async f() { const h = await open('a'); this.h = h; } }",
    "import { open } from 'fs/promises';\nasync function f() { const h = await open('a'); return h.createReadStream(); }",
    "import { open } from 'fs/promises';\nasync function f() { const h = await open('a'); await h.close(); }",
    "import { open } from 'fs';\nfunction f() { const h = open('a', () => {}); return h; }",
    "async function open(path: string) { return path; }\nasync function f() { const h = await open('a'); return h.length; }",
    "import { open } from 'fs/promises';\nasync function f() { const h = await open('a'); try { await h.stat(); } finally { await h?.close(); } }",
  ];
  for (const source of quiet) assert.deepEqual(ruleIds(source), [], source);
});

test('query-runner-not-released recognises TypeORM data sources and ignores other owners', () => {
  const header = "import { DataSource } from 'typeorm';\n";
  const leaking = [
    'async function f(source: DataSource) { const runner = source.createQueryRunner(); await runner.connect(); }',
    'async function f(source: DataSource) { const runner = source.manager.connection.createQueryRunner(); await runner.manager.query("x"); await runner.release(); }',
  ];
  for (const body of leaking) assert.deepEqual(ruleIds(header + body), ['query-runner-not-released'], body);
  const quiet = [
    'async function f(source: DataSource) { const runner = source.createQueryRunner(); try { await runner.connect(); } finally { await runner.release(); } }',
    'function f(source: DataSource) { const runner = source.createQueryRunner(); return runner; }',
    'class A { runner?: unknown; f(source: DataSource) { const runner = source.createQueryRunner(); this.runner = runner; } }',
    'async function f(source: DataSource, run: (runner: unknown) => Promise<void>) { const runner = source.createQueryRunner(); await run(runner); }',
    'async function f(factory: { createQueryRunner(): { release(): void } }) { const runner = factory.createQueryRunner(); void runner; }',
  ];
  for (const body of quiet) assert.deepEqual(ruleIds(header + body), [], body);
});

test('browser-not-closed covers Playwright and Puppeteer launches', () => {
  const leaking = [
    "import { chromium } from 'playwright';\nasync function f() { const browser = await chromium.launch(); await browser.newPage(); }",
    "import playwright from 'playwright';\nasync function f() { const browser = await playwright.firefox.launch(); await browser.newPage(); await browser.close(); }",
    "import { webkit } from 'playwright-core';\nasync function f() { const context = await webkit.launchPersistentContext('dir'); await context.newPage(); }",
    "import puppeteer from 'puppeteer';\nasync function f() { const browser = await puppeteer.launch(); await browser.newPage(); }",
    "import * as pptr from 'puppeteer-core';\nasync function f() { const browser = await pptr.connect({}); await browser.newPage(); }",
  ];
  for (const source of leaking) assert.deepEqual(ruleIds(source), ['browser-not-closed'], source);
  const quiet = [
    "import puppeteer from 'puppeteer';\nasync function f() { const browser = await puppeteer.launch(); try { await browser.newPage(); } finally { await browser.close(); } }",
    "import puppeteer from 'puppeteer';\nasync function f() { const browser = await puppeteer.connect({}); try { await browser.newPage(); } finally { await browser.disconnect(); } }",
    "import { chromium } from 'playwright';\nasync function f() { const browser = await chromium.launch(); return browser; }",
    "import { chromium } from 'playwright';\nclass A { b?: unknown; async f() { const browser = await chromium.launch(); this.b = browser; } }",
    "import { chromium } from 'playwright';\nasync function f(keep: (b: unknown) => void) { const browser = await chromium.launch(); keep(browser); }",
    "import { chromium } from 'playwright';\nasync function f() { const browser = await chromium.launch(); process.on('exit', () => browser.close()); }",
    "import { chromium } from 'playwright';\nasync function f() { const browser = await chromium.launch(); return { browser }; }",
    "import { test } from '@playwright/test';\nimport { chromium } from 'playwright';\ntest('x', async () => { const browser = await chromium.launch(); await browser.newPage(); });",
    'const puppeteer = { launch: async () => ({ close: async () => {} }) };\nasync function f() { const browser = await puppeteer.launch(); await browser.close(); }',
  ];
  for (const source of quiet) assert.deepEqual(ruleIds(source), [], source);
});

test('long-lived and fully released resources are not reported', () => {
  const header = "import puppeteer from 'puppeteer';\nimport { open } from 'node:fs/promises';\n";
  const quiet = [
    'export const browser = await puppeteer.launch();',
    "const browser = await puppeteer.launch();\ndeclare const app: { get(path: string, handler: () => Promise<void>): void };\napp.get('/', async () => { await browser.newPage(); });",
    'async function f() { const browser = await puppeteer.launch(); const run = async () => { await browser.newPage(); }; void run; }',
    "async function f() { const h = await open('a'); try { await h.stat(); await h.close(); } catch (error) { await h.close(); throw error; } }",
  ];
  for (const body of quiet) assert.deepEqual(ruleIds(header + body), [], body);
  const closedOnlyOnSuccess =
    "async function f() { const h = await open('a'); try { await h.stat(); await h.close(); } catch (error) { throw error; } }";
  assert.deepEqual(ruleIds(header + closedOnlyOnSuccess), ['file-handle-not-closed']);
});

test('interval-not-cleared leaves a discarded timer in a constructor or lifecycle hook alone', () => {
  const quiet = [
    'export class Service { constructor() { setInterval(poll, 1000); } }',
    'export class Service { onModuleInit() { setInterval(poll, 1000); } }',
    'export class Service { onApplicationBootstrap() { void setInterval(poll, 1000); } }',
    'export function init() { setInterval(poll, 1000); }',
    'export function register() { setInterval(poll, 1000); }',
  ];
  for (const body of quiet) assert.deepEqual(ruleIds(body + '\nfunction poll() {}\n'), [], body);
});

test('resource rules skip test, vendored and generated files', () => {
  const source =
    "import { open } from 'fs/promises';\nasync function f() { const h = await open('a'); await h.stat(); }";
  assert.equal(scan(source, 'src/a.ts').length, 1);
  assert.deepEqual(scan(source, 'src/a.test.ts'), []);
  assert.deepEqual(scan(source, 'test/helpers/a.ts'), []);
  assert.deepEqual(scan(source, 'vendor/a.ts'), []);
  assert.deepEqual(scan('// @generated\n' + source, 'src/a.ts'), []);
});

test('interval-not-cleared reports discarded and never-cleared handles inside functions', () => {
  const leaking = [
    'export function watch() { setInterval(poll, 1000); }',
    'export function watch() { const timer = setInterval(poll, 1000); void timer.hasRef(); }',
    'class Poller { start() { this.timer = setInterval(poll, 1000); } }',
    'class Poller { timer: unknown; start() { this.timer = setInterval(poll, 1000); } stop() { this.timer = undefined; } }',
    "import { setInterval } from 'node:timers';\nexport function watch() { setInterval(poll, 1000); }",
    'export function watch() { globalThis.setInterval(poll, 1000); }',
    "app.get('/x', () => { setInterval(poll, 1000); });",
  ];
  for (const body of leaking) {
    const source =
      body +
      '\nfunction poll(..._: unknown[]) {}\ndeclare const app: { get(path: string, handler: () => void): void };\n';
    assert.deepEqual(ruleIds(source), ['interval-not-cleared'], body);
  }
});

test('interval-not-cleared stays quiet for cleared, owned, startup and framework intervals', () => {
  const quiet = [
    'setInterval(poll, 1000);',
    'const timer = setInterval(poll, 1000);',
    'export function watch() { const timer = setInterval(poll, 1000); return () => clearInterval(timer); }',
    'export function watch() { const timer = setInterval(() => { if (done()) clearInterval(timer); }, 1000); }',
    'export function watch() { return setInterval(poll, 1000); }',
    'export function watch(timers: unknown[]) { timers.push(setInterval(poll, 1000)); }',
    'export function watch() { setInterval(poll, 1000).unref(); }',
    'export function watch() { const timer = setInterval(poll, 1000); timer.unref(); }',
    'class Poller { timer: unknown; start() { this.timer = setInterval(poll, 1000); } stop() { clearInterval(this.timer as number); } }',
    'async function main() { setInterval(poll, 1000); }',
    '(async () => { setInterval(poll, 1000); })();',
    'declare const server: { listen(callback: () => void): void };\nserver.listen(() => { setInterval(poll, 1000); });',
    'export function setInterval(handler: () => void) { handler(); }\nexport function run() { setInterval(poll); }',
    "import { setInterval } from 'node:timers/promises';\nexport function watch() { setInterval(1000); }",
    'declare function useEffect(effect: () => void): void;\nfunction Clock() { useEffect(() => { setInterval(poll, 1000); }, []); }',
    "import { useEffect } from 'react';\nfunction Clock() { useEffect(() => { setInterval(poll, 1000); }, []); }",
    "import { onMounted } from 'vue';\nexport default { setup() { onMounted(() => { setInterval(poll, 1000); }); } };",
    "import { Component } from '@angular/core';\nexport class A { ngOnInit() { setInterval(poll, 1000); } }",
    'export class A { ngOnInit() { setInterval(poll, 1000); } }',
  ];
  for (const body of quiet) {
    const source = body + '\nfunction poll(..._: unknown[]) {}\nfunction done() { return true; }\n';
    assert.deepEqual(ruleIds(source), [], body);
  }
});

test('a pg pool checkout is left to the performance rule', () => {
  const source = lines(
    "import { Pool } from 'pg';",
    'export async function f(pool: Pool) {',
    '  const client = await pool.connect();',
    "  await client.query('select 1');",
    '}',
  );
  assert.deepEqual(ruleIds(source), []);
});

test('the fix wraps the work after the acquisition in try/finally', async (context) => {
  const source = lines(
    "import { open } from 'node:fs/promises';",
    'export async function head(path: string) {',
    "  const handle = await open(path, 'r');",
    '  const { size } = await handle.stat();',
    '  return size;',
    '}',
  );
  const fix = await fixedHunks(context, source);
  assert.equal(fix?.requiresReview, true);
  assert.ok(fix?.note);
  const after = (fix?.changes ?? []).map((change) => change.after).join('\n');
  assert.match(after, /try \{/);
  assert.match(after, /\} finally \{\n\s+await handle\.close\(\);\n\s+\}/);
});

test('the fix moves an existing close into finally', async (context) => {
  const source = lines(
    "import { chromium } from 'playwright';",
    'export async function shot() {',
    '  const browser = await chromium.launch();',
    '  const page = await browser.newPage();',
    '  await page.goto("https://a.test");',
    '  await browser.close();',
    '}',
  );
  const fix = await fixedHunks(context, source);
  const after = (fix?.changes ?? []).map((change) => change.after).join('\n');
  assert.equal(after.match(/browser\.close\(\)/g)?.length, 1);
  assert.match(after, /\} finally \{\n\s+await browser\.close\(\);\n\s+\}/);
});

test('the fix uses release() for query runners and disconnect() for a connected browser', async (context) => {
  const runner = lines(
    "import { DataSource } from 'typeorm';",
    'export async function run(source: DataSource) {',
    '  const runner = source.createQueryRunner();',
    '  await runner.connect();',
    '}',
  );
  const runnerFix = await fixedHunks(context, runner);
  assert.match((runnerFix?.changes ?? []).map((change) => change.after).join('\n'), /await runner\.release\(\);/);
  const connected = lines(
    "import puppeteer from 'puppeteer';",
    'export async function run() {',
    '  const browser = await puppeteer.connect({});',
    '  await browser.newPage();',
    '}',
  );
  const connectedFix = await fixedHunks(context, connected);
  assert.match(
    (connectedFix?.changes ?? []).map((change) => change.after).join('\n'),
    /await browser\.disconnect\(\);/,
  );
});

test('no fix is offered where the release cannot move safely, or for intervals', async (context) => {
  const syncRunner = lines(
    "import { DataSource } from 'typeorm';",
    'export function run(source: DataSource) {',
    '  const runner = source.createQueryRunner();',
    '  runner.connect();',
    '}',
  );
  assert.equal(await fixedHunks(context, syncRunner), undefined);
  const twoCloses = lines(
    "import { open } from 'node:fs/promises';",
    'export async function head(path: string, ok: boolean) {',
    '  const handle = await open(path);',
    '  if (ok) { await handle.close(); return; }',
    '  await handle.stat();',
    '  await handle.close();',
    '}',
  );
  assert.equal(await fixedHunks(context, twoCloses), undefined);
});

test('no fix is offered when a returned promise would outlive the finally block', async (context) => {
  const returnedCall = lines(
    "import { open } from 'node:fs/promises';",
    'export async function read(path: string) {',
    '  const handle = await open(path);',
    '  return handle.readFile();',
    '}',
  );
  assert.equal(await fixedHunks(context, returnedCall), undefined);
  const awaitedCall = returnedCall.replace('return handle', 'return await handle');
  assert.ok(await fixedHunks(context, awaitedCall));
});

test('rel --json reports a leaked file handle with a reviewable fix', (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'loadwise-leak-cli-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(directory, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: { target: 'ES2022', module: 'NodeNext', lib: ['ES2022'], types: [] },
      include: ['*.ts'],
    }),
  );
  fs.writeFileSync(
    path.join(directory, 'reader.ts'),
    lines(
      "import { open } from 'node:fs/promises';",
      'export async function size(file: string) {',
      '  const handle = await open(file);',
      '  const info = await handle.stat();',
      '  return info.size;',
      '}',
    ),
  );
  const run = spawnSync(process.execPath, [bin, 'rel', '--json'], {
    cwd: directory,
    encoding: 'utf8',
    timeout: 120000,
  });
  const report: { findings: Finding[] } = JSON.parse(run.stdout);
  const finding = report.findings.find(({ ruleId }) => ruleId === 'file-handle-not-closed');
  assert.ok(finding, run.stderr);
  assert.equal(finding.line, 3);
  assert.equal(finding.fix?.requiresReview, true);
});

test('interval-not-cleared sees a clearInterval in a function or method written above the timer', () => {
  const hoisted = lines(
    'declare function poll(): void;',
    'export function start() { const timer = setInterval(poll, 1000); return () => stop(timer); }',
    'function stop(handle: unknown) { clearInterval(handle as number); }',
  );
  const closure = lines(
    'declare function poll(): void;',
    'export function run() {',
    '  const stop = () => clearInterval(timer);',
    '  const timer = setInterval(poll, 1000);',
    '  return stop;',
    '}',
  );
  assert.deepEqual(ruleIds(closure), []);
  assert.deepEqual(ruleIds(hoisted), []);
});
