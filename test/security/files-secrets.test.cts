import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { parseSecReport } from './helpers.cjs';
import { checkSecrets } from '../../lib/security/files/secrets.cjs';
import { checkCompose } from '../../lib/security/files/compose.cjs';
import type { TestContext } from 'node:test';
import type { Finding } from '../../lib/shared/types.cjs';
import type { LocatedFinding } from '../types/security.cjs';

const bin = path.resolve(__dirname, '../../bin/loadwise.cjs');
// Built at run time so this file holds no token-shaped literal.
const randomBody = (length: number) => 'q7Zr3KvX9mBw2LdT5nYc8HfJ4sGa1PeU6oIyN0'.repeat(2).slice(0, length);
const awsKey = 'AKIA' + 'Q7ZR3KVX9MBW2LDT'.slice(0, 16);
const githubToken = 'ghp_' + randomBody(36);
const stripeKey = 'sk_live_' + randomBody(26);
const realPassword = 'k3Jf9xQ2mZ7vB5nL';

function findingMatching(findings: Finding[], pattern: RegExp): Finding {
  const found = findings.find((finding) => pattern.test(finding.message));
  assert.ok(found, `no finding matches ${pattern}`);
  return found;
}

function ruleIds(findings: Finding[]) {
  return findings.map((finding: Finding) => finding.ruleId);
}

test('a tracked .env value for a secret-looking key is reported with a redacted prefix', () => {
  const findings = checkSecrets('.env', `NODE_ENV=production\nJWT_SECRET=${realPassword}\nPORT=3000\n`);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].line, 2);
  assert.match(findings[0].message, /"JWT_SECRET" \(starts "k3Jf…"\)/);
  assert.ok(!JSON.stringify(findings).includes(realPassword));
});

test('placeholders, references, settings and public variables are not reported', () => {
  const lines = [
    'JWT_SECRET=changeme',
    'API_KEY=your-api-key-here',
    'DB_PASSWORD=${DB_PASSWORD}',
    'TOKEN=<token>',
    'SESSION_SECRET=dummy-session-secret',
    'AUTH_TOKEN=test-token-value',
    'JWT_SECRET_EXPIRY=' + realPassword,
    'NEXT_PUBLIC_MAPS_API_KEY=' + realPassword,
    'PASSWORD=short',
    'PRIVATE_KEY=/run/secrets/key',
  ];
  assert.deepEqual(checkSecrets('.env', lines.join('\n')), []);
});

test('quoted values and export prefixes are read', () => {
  const findings = checkSecrets('.env.production', `export STRIPE_SECRET="${realPassword}" # live\n`);
  assert.equal(findings.length, 1);
  assert.match(findings[0].message, /"STRIPE_SECRET"/);
});

test('database URLs with credentials are reported; local default credentials are contextual', () => {
  const remote = checkSecrets('.env', `DATABASE_URL=postgres://app:${realPassword}@db.internal:5432/app`);
  assert.equal(remote.length, 1);
  assert.equal(remote[0].contextualReason, undefined);
  assert.ok(!remote[0].message.includes(realPassword));
  const local = checkSecrets('.env', 'DATABASE_URL=postgres://postgres:postgres@localhost:5432/app');
  assert.equal(local.length, 1);
  assert.match(local[0].contextualReason ?? '', /local service/);
  assert.deepEqual(checkSecrets('.env', 'DATABASE_URL=postgres://user:${DB_PASSWORD}@db:5432/app'), []);
});

test('env templates are checked for token formats only', () => {
  assert.deepEqual(
    checkSecrets('.env.example', `JWT_SECRET=${realPassword}\nDATABASE_URL=postgres://a:${realPassword}@h/d`),
    [],
  );
  assert.deepEqual(ruleIds(checkSecrets('.env.sample', `AWS_KEY=${awsKey}`)), ['committed-secret']);
});

