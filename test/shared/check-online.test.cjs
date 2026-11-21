'use strict';

const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { promisify } = require('node:util');

const run = promisify(execFile);
const cli = path.resolve(__dirname, '../../bin/loadwise.cjs');
const packageName = 'loadwise-check-online-fixture';
const advisoryId = 'LOADWISE-TEST-OSV';
const ruleId = 'dependency-known-vulnerability';

async function project(context, { typed = true, remoteFailure = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loadwise-check-online-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dependencies = { [packageName]: '1.0.0' };
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ dependencies }, null, 2));
  fs.writeFileSync(
    path.join(root, 'package-lock.json'),
    JSON.stringify({
      lockfileVersion: 3,
      packages: { '': { dependencies }, [`node_modules/${packageName}`]: { version: '1.0.0' } },
    }),
  );
  if (typed) {
    fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ include: ['*.ts'] }));
    fs.writeFileSync(path.join(root, 'index.ts'), 'export const number = 4;\n');
  }

  const server = http.createServer((request, response) => {
    if (remoteFailure) {
      response.writeHead(503).end();
      return;
    }
    response.setHeader('content-type', 'application/json');
    if (request.url === '/v1/querybatch') {
      response.end(JSON.stringify({ results: [{ vulns: [{ id: advisoryId }] }] }));
      return;
    }
    if (request.url === `/v1/vulns/${advisoryId}`) {
      response.end(JSON.stringify({ id: advisoryId, database_specific: { severity: 'HIGH' } }));
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const env = { ...process.env, LOADWISE_OSV_URL: `http://127.0.0.1:${server.address().port}` };

  async function check(...args) {
    try {
      return { code: 0, ...(await run(process.execPath, [cli, 'check', '--online', ...args], { cwd: root, env })) };
    } catch (error) {
      if (typeof error.code !== 'number') throw error;
      return error;
    }
  }

  return { root, check };
}

test('check --online merges the dependency and source results in one security report', async (context) => {
  const { root, check } = await project(context);
  const structured = await check('--only', 'perf,sec', '--json');
  assert.equal(structured.code, 1, structured.stderr);
  const { performance, security } = JSON.parse(structured.stdout);
  assert.equal(performance.scannedFiles, 1);
  assert.equal(security.scannedFiles, 2);
  assert.equal(security.scannedPackages, 1);
  assert.equal(security.findings.length, 1);
  const [finding] = security.findings;
  assert.equal(finding.ruleId, ruleId);
  assert.equal(path.resolve(root, finding.file), path.join(root, 'package.json'));
  assert.equal(finding.impactLevel, 'high');

  const text = await check('--only', 'perf,sec');
  assert.equal(text.code, 1, text.stderr);
  const [, securitySection] = text.stdout.split('== Security ==\n');
  assert.deepEqual(securitySection.match(/.*file\(s\) checked.*/g), ['2 file(s) checked, 1 finding(s).']);
  assert.doesNotMatch(text.stderr, /skipped them/);

  const sarif = await check('--only', 'sec', '--format', 'sarif');
  assert.equal(sarif.code, 1, sarif.stderr);
  const [securityRun] = JSON.parse(sarif.stdout).runs;
  const [result] = securityRun.results;
  assert.equal(result.ruleId, ruleId);
  assert.equal(result.locations[0].physicalLocation.artifactLocation.uri, 'package.json');
});

test('check --online applies security rule settings and the impact threshold to dependencies', async (context) => {
  const { root, check } = await project(context);
  fs.writeFileSync(path.join(root, 'loadwise.config.json'), JSON.stringify({ rules: { [ruleId]: 'warn' } }));
  const warning = await check('--only', 'sec', '--json');
  assert.equal(warning.code, 0, warning.stderr);
  assert.equal(JSON.parse(warning.stdout).security.findings[0].level, 'warn');

  for (const flags of [
    ['--min-impact', 'critical'],
    ['--ignore', ruleId],
  ]) {
    const filtered = await check('--only', 'perf,sec', '--json', ...flags);
    assert.equal(filtered.code, 0, filtered.stderr);
    assert.deepEqual(JSON.parse(filtered.stdout).security.findings, []);
  }
});

test('check --online can report lockfile findings without a TypeScript configuration', async (context) => {
  const { check } = await project(context, { typed: false });
  const result = await check('--only', 'perf,sec', '--json');
  assert.equal(result.code, 1, result.stderr);
  const { performance, security } = JSON.parse(result.stdout);
  assert.equal(performance, null);
  assert.equal(security.findings[0].ruleId, ruleId);
});

test('check --online includes dependency findings when no source lines are staged', async (context) => {
  const { root, check } = await project(context);
  await run('git', ['init', '--quiet'], { cwd: root });
  const result = await check('--only', 'perf,sec', '--json', '--staged');
  assert.equal(result.code, 1, result.stderr);
  const { performance, security } = JSON.parse(result.stdout);
  assert.equal(performance.scannedFiles, 0);
  assert.equal(security.scannedFiles, 1);
  assert.equal(security.findings[0].ruleId, ruleId);
});

test('check --online writes and applies a baseline covering dependency findings', async (context) => {
  const { check } = await project(context);
  const written = await check('--only', 'perf,sec', '--write-baseline');
  assert.equal(written.code, 0, written.stderr);
  const filtered = await check('--only', 'perf,sec', '--baseline', '--json');
  assert.equal(filtered.code, 0, filtered.stderr);
  const { security } = JSON.parse(filtered.stdout);
  assert.equal(security.baselineHidden, 1);
  assert.deepEqual(security.findings, []);
});

test('check --online keeps the performance result when OSV fails', async (context) => {
  const { check } = await project(context, { remoteFailure: true });
  const result = await check('--only', 'perf,sec', '--json');
  assert.equal(result.code, 2, result.stderr);
  assert.match(result.stderr, /HTTP 503/);
  const { performance, security } = JSON.parse(result.stdout);
  assert.equal(performance.scannedFiles, 1);
  assert.equal(security, null);
});
