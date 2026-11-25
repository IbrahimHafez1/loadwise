import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { scanDependencies } from '../../lib/security/deps/scan.js';
import { findLockfile, readLockfilePackages } from '../../lib/security/deps/lockfiles.js';
import { cvssV3BaseScore } from '../../lib/security/deps/advisory.js';
import { main as depsMain } from '../../lib/security/deps/cli.js';
import { main as securityMain } from '../../lib/security/cli.js';
import { asResponse } from '../types/osv-fake.js';
import type { TestContext } from 'node:test';
import type { OsvRecord, VulnerabilityLookupOptions } from '../../lib/security/types/osv-vulnerability.js';
import type { Finding } from '../../lib/shared/types.js';
import type { FakeOsvCall } from '../types/osv-fake.js';

const bin = path.resolve(import.meta.dirname, '../../bin/loadwise.js');
const dayMs = 24 * 60 * 60 * 1000;
const manifest = JSON.stringify(
  { name: 'app', dependencies: { alpha: '^1.0.0' }, devDependencies: { beta: '^2.0.0' } },
  null,
  2,
);

const npmLock = JSON.stringify(
  {
    lockfileVersion: 3,
    packages: {
      '': { name: 'app', dependencies: { alpha: '^1.0.0' }, devDependencies: { beta: '^2.0.0' } },
      'node_modules/alpha': { version: '1.0.0' },
      'node_modules/beta': { version: '2.0.0', dev: true },
      'node_modules/alpha/node_modules/@scope/gamma': { version: '3.0.0' },
      'node_modules/linked': { link: true, resolved: 'packages/linked' },
    },
  },
  null,
  2,
);

const pnpmV9Lock = `lockfileVersion: '9.0'

importers:

  .:
    dependencies:
      alpha:
        specifier: ^1.0.0
        version: 1.0.0
    devDependencies:
      beta:
        specifier: ^2.0.0
        version: 2.0.0(peer@1.0.0)

packages:

  '@scope/gamma@3.0.0':
    resolution: {integrity: sha512-aaa}

  alpha@1.0.0:
    resolution: {integrity: sha512-bbb}

  beta@2.0.0:
    resolution: {integrity: sha512-ccc}

  devtool@4.0.0:
    resolution: {integrity: sha512-ddd}

snapshots:

  '@scope/gamma@3.0.0': {}

  alpha@1.0.0:
    dependencies:
      '@scope/gamma': 3.0.0

  beta@2.0.0(peer@1.0.0):
    dependencies:
      devtool: 4.0.0

  devtool@4.0.0: {}
`;

const pnpmV6Lock = `lockfileVersion: '6.0'

dependencies:
  alpha:
    specifier: ^1.0.0
    version: 1.0.0

devDependencies:
  beta:
    specifier: ^2.0.0
    version: 2.0.0

packages:

  /alpha@1.0.0:
    resolution: {integrity: sha512-bbb}
    dev: false

  /beta@2.0.0:
    resolution: {integrity: sha512-ccc}
    dev: true
`;

const yarnV1Lock = `# yarn lockfile v1


alpha@^1.0.0, alpha@^1.1.0:
  version "1.2.0"
  resolved "https://registry.yarnpkg.com/alpha/-/alpha-1.2.0.tgz#abc"

"@scope/gamma@^3.0.0":
  version "3.0.0"

beta@^2.0.0:
  version "2.0.0"
`;

const yarnBerryLock = `__metadata:
  version: 8

"alpha@npm:^1.0.0":
  version: 1.2.0
  resolution: "alpha@npm:1.2.0"

"app@workspace:.":
  version: 0.0.0-use.local
  resolution: "app@workspace:."

"@scope/gamma@npm:^3.0.0":
  version: 3.0.0

"beta@npm:^2.0.0":
  version: 2.0.0
`;

function project(context: TestContext, files: Record<string, string>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loadwise-deps-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [name, text] of Object.entries({ 'package.json': manifest, ...files })) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), text);
  }
  return root;
}

// The finding of a dependency scan for one package; `package` is detail the scan attaches to its
// findings.
function findingOfPackage(findings: readonly Finding[], packageName: string): Finding {
  const found = findings.find(({ package: scanned }) => {
    return typeof scanned === 'object' && scanned !== null && 'name' in scanned && scanned.name === packageName;
  });
  assert.ok(found, `no finding for ${packageName}`);
  return found;
}

function packagesOf(root: string) {
  const location = findLockfile(root);
  assert.ok(location);
  const packages = readLockfilePackages(location);
  return Object.fromEntries(packages.map((entry) => [`${entry.name}@${entry.version}`, entry]));
}