test('only default credentials on a local host get the local-service exception', () => {
  const findingsFor = (credentials: string, host: string) =>
    checkSecrets('.env', `DATABASE_URL=postgres://${credentials}@${host}/app`);
  for (const [credentials, host] of [
    ['postgres:postgres', 'db.internal'],
    ['postgres:postgres', '[2001:db8::1]'],
    [`app:${realPassword}`, 'localhost'],
  ]) {
    const findings = findingsFor(credentials, host);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].contextualReason, undefined);
  }
  assert.match(findingsFor('postgres:postgres', '[::1]')[0].contextualReason ?? '', /local service/);
  assert.deepEqual(findingsFor('app:changeme', 'localhost'), []);
});

test('a test env file is contextual', () => {
  const [finding] = checkSecrets('.env.test', `JWT_SECRET=${realPassword}`);
  assert.equal(finding.contextualReason, 'Test environment file.');
});

test('high-confidence token formats are reported anywhere, never with the full value', () => {
  const text = [awsKey, githubToken, stripeKey].map((token, index) => `const key${index} = '${token}';`).join('\n');
  const findings = checkSecrets('src/config.ts', text);
  assert.equal(findings.length, 3);
  for (const token of [awsKey, githubToken, stripeKey]) assert.ok(!JSON.stringify(findings).includes(token));
  assert.match(findings[0].message, /AWS access key id \(AKIA…\)/);
});

test('sample tokens and private key headers without a body are not reported', () => {
  const text = [
    "const docs = 'AKIAIOSFODNN7EXAMPLE';",
    "const dummy = 'sk_live_" + 'x'.repeat(26) + "';",
    "const header = '-----BEGIN PRIVATE KEY-----';",
    'const regex = /-----BEGIN (RSA )?PRIVATE KEY-----/;',
  ].join('\n');
  assert.deepEqual(checkSecrets('src/keys.ts', text), []);
});

test('a private key block is reported without printing it', () => {
  const body = randomBody(60);
  const findings = checkSecrets(
    'deploy/key.txt',
    `-----BEGIN RSA PRIVATE KEY-----\n${body}\n-----END RSA PRIVATE KEY-----`,
  );
  assert.equal(findings.length, 1);
  assert.ok(!JSON.stringify(findings).includes(body));
});

test('compose environment secrets are reported with a redacted prefix', () => {
  const text = [
    'services:',
    '  api:',
    '    image: api',
    '    environment:',
    `      - JWT_SECRET=${realPassword}`,
    '      - DB_PASSWORD=${DB_PASSWORD}',
    '      - NODE_ENV=production',
    '  worker:',
    '    environment:',
    `      API_KEY: ${realPassword}`,
    '      LOG_LEVEL: debug',
    '    labels:',
    `      SECRET_LABEL: ${realPassword}`,
  ].join('\n');
  const findings = checkCompose(text);
  assert.deepEqual(
    findings.map((finding) => finding.line),
    [5, 10],
  );
  assert.ok(!JSON.stringify(findings).includes(realPassword));
});

function git(root: string, ...args: string[]) {
  const run = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true });
  assert.equal(run.status, 0, run.stderr);
}

interface ScannedProject {
  files: Record<string, string>;
  track?: readonly string[] | false;
  ignore?: string;
}

function scanProject(context: TestContext, { files, track = [], ignore = '' }: ScannedProject) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loadwise-secrets-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  files = {
    'tsconfig.json': '{"compilerOptions":{"types":[]},"include":["*.ts"]}',
    'a.ts': 'export const a = 1;\n',
    ...files,
  };
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(root, name), text);
  if (ignore) fs.writeFileSync(path.join(root, '.gitignore'), ignore);
  if (track) {
    git(root, 'init', '-q');
    git(root, 'add', '-f', ...track);
  }
  const run = spawnSync(process.execPath, [bin, 'sec', '--json'], { cwd: root, encoding: 'utf8', windowsHide: true });
  return { run, report: parseSecReport(run.stdout) };
}

