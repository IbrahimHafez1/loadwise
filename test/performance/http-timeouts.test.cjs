const { test } = require('node:test');
const assert = require('node:assert/strict');
const { lint } = require('./helpers.cjs');
const { scanWithFixes, onlyChange } = require('./site-fix-helpers.cjs');

const axiosTypes = `
  export interface AxiosRequestConfig { timeout?: number; signal?: AbortSignal; url?: string }
  export interface AxiosInstance {
    (config: AxiosRequestConfig): Promise<unknown>;
    get(url: string, config?: AxiosRequestConfig): Promise<unknown>;
    post(url: string, data?: unknown, config?: AxiosRequestConfig): Promise<unknown>;
  }
  export interface AxiosStatic extends AxiosInstance { create(config?: AxiosRequestConfig): AxiosInstance }
  declare const axios: AxiosStatic;
  export default axios;`;
const files = { 'node_modules/axios/index.d.ts': axiosTypes };
const axiosHeader = "import axios from 'axios';\n";
const rule = 'http-call-without-timeout';

function findings(source, extraFiles = files) {
  return lint(source, extraFiles).filter((finding) => finding.ruleId === rule);
}

test('fetch without options or without a signal is reported', () => {
  assert.equal(findings("async function run() { await fetch('https://a.test'); }").length, 1);
  assert.equal(findings("async function run() { await fetch('https://a.test', { method: 'POST' }); }").length, 1);
});

test('fetch with a signal, spread options, a variable, or a Request is quiet', () => {
  assert.deepEqual(
    findings("async function run() { await fetch('https://a.test', { signal: AbortSignal.timeout(5000) }); }"),
    [],
  );
  assert.deepEqual(
    findings("async function run(opts: RequestInit) { await fetch('https://a.test', { ...opts }); }"),
    [],
  );
  assert.deepEqual(findings("async function run(opts: RequestInit) { await fetch('https://a.test', opts); }"), []);
  assert.deepEqual(
    findings('declare class Request {}\nasync function run(request: Request) { await fetch(request); }'),
    [],
  );
});

test('a project function named fetch is quiet', () => {
  assert.deepEqual(findings("function fetch(url: string) { return url; }\nfetch('x');"), []);
});

test('axios default instance without timeout is reported, with timeout or a created instance is quiet', () => {
  assert.equal(findings(`${axiosHeader}async function run() { await axios.get('/x'); }`).length, 1);
  assert.equal(findings(`${axiosHeader}async function run() { await axios({ url: '/x' }); }`).length, 1);
  assert.equal(
    findings(`${axiosHeader}async function run() { await axios.post('/x', {}, { signal: undefined }); }`).length,
    0,
  );
  assert.deepEqual(findings(`${axiosHeader}async function run() { await axios.get('/x', { timeout: 5000 }); }`), []);
  assert.deepEqual(
    findings(
      `${axiosHeader}const client = axios.create({ timeout: 1000 });\nasync function run() { await client.get('/x'); }`,
    ),
    [],
  );
});

test('client-side files are skipped', () => {
  assert.deepEqual(findings("'use client';\nasync function run() { await fetch('/x'); }"), []);
});

test('fix adds a signal argument or property', (context) => {
  const { findings: scanned } = scanWithFixes(context, {
    'a.ts': [
      "export async function one() { await fetch('https://a.test'); }",
      "export async function two() { await fetch('https://a.test', { method: 'POST' }); }",
      'export async function three() {',
      "  await fetch('https://a.test', {",
      "    method: 'POST',",
      '  });',
      '}',
    ].join('\n'),
  });
  const fixes = scanned.filter((finding) => finding.ruleId === rule).map(onlyChange);
  assert.equal(fixes.length, 3);
  assert.match(fixes[0].after, /fetch\('https:\/\/a\.test', \{ signal: AbortSignal\.timeout\(10_000\) \}\)/);
  assert.match(fixes[1].after, /\{ method: 'POST', signal: AbortSignal\.timeout\(10_000\) \}/);
  assert.match(fixes[2].after, /method: 'POST',\nsignal: AbortSignal\.timeout\(10_000\),/);
});