function vulnerability(id: string, overrides: Partial<OsvRecord> = {}): OsvRecord {
  return {
    id,
    aliases: [],
    summary: `Summary of ${id}`,
    database_specific: { severity: 'HIGH' },
    affected: [
      {
        package: { ecosystem: 'npm', name: 'alpha' },
        ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }, { fixed: '1.0.5' }] }],
      },
    ],
    ...overrides,
  };
}

// Answers OSV requests from `vulnerabilitiesByPackage` ("name@version" -> records) and records
// every call.
function fakeOsv(vulnerabilitiesByPackage: Record<string, OsvRecord[]>) {
  const calls: FakeOsvCall[] = [];
  const byId = new Map(
    Object.values(vulnerabilitiesByPackage)
      .flat()
      .map((record): [string, OsvRecord] => [record.id, record]),
  );
  async function fetchImpl(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
    const url = String(input);
    const call: FakeOsvCall = { url, body: init.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    assert.ok(init.signal, 'every request carries a timeout signal');
    if (url.endsWith('/v1/querybatch')) {
      assert.ok(call.body);
      const results = call.body.queries.map(({ package: { name }, version }) => ({
        vulns: (vulnerabilitiesByPackage[`${name}@${version}`] ?? []).map(({ id }) => ({ id })),
      }));
      return asResponse({ ok: true, status: 200, json: async () => ({ results }) });
    }
    const record = byId.get(decodeURIComponent(url.split('/v1/vulns/')[1]));
    return asResponse({ ok: Boolean(record), status: record ? 200 : 404, json: async () => record });
  }
  return { fetchImpl, calls };
}

function cacheDirectory(context: TestContext) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'loadwise-deps-cache-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function scanOptionsFor(
  context: TestContext,
  vulnerabilitiesByPackage: Record<string, OsvRecord[]>,
): VulnerabilityLookupOptions {
  return { fetchImpl: fakeOsv(vulnerabilitiesByPackage).fetchImpl, cacheDirectory: cacheDirectory(context) };
}

async function captured(run: () => Promise<number>) {
  const lines: string[] = [];
  const original = console.log;
  console.log = (line: string) => lines.push(line);
  try {
    return { code: await run(), lines };
  } finally {
    console.log = original;
  }
}

test('package-lock.json v3 gives direct, dev and nested packages with their lockfile lines', (context) => {
  const packages = packagesOf(project(context, { 'package-lock.json': npmLock }));
  assert.deepEqual(Object.keys(packages), ['alpha@1.0.0', 'beta@2.0.0', '@scope/gamma@3.0.0']);
  assert.equal(packages['alpha@1.0.0'].direct, true);
  assert.equal(packages['beta@2.0.0'].dev, true);
  assert.equal(packages['@scope/gamma@3.0.0'].direct, false);
  const gammaLine = npmLock.split('\n')[packages['@scope/gamma@3.0.0'].line - 1];
  assert.equal(gammaLine.trim(), '"node_modules/alpha/node_modules/@scope/gamma": {');
});

test('pnpm-lock.yaml v9 and v6 give packages, direct flags and dev-only reachability', (context) => {
  const v9 = packagesOf(project(context, { 'pnpm-lock.yaml': pnpmV9Lock }));
  assert.deepEqual(Object.keys(v9), ['@scope/gamma@3.0.0', 'alpha@1.0.0', 'beta@2.0.0', 'devtool@4.0.0']);
  const flags = (key: string) => [v9[key].direct, v9[key].dev];
  assert.deepEqual(flags('alpha@1.0.0'), [true, false]);
  assert.deepEqual(flags('@scope/gamma@3.0.0'), [false, false]);
  assert.deepEqual(flags('beta@2.0.0'), [true, true]);
  assert.deepEqual(flags('devtool@4.0.0'), [false, true]);
  assert.equal(pnpmV9Lock.split('\n')[v9['alpha@1.0.0'].line - 1], '  alpha@1.0.0:');
  const v6 = packagesOf(project(context, { 'pnpm-lock.yaml': pnpmV6Lock }));
  assert.deepEqual(Object.keys(v6), ['alpha@1.0.0', 'beta@2.0.0']);
  assert.deepEqual([v6['alpha@1.0.0'].dev, v6['beta@2.0.0'].dev], [false, true]);
});

