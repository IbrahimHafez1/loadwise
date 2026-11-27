import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { lint } from './helpers.js';
import { requireFix, scanWithFixes } from './site-fix-helpers.js';
import type { Finding } from '../../lib/shared/types.js';
import type { FileMap } from '../types/project-files.js';

const timeoutRule = 'http-call-without-timeout';
const syncFsRule = 'node-sync-fs-in-async';
const axiosTypes = `
  export interface AxiosRequestConfig { timeout?: number; signal?: AbortSignal; headers?: object; data?: unknown }
  export interface AxiosStatic {
    (config: AxiosRequestConfig): Promise<unknown>;
    get(url: string, config?: AxiosRequestConfig): Promise<unknown>;
    post(url: string, data?: unknown, config?: AxiosRequestConfig): Promise<unknown>;
  }
  declare const axios: AxiosStatic;
  export default axios;`;
const axiosFiles: FileMap = { 'node_modules/axios/index.d.ts': axiosTypes };
const awsFiles: FileMap = {
  'node_modules/@aws-sdk/client-s3/index.d.ts': `
    export interface S3ClientConfig { region?: string; requestHandler?: unknown }
    export class GetObjectCommand { constructor(input: object) }
    export class S3Client {
      constructor(config?: S3ClientConfig);
      send(command: object, options?: { abortSignal?: AbortSignal }): Promise<unknown>;
    }`,
};

function ruleLines(findings: Finding[], rule: string) {
  return findings.filter((finding: Finding) => finding.ruleId === rule).map((finding: Finding) => finding.line);
}

function lintLines(source: string, rule: string, files: FileMap = {}) {
  return ruleLines(lint(source, files), rule);
}

function scannedByFile(context: TestContext, files: FileMap, rule: string) {
  const { root, findings } = scanWithFixes(context, files);
  const byFile: Record<string, Finding[]> = {};
  for (const finding of findings.filter((entry) => entry.ruleId === rule)) {
    const name = path.relative(root, finding.file ?? '').replaceAll('\\', '/');
    (byFile[name] ??= []).push(finding);
  }
  return byFile;
}

function s3Class(sendOptions: string, extraMember = '') {
  return [
    "import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';",
    'export class Storage {',
    '  private readonly client?: S3Client;',
    '  constructor(enabled: boolean) {',
    "    if (enabled) this.client = new S3Client({ region: 'auto' });",
    '  }',
    '  get enabled() { return !!this.client; }',
    '  async read(key: string) {',
    "    if (!this.client) throw new Error('off');",
    `    return this.client.send(new GetObjectCommand({ key })${sendOptions});`,
    '  }',
    extraMember,
    '}',
  ].join('\n');
}

test('an S3 client whose every send passes an abortSignal is quiet', () => {
  assert.deepEqual(lintLines(s3Class(', { abortSignal: AbortSignal.timeout(60_000) }'), timeoutRule, awsFiles), []);
});

test('an S3 client is reported when a send lacks an abortSignal or the client escapes', () => {
  assert.deepEqual(lintLines(s3Class(''), timeoutRule, awsFiles), [5]);
  const escaped = s3Class(', { abortSignal: AbortSignal.timeout(60_000) }', '  raw() { return this.client; }');
  assert.deepEqual(lintLines(escaped, timeoutRule, awsFiles), [5]);
  const exported = [
    "import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';",
    "export const client = new S3Client({ region: 'auto' });",
    'export const read = () => client.send(new GetObjectCommand({}), { abortSignal: AbortSignal.timeout(1000) });',
  ].join('\n');
  assert.deepEqual(lintLines(exported, timeoutRule, awsFiles), [2]);
});

test('root-relative fetch URLs, directly or through a const, are browser calls', () => {
  const source = [
    "const ENDPOINT = '/api/internal/imports';",
    'export async function load(id: string) {',
    '  await fetch(`/api/v3/surveys/${id}`);',
    '  await fetch(ENDPOINT);',
    "  const url = id ? `/api/v3/surveys?from=${id}` : '/api/v3/surveys';",
    '  await fetch(url);',
    "  const mixed = id ? '/api/x' : 'https://a.test/x';",
    '  await fetch(mixed);',
    "  await fetch('//cdn.test/x');",
    "  await fetch('https://a.test/api');",
    '}',
  ].join('\n');
  assert.deepEqual(lintLines(source, timeoutRule), [8, 9, 10]);
});

test('browser modules are skipped: client-only paths and imports, React hooks, browser globals on load', (context) => {
  const call = "export async function load() { return fetch('https://a.test/x'); }";
  const byFile = scannedByFile(
    context,
    {
      'lib/client-only/download.ts': call,
      'lib/hooks/use-auth.ts': `import { useCallback } from 'react';\n${call}`,
      'lib/marker/only.ts': `import 'client-only';\n${call}`,
      'src/admin/handler.js': `const adminUrl = window.location.href;\n${call}`,
      'src/counts/counts.js': `(async function () {\n  const api = document.querySelector('x');\n  await fetch('https://a.test');\n})();`,
      'playwright/utils/helper.ts': call,
      'core/__fixtures__/bundle.ts': call,
      'server/typed.ts': `import type { useState } from 'react';\n${call}`,
      'server/guarded.ts': `const href = typeof window !== 'undefined' ? window.location.href : '';\n${call}`,
      'server/lazy.ts': `export function href() { return window.location.href; }\n${call}`,
    },
    timeoutRule,
  );
  assert.deepEqual(Object.keys(byFile).sort(), ['server/guarded.ts', 'server/lazy.ts', 'server/typed.ts']);
});