test('in a git repository only tracked env files are read; the output never holds the value', (context) => {
  const { run, report } = scanProject(context, {
    files: { '.env': `JWT_SECRET=${realPassword}\n`, '.env.production': `API_KEY=${realPassword}\n` },
    track: ['.env.production', 'a.ts', 'tsconfig.json'],
    ignore: '.env\n',
  });
  const secrets = report.findings.filter((finding: LocatedFinding) => finding.ruleId === 'committed-secret');
  assert.deepEqual(
    secrets.map((finding: LocatedFinding) => finding.file),
    ['.env.production'],
  );
  assert.ok(!run.stdout.includes(realPassword) && !run.stderr.includes(realPassword));
});

test('outside git, .env files are skipped entirely but other files still scan', (context) => {
  const { run, report } = scanProject(context, {
    files: { '.env': `JWT_SECRET=${realPassword}\n`, 'notes.txt': `key ${githubToken}\n` },
    track: false,
  });
  assert.deepEqual(
    report.findings.map((finding: LocatedFinding) => finding.file),
    ['notes.txt'],
  );
  assert.ok(!run.stdout.includes(githubToken));
});

test('default development passwords in compose are contextual', () => {
  const findings = checkCompose('services:\n  db:\n    environment:\n      POSTGRES_PASSWORD: postgres\n');
  assert.equal(findings.length, 1);
  assert.match(findings[0].contextualReason ?? '', /local service/);
});

test('a secret-manager reference is not a committed value', () => {
  assert.deepEqual(
    checkSecrets('deployment/.env', 'export CLOUDFLARE_API_TOKEN="op://vault/item/field"\nDB_SECRET=vault://kv/app'),
    [],
  );
});

test('a key file named as a test fixture is contextual, a plain key file is not', () => {
  const key = `-----BEGIN PRIVATE KEY-----\n${'QUJD'.repeat(20)}\n-----END PRIVATE KEY-----`;
  assert.equal(checkSecrets('packages/e2e/test-keys.ts', key)[0].contextualReason, 'Test environment file.');
  assert.equal(checkSecrets('lib/insecurity.ts', key)[0].contextualReason, undefined);
  assert.equal(checkSecrets('artifacts/cert/server.key', key).length, 1);
});

test('a private key excerpt ending in an ellipsis is documentation, a complete body is reported', () => {
  const body = 'QUJD'.repeat(20);
  assert.deepEqual(checkSecrets('page.mdx', `KEY="-----BEGIN RSA PRIVATE KEY-----\n${body}...`), []);
  assert.equal(checkSecrets('page.mdx', `KEY="-----BEGIN RSA PRIVATE KEY-----\n${body}\n-----END`).length, 1);
});

test('an env file declaring a local or test NODE_ENV is contextual; a production one is not', () => {
  const entry = `AUTH_SECRET=${realPassword}`;
  const local = checkSecrets('apps/api/src/.env.agent', `NODE_ENV=local\n${entry}`);
  assert.equal(local[0].contextualReason, 'Local development environment file.');
  assert.equal(checkSecrets('.env', `NODE_ENV=production\n${entry}`)[0].contextualReason, undefined);
});

test('a word-only token body is a sample, a random body is reported', () => {
  assert.deepEqual(checkSecrets('scenario.ts', "const text = 'token: xoxp-test-slack-token'"), []);
  assert.equal(checkSecrets('scenario.ts', `const text = 'xoxp-${randomBody(12)}-${randomBody(12)}'`).length, 1);
});

test('provider-format tokens stay at default level in test files and dev env files; generic values and keys are contextual', () => {
  const key = `-----BEGIN PRIVATE KEY-----
${'QUJD'.repeat(20)}
-----END PRIVATE KEY-----`;
  const testSource = checkSecrets(
    'src/auth.test.ts',
    `const id = '${awsKey}'
${key}`,
  );
  assert.equal(findingMatching(testSource, /AWS/).contextualReason, undefined);
  assert.equal(findingMatching(testSource, /private key/).contextualReason, 'Test environment file.');
  const devEnv = checkSecrets(
    '.env',
    `NODE_ENV=development
STRIPE_KEY=${stripeKey}
AUTH_SECRET=${realPassword}`,
  );
  assert.equal(findingMatching(devEnv, /Stripe/).contextualReason, undefined);
  assert.match(findingMatching(devEnv, /AUTH_SECRET/).contextualReason ?? '', /development/);
});