test('axios fix adds a timeout', (context) => {
  const { findings: scanned } = scanWithFixes(context, {
    ...files,
    'a.ts': `${axiosHeader}export async function run() { await axios.get('/x'); }`,
  });
  const [finding] = scanned.filter((entry) => entry.ruleId === rule);
  assert.match(onlyChange(finding).after, /axios\.get\('\/x', \{ timeout: 10_000 \}\)/);
  assert.match(finding.fix.note, /placeholder/);
});

test('AWS SDK v3 clients without requestHandler timeouts are reported', () => {
  const awsFiles = {
    'node_modules/@aws-sdk/client-s3/index.d.ts': `
      export interface S3ClientConfig { region?: string; requestHandler?: unknown }
      export class S3Client { constructor(config?: S3ClientConfig) }`,
  };
  const source = [
    "import { S3Client } from '@aws-sdk/client-s3';",
    'class LocalClient { constructor(config?: object) {} }',
    'declare const shared: object;',
    "export const bare = new S3Client({ region: 'auto' });",
    'export const none = new S3Client();',
    "export const limited = new S3Client({ region: 'auto', requestHandler: { requestTimeout: 30_000 } });",
    'export const spread = new S3Client({ ...shared });',
    'export const local = new LocalClient({});',
  ].join('\n');
  const reported = findings(source, awsFiles);
  assert.deepEqual(
    reported.map((finding) => finding.line),
    [4, 5],
  );
  assert.match(reported[0].message, /requestHandler: \{ requestTimeout/);
});

function pathFindings(fileName, source) {
  const { withProgram } = require('./helpers.cjs');
  return withProgram('export {};', { [fileName]: source }, (program) => {
    const sourceFile = program.getSourceFiles().find((candidate) => candidate.fileName.endsWith(fileName));
    return require('../../lib/performance/analyze.cjs')
      .analyzeFile(program, sourceFile)
      .filter((finding) => finding.ruleId === rule);
  });
}

const bareFetch = "export async function run() { await fetch('https://a.test/x'); }";

test('a fetch raced against its own timer is contextual, a lone fetch in Promise.race is not', () => {
  const raced = (other) =>
    `export async function run() { await Promise.race([fetch('https://a.test').catch(() => null), ${other}]); }`;
  const [withTimer] = findings(raced('new Promise((resolve) => { setTimeout(resolve, 150); })'));
  assert.match(withTimer.contextualReason, /not aborted/);
  const [withoutTimer] = findings(raced('new Promise((resolve) => { resolve(null); })'));
  assert.equal(withoutTimer.contextualReason, undefined);
});

test('fetch options only a browser normally uses make the call contextual', () => {
  const [direct] = findings("export async function run(url: string) { await fetch(url, { mode: 'cors' }); }");
  assert.match(direct.contextualReason, /browser/);
  const source =
    "export async function run(url: string, credentials?: RequestCredentials) { const options = { method: 'GET', credentials }; return fetch(url, options); }";
  assert.match(findings(source)[0].contextualReason, /browser/);
});

test('a loopback URL is contextual, a remote URL stays at default level', () => {
  const [local] = findings("export async function run() { await fetch('http://localhost:9119/handshake'); }");
  assert.match(local.contextualReason, /loopback/);
  const [remote] = findings(bareFetch);
  assert.equal(remote.contextualReason, undefined);
});

test('calls in a seed script, release tool or client SDK are contextual', () => {
  for (const fileName of ['db/seed-saml.ts', 'packages/release-notes-generator/src/a.ts', 'packages/js-sdk/src/a.ts']) {
    const [finding] = pathFindings(fileName, bareFetch);
    assert.ok(finding.contextualReason, fileName);
  }
});

test('a command-line client and a server route stay at default level', () => {
  for (const fileName of ['packages/cli/src/commands/asset.ts', 'app/api/route.ts']) {
    const [finding] = pathFindings(fileName, bareFetch);
    assert.equal(finding.contextualReason, undefined, fileName);
  }
});
