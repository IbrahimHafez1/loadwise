'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { checkSecrets } = require('../../lib/security/files/secrets.cjs');
const { checkCompose } = require('../../lib/security/files/compose.cjs');

const bin = path.resolve(__dirname, '../../bin/loadwise.cjs');
// Built at run time so this file holds no token-shaped literal.
const randomBody = (length) => 'q7Zr3KvX9mBw2LdT5nYc8HfJ4sGa1PeU6oIyN0'.repeat(2).slice(0, length);
const awsKey = 'AKIA' + 'Q7ZR3KVX9MBW2LDT'.slice(0, 16);
const githubToken = 'ghp_' + randomBody(36);
const stripeKey = 'sk_live_' + randomBody(26);
const realPassword = 'k3Jf9xQ2mZ7vB5nL';

function ruleIds(findings) {
  return findings.map((finding) => finding.ruleId);
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
  assert.match(local[0].contextualReason, /local service/);
  assert.deepEqual(checkSecrets('.env', 'DATABASE_URL=postgres://user:${DB_PASSWORD}@db:5432/app'), []);
});

test('env templates are checked for token formats only', () => {
  assert.deepEqual(
    checkSecrets('.env.example', `JWT_SECRET=${realPassword}\nDATABASE_URL=postgres://a:${realPassword}@h/d`),
    [],
  );
  assert.deepEqual(ruleIds(checkSecrets('.env.sample', `AWS_KEY=${awsKey}`)), ['committed-secret']);
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

function git(root, ...args) {
  const run = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true });
  assert.equal(run.status, 0, run.stderr);
}

function scanProject(context, { files, track = [], ignore = '' }) {
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
  return { run, report: JSON.parse(run.stdout) };
}

test('in a git repository only tracked env files are read; the output never holds the value', (context) => {
  const { run, report } = scanProject(context, {
    files: { '.env': `JWT_SECRET=${realPassword}\n`, '.env.production': `API_KEY=${realPassword}\n` },
    track: ['.env.production', 'a.ts', 'tsconfig.json'],
    ignore: '.env\n',
  });
  const secrets = report.findings.filter((finding) => finding.ruleId === 'committed-secret');
  assert.deepEqual(
    secrets.map((finding) => finding.file),
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
    report.findings.map((finding) => finding.file),
    ['notes.txt'],
  );
  assert.ok(!run.stdout.includes(githubToken));
});

test('default development passwords in compose are contextual', () => {
  const findings = checkCompose('services:\n  db:\n    environment:\n      POSTGRES_PASSWORD: postgres\n');
  assert.equal(findings.length, 1);
  assert.match(findings[0].contextualReason, /local service/);
});