test('yarn.lock v1 and berry give resolved versions and skip workspace entries', (context) => {
  for (const lock of [yarnV1Lock, yarnBerryLock]) {
    const packages = packagesOf(project(context, { 'yarn.lock': lock }));
    assert.deepEqual(Object.keys(packages), ['alpha@1.2.0', '@scope/gamma@3.0.0', 'beta@2.0.0']);
    assert.deepEqual([packages['alpha@1.2.0'].direct, packages['alpha@1.2.0'].dev], [true, false]);
    assert.deepEqual([packages['beta@2.0.0'].direct, packages['beta@2.0.0'].dev], [true, true]);
    assert.equal(packages['@scope/gamma@3.0.0'].direct, false);
  }
});

test('a vulnerable direct dependency is one finding at its package.json line with an install command', async (context) => {
  const root = project(context, { 'package-lock.json': npmLock });
  const options = scanOptionsFor(context, {
    'alpha@1.0.0': [
      vulnerability('GHSA-aaaa-bbbb-cccc'),
      vulnerability('GHSA-dddd-eeee-ffff', { database_specific: { severity: 'CRITICAL' } }),
    ],
  });
  const { findings } = await scanDependencies(root, options);
  assert.equal(findings.length, 1);
  const [finding] = findings;
  assert.equal(finding.ruleId, 'dependency-known-vulnerability');
  assert.equal(finding.file, path.join(root, 'package.json'));
  assert.equal(finding.line, 4);
  assert.equal(finding.severity, 'critical');
  assert.equal(finding.fixedVersion, '1.0.5');
  assert.equal(finding.contextualReason, undefined);
  assert.match(
    finding.message,
    /alpha@1\.0\.0 has 2 known vulnerabilities \(GHSA-aaaa-bbbb-cccc, GHSA-dddd-eeee-ffff\)/,
  );
  assert.match(finding.message, /Fix: npm install alpha@1\.0\.5/);
});

test('a transitive dependency gets an overrides hint at its lockfile line and a dev-only one is contextual', async (context) => {
  const root = project(context, { 'package-lock.json': npmLock });
  const options = scanOptionsFor(context, {
    '@scope/gamma@3.0.0': [
      vulnerability('GHSA-gggg', {
        database_specific: {},
        severity: [{ type: 'CVSS_V3', score: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H' }],
        affected: [
          {
            package: { ecosystem: 'npm', name: '@scope/gamma' },
            ranges: [{ type: 'SEMVER', events: [{ fixed: '3.1.0' }] }],
          },
        ],
      }),
    ],
    'beta@2.0.0': [vulnerability('GHSA-hhhh', { database_specific: { severity: 'MODERATE' }, affected: [] })],
  });
  const { findings } = await scanDependencies(root, options);
  const gamma = findingOfPackage(findings, '@scope/gamma');
  assert.equal(gamma.file, path.join(root, 'package-lock.json'));
  assert.equal(gamma.severity, 'critical');
  assert.match(gamma.message, /"overrides": \{ "@scope\/gamma": "3\.1\.0" \}/);
  const beta = findingOfPackage(findings, 'beta');
  assert.equal(beta.contextualReason, 'development-only dependency');
  assert.equal(beta.severity, 'medium');
  assert.equal(beta.fixedVersion, undefined);
  assert.match(beta.message, /No fixed version is published yet/);
});

test('an alias CVE is not reported next to its GHSA and the CVSS calculator matches known scores', async (context) => {
  const root = project(context, { 'package-lock.json': npmLock });
  const options = scanOptionsFor(context, {
    'alpha@1.0.0': [
      vulnerability('GHSA-aaaa', { aliases: ['CVE-2020-1'] }),
      vulnerability('CVE-2020-1', { aliases: ['GHSA-aaaa'] }),
    ],
  });
  const { findings } = await scanDependencies(root, options);
  assert.match(findings[0].message, /1 known vulnerability \(GHSA-aaaa\)/);
  assert.equal(cvssV3BaseScore('CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H'), 9.8);
  assert.equal(cvssV3BaseScore('CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:C/C:L/I:L/A:N'), 6.1);
});

test('requests are batched at 1000 packages and carry only names and versions', async (context) => {
  const entries = Array.from({ length: 2500 }, (_, index) => [`node_modules/pkg-${index}`, { version: '1.0.0' }]);
  const lock = JSON.stringify({ lockfileVersion: 3, packages: { '': {}, ...Object.fromEntries(entries) } });
  const root = project(context, { 'package-lock.json': lock });
  const { fetchImpl, calls } = fakeOsv({});
  await scanDependencies(root, { fetchImpl, cacheDirectory: cacheDirectory(context) });
  assert.deepEqual(
    calls.map(({ body }) => body?.queries.length),
    [1000, 1000, 500],
  );
  const [firstBody] = calls.map(({ body }) => body);
  assert.ok(firstBody);
  assert.deepEqual(firstBody.queries[0], { package: { name: 'pkg-0', ecosystem: 'npm' }, version: '1.0.0' });
  assert.deepEqual(Object.keys(firstBody), ['queries']);
});

test('a second run within 24 hours is served from the cache and an older cache is refreshed', async (context) => {
  const root = project(context, { 'package-lock.json': npmLock });
  const cache = cacheDirectory(context);
  const osv = fakeOsv({ 'alpha@1.0.0': [vulnerability('GHSA-aaaa')] });
  const start = Date.now();
  const scanAt = (now: number) => scanDependencies(root, { fetchImpl: osv.fetchImpl, cacheDirectory: cache, now });
  const first = await scanAt(start);
  const callsAfterFirst = osv.calls.length;
  assert.equal(callsAfterFirst, 2);
  const second = await scanAt(start + 60_000);
  assert.equal(osv.calls.length, callsAfterFirst);
  assert.deepEqual(second.findings, first.findings);
  await scanAt(start + dayMs + 60_000);
  assert.equal(osv.calls.length, callsAfterFirst * 2);
});

test('a network failure rejects with a clear message instead of passing', async (context) => {
  const root = project(context, { 'package-lock.json': npmLock });
  const unreachable = async () => {
    throw new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } });
  };
  await assert.rejects(
    scanDependencies(root, { fetchImpl: unreachable, cacheDirectory: cacheDirectory(context) }),
    /Could not reach the OSV vulnerability database \(ENOTFOUND\)/,
  );
  const unavailable = async () => asResponse({ ok: false, status: 503, json: async () => ({}) });
  await assert.rejects(
    scanDependencies(root, { fetchImpl: unavailable, cacheDirectory: cacheDirectory(context) }),
    /HTTP 503/,
  );
});

