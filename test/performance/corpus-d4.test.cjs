'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { lint } = require('./helpers.cjs');
const { scanWithFixes } = require('./site-fix-helpers.cjs');

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
const axiosFiles = { 'node_modules/axios/index.d.ts': axiosTypes };
const awsFiles = {
  'node_modules/@aws-sdk/client-s3/index.d.ts': `
    export interface S3ClientConfig { region?: string; requestHandler?: unknown }
    export class GetObjectCommand { constructor(input: object) }
    export class S3Client {
      constructor(config?: S3ClientConfig);
      send(command: object, options?: { abortSignal?: AbortSignal }): Promise<unknown>;
    }`,
};

function ruleLines(findings, rule) {
  return findings.filter((finding) => finding.ruleId === rule).map((finding) => finding.line);
}

function lintLines(source, rule, files = {}) {
  return ruleLines(lint(source, files), rule);
}

function scannedByFile(context, files, rule) {
  const { root, findings } = scanWithFixes(context, files);
  const byFile = {};
  for (const finding of findings.filter((entry) => entry.ruleId === rule)) {
    const name = path.relative(root, finding.file).replaceAll('\\', '/');
    (byFile[name] ??= []).push(finding);
  }
  return byFile;
}

function s3Class(sendOptions, extraMember = '') {
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
    .map((finding) => [finding.line, Boolean(finding.fix.requiresReview)]);
  assert.deepEqual(reviewed, [
    [3, true],
    [4, true],
    [5, true],
    [6, false],
    [7, false],
  ]);
});