test('a const options object is checked like a literal', () => {
  const source = [
    "import axios from 'axios';",
    'export async function exchange(body: object) {',
    "  const config = { headers: { 'Content-Type': 'application/json' } };",
    "  await axios.post('https://slack.test/oauth', body, config);",
    '  const limited = { timeout: 5_000 };',
    "  await axios.post('https://slack.test/oauth', body, limited);",
    '  const patched = { headers: {} } as { headers: object; timeout?: number };',
    '  patched.timeout = 5_000;',
    "  await axios.post('https://slack.test/oauth', body, patched);",
    '}',
  ].join('\n');
  assert.deepEqual(lintLines(source, timeoutRule, axiosFiles), [4]);
});

test('default axios is recognised by its import when its types do not resolve', () => {
  const source = [
    "import axios from 'axios';",
    "export async function load() { await axios.get('https://a.test'); }",
  ].join('\n');
  assert.deepEqual(lintLines(source, timeoutRule), [2]);
  const local = "declare const axios: any;\nexport async function load() { await axios.get('https://a.test'); }";
  assert.deepEqual(lintLines(local, timeoutRule), []);
});

test('timeout fixes on request bodies or long-running endpoints require review', (context) => {
  const { findings } = scanWithFixes(context, {
    ...axiosFiles,
    'a.ts': [
      "import axios from 'axios';",
      'export async function predict(url: string, form: FormData) {',
      "  await fetch(new URL('predict', url), { method: 'POST', body: form });",
      "  await fetch('https://a.test/export/csv');",
      "  await axios.post('https://a.test/items', { name: 'x' });",
      "  await fetch('https://a.test/status');",
      "  await axios.get('https://a.test/status');",
      '}',
    ].join('\n'),
  });
  const reviewed = findings
    .filter((finding) => finding.ruleId === timeoutRule)
    .map((finding) => [finding.line, Boolean(requireFix(finding).requiresReview)]);
  assert.deepEqual(reviewed, [
    [3, true],
    [4, true],
    [5, true],
    [6, false],
    [7, false],
  ]);
});

test('a NestJS-style const bootstrap invoked once at load is a process entry', () => {
  const entry = (tail: string) =>
    [
      "import * as fs from 'node:fs';",
      'const bootstrap = async () => {',
      "  const key = fs.readFileSync('key.pem');",
      '  return key;',
      '};',
      tail,
    ].join('\n');
  const reasons = (source: string) =>
    lint(source)
      .filter((finding: Finding) => finding.ruleId === syncFsRule)
      .map((finding: Finding) => finding.contextualReason);
  const [voidReason] = reasons(entry('void bootstrap();'));
  assert.ok(voidReason);
  assert.match(voidReason, /private process entry point/);
  const [catchReason] = reasons(entry('bootstrap().catch(console.error);'));
  assert.ok(catchReason);
  assert.match(catchReason, /private process entry point/);
  assert.deepEqual(reasons(entry('void bootstrap();\nexport { bootstrap };')), [undefined]);
  assert.deepEqual(reasons(entry('void bootstrap();\nsetInterval(bootstrap, 1000);')), [undefined]);
});

test('sync calls in src/commands are CLI context, other paths are not', (context) => {
  const source = [
    "import { readFileSync } from 'node:fs';",
    "export default async function exec(file: string) { return readFileSync(file, 'utf8'); }",
  ].join('\n');
  const byFile = scannedByFile(
    context,
    { 'src/commands/exec.ts': source, 'src/users/commands/create.ts': source },
    syncFsRule,
  );
  const commandReason = byFile['src/commands/exec.ts'][0].contextualReason;
  assert.ok(commandReason);
  assert.match(commandReason, /CLI command/);
  assert.equal(byFile['src/users/commands/create.ts'][0].contextualReason, undefined);
});

test('a plain request handler that reads a file per request is reported without a fix', (context) => {
  const files = {
    'controller.ts': [
      "import * as fs from 'node:fs';",
      'export function adminController(req: unknown, res: { send(body: unknown): void }) {',
      "  const file = fs.readFileSync('index.html');",
      '  res.send(file);',
      '}',
      'export function helper(path: string) { return fs.readFileSync(path); }',
      "export function hash(req: unknown, res: unknown) { return require('node:crypto').scryptSync('a', 'b', 8); }",
      'export function later(req: unknown, res: unknown) {',
      "  return () => fs.readFileSync('x');",
      '}',
    ].join('\n'),
  };
  const { findings } = scanWithFixes(context, files);
  const reported = findings.filter((finding) => finding.ruleId.startsWith('node-sync-'));
  assert.deepEqual(
    reported.map((finding) => [finding.ruleId, finding.line]),
    [[syncFsRule, 3]],
  );
  assert.match(reported[0].message, /on every request to this handler/);
  assert.equal(reported[0].fix, undefined);
});