test('sec deps --online prints findings with an exit code of 1, and --format json prints the report', async (context) => {
  const root = project(context, { 'package-lock.json': npmLock });
  const options = scanOptionsFor(context, { 'alpha@1.0.0': [vulnerability('GHSA-aaaa')] });
  const text = await captured(() => depsMain(['--online', root], options));
  assert.equal(text.code, 1);
  assert.match(
    text.lines[0],
    /package\.json:4:1 \[dependency-known-vulnerability #[0-9a-f]{12}\] high: alpha@1\.0\.0 has 1 known vulnerability/,
  );
  assert.match(text.lines.at(-1) ?? '', /1 file\(s\) checked, 1 finding\(s\)\./);
  const json = await captured(() => depsMain(['--online', '--format', 'json', root], options));
  const report = JSON.parse(json.lines[0]);
  assert.equal(report.findings[0].advisories[0].url, 'https://osv.dev/vulnerability/GHSA-aaaa');
});

test('sec --online adds dependency findings to the source report', async (context) => {
  const root = project(context, {
    'package-lock.json': npmLock,
    'tsconfig.json': JSON.stringify({ compilerOptions: { types: [] }, include: ['*.ts'] }),
    'a.ts': 'export const one = 1;\n',
  });
  const options = scanOptionsFor(context, { 'alpha@1.0.0': [vulnerability('GHSA-aaaa')] });
  const run = await captured(() => securityMain(['--online', '-p', path.join(root, 'tsconfig.json')], options));
  assert.equal(run.code, 1);
  assert.match(run.lines.join('\n'), /dependency-known-vulnerability/);
});

test('without --online, sec, sec deps and check print one note and make no request', (context) => {
  const root = project(context, {
    'package-lock.json': npmLock,
    'tsconfig.json': JSON.stringify({ compilerOptions: { types: [] }, include: ['*.ts'] }),
    'a.ts': 'export const one = 1;\n',
  });
  for (const args of [['sec'], ['sec', 'deps'], ['check', '--only', 'sec'], ['check', '--only', 'perf,sec']]) {
    const run = spawnSync(process.execPath, [bin, ...args], { cwd: root, encoding: 'utf8', windowsHide: true });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stderr.match(/dependency vulnerability checks need --online/g)?.length, 1, args.join(' '));
  }
});

test('sec deps --online without a lockfile exits 2 with a message', (context) => {
  const root = project(context, {});
  const args = [bin, 'sec', 'deps', '--online', root];
  const run = spawnSync(process.execPath, args, { encoding: 'utf8', windowsHide: true });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /No package-lock\.json, pnpm-lock\.yaml or yarn\.lock found/);
});
