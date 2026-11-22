'use strict';

// Regressions found by running loadwise on real projects (juice-shop, cuspa, infisical).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');
const { scan } = require('../../lib/maintainability/scan.cjs');
const { scanChangedFiles } = require('../../lib/maintainability/scan-changed.cjs');
const { applyChangesToText } = require('../../editor/apply-fix.cjs');
const { scanWithFixes } = require('../performance/site-fix-helpers.cjs');

test('maint skips an unparsable file with a note instead of failing the whole scan', async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loadwise-c4-maint-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'broken.ts'), "import { helper } from './helper';\nexport const = helper;\n");
  fs.writeFileSync(path.join(root, 'helper.ts'), 'export const helper = 1;\n');
  const notes = [];
  context.mock.method(console, 'error', (message) => notes.push(message));
  const policy = { exclude: [], boundaries: [], placement: [] };
  for (const parallelFrom of [Infinity, 1]) {
    const report = await scan(root, policy, { parallelFrom });
    assert.equal(report.dependencyFiles, 2);
    // The broken file still counts as importing helper.ts, so helper.ts is not reported unused.
    assert.ok(!report.findings.some((finding) => finding.file === 'helper.ts'));
  }
  const changed = await scanChangedFiles(root, policy, ['broken.ts', 'helper.ts']);
  assert.equal(changed.dependencyFiles, 2);
  const note = 'Note: broken.ts:2:14 Variable declaration expected. Skipped that file, which does not parse.';
  assert.deepEqual(notes, [note, note, note]);
});

// Just enough of Node's types for the rewritten files to type-check.
const nodeTypes = `
declare module 'node:fs' {
  export function copyFileSync(from: string, to: string): void;
  export function readdirSync(folder: string): string[];
  export function readFileSync(file: string): string;
  export function writeFileSync(file: string, body: string): void;
  export function existsSync(file: string): boolean;
}
declare module 'node:fs/promises' {
  export function copyFile(from: string, to: string): Promise<void>;
  export function readdir(folder: string): Promise<string[]>;
  export function readFile(file: string): Promise<string>;
  export function writeFile(file: string, body: string): Promise<void>;
}
declare module 'node:util' {
  export function promisify(callback: (...args: any[]) => void): (...args: any[]) => Promise<any>;
}
declare module 'node:zlib' {
  export function gunzipSync(body: Uint8Array): Uint8Array;
  export function gunzip(body: Uint8Array, done: (error: Error | null, result: Uint8Array) => void): void;
}
declare module 'node:crypto' {
  export function scryptSync(password: string, salt: string, length: number): Uint8Array;
  export function scrypt(password: string, salt: string, length: number, done: (error: Error | null, key: Uint8Array) => void): void;
}
`;

function fixedFindings(context, ruleId, source) {
  const { findings } = scanWithFixes(context, { 'app.ts': source, 'node.d.ts': nodeTypes });
  // existsSync has no promise twin, so its finding comes without a fix.
  const matching = findings.filter((finding) => finding.ruleId === ruleId && finding.fix);
  assert.ok(matching.length > 0, 'the rule should offer fixes');
  return matching;
}

// Applies the fixes' changes together, sharing identical changes once as `loadwise fix` does.
function applied(source, fixes) {
  const changes = new Map();
  for (const fix of fixes) for (const change of fix.changes) changes.set(JSON.stringify(change), change);
  const result = applyChangesToText(source, [...changes.values()], { exactLocation: true });
  assert.equal(result.error, undefined);
  return result.text;
}

function compileErrors(context, text) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loadwise-c4-compile-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'app.ts'), text);
  fs.writeFileSync(path.join(root, 'node.d.ts'), nodeTypes);
  const program = ts.createProgram([path.join(root, 'app.ts'), path.join(root, 'node.d.ts')], {
    strict: true,
    noEmit: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    types: [],
    lib: ['lib.es2022.d.ts'],
  });
  return ts
    .getPreEmitDiagnostics(program)
    .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, ' '));
}

function assertEachAloneAndAllTogetherCompile(context, source, findings) {
  assert.deepEqual(compileErrors(context, source), []);
  for (const finding of findings) assert.deepEqual(compileErrors(context, applied(source, [finding.fix])), []);
  const together = applied(
    source,
    findings.map((finding) => finding.fix),
  );
  assert.deepEqual(compileErrors(context, together), []);
  return together;
}

test('node-sync-fs-in-async fixes each import what they use and compose in one file', (context) => {
  const source = `import { copyFileSync, existsSync, readdirSync } from 'node:fs'

export const restore = async () => {
  copyFileSync('a', 'b')
  if (existsSync('dist')) {
    copyFileSync('c', 'd')
  }
  const files = readdirSync('folder')
  for (const file of files) {
    copyFileSync(file, 'out/' + file)
  }
}
`;
  const findings = fixedFindings(context, 'node-sync-fs-in-async', source);
  assert.equal(findings.length, 4);
  for (const finding of findings) assert.equal(finding.fix.note, undefined);
  const together = assertEachAloneAndAllTogetherCompile(context, source, findings);
  assert.match(
    together,
    /^import \{ copyFileSync, existsSync, readdirSync \} from 'node:fs'\nimport \{ copyFile, readdir \} from 'node:fs\/promises'\n/,
  );
  assert.equal((together.match(/await /g) ?? []).length, 4);
});

test('two node-sync-fs-in-async fixes on one import line no longer conflict', (context) => {
  const source = `import { readFileSync, writeFileSync } from 'node:fs';

export async function regenerate(file: string) {
  const text = readFileSync(file);
  writeFileSync(file, text);
}
`;
  const findings = fixedFindings(context, 'node-sync-fs-in-async', source);
  assert.equal(findings.length, 2);
  assertEachAloneAndAllTogetherCompile(context, source, findings);
});

test('a single node-sync-fs-in-async site still swaps the sync import for the promise one', (context) => {
  const source = `import { readFileSync } from 'node:fs';

export async function load(file: string) {
  return readFileSync(file);
}
`;
  const [finding] = fixedFindings(context, 'node-sync-fs-in-async', source);
  const fixed = applied(source, [finding.fix]);
  assert.match(fixed, /^import \{ readFile \} from 'node:fs\/promises';\n/);
  assert.deepEqual(compileErrors(context, fixed), []);
});

test('node-sync-compression-in-async fixes import promisify and the callback form', (context) => {
  const source = `import { gunzipSync } from 'node:zlib';

export async function unpack(body: Uint8Array, other: Uint8Array) {
  const first = gunzipSync(body);
  const second = gunzipSync(other);
  return [first, second];
}
`;
  const findings = fixedFindings(context, 'node-sync-compression-in-async', source);
  assert.equal(findings.length, 2);
  for (const finding of findings) assert.equal(finding.fix.note, undefined);
  assertEachAloneAndAllTogetherCompile(context, source, findings);
});

test('node-sync-crypto-in-async fixes import promisify and the callback form', (context) => {
  const source = `import { scryptSync } from 'node:crypto';

export async function derive(password: string, salt: string) {
  return scryptSync(password, salt, 64);
}
`;
  const findings = fixedFindings(context, 'node-sync-crypto-in-async', source);
  for (const finding of findings) assert.equal(finding.fix.note, undefined);
  const fixed = assertEachAloneAndAllTogetherCompile(context, source, findings);
  assert.match(
    fixed,
    /^import \{ scryptSync \} from 'node:crypto';\nimport \{ scrypt \} from 'node:crypto';\nimport \{ promisify \} from 'node:util';\n/,
  );
});
