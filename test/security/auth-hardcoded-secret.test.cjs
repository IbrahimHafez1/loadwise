'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { lint, lintBothWays } = require('./helpers.cjs');
const { withProgram } = require('../performance/helpers.cjs');

function secretFindings(source, files) {
  return lint(source, files).filter((finding) => finding.ruleId === 'hardcoded-secret');
}

const stripeKey = 'sk_live_' + 'abcdefghijklmnopqrstuvwx';
const awsKey = 'AKIA' + 'ABCDEFGHIJKLMNOP';
const githubToken = 'ghp_' + 'abcdefghijklmnopqrstuvwxyz0123456789';
const slackToken = 'xoxb-' + '123456789012-abcdefghijkl';
const privateKeyBody = 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7VJTUt9Us8cKj';

test('known credential shapes are reported in strings and templates', () => {
  const source = [
    `export const stripe = '${stripeKey}';`,
    `export const aws = { accessKeyId: '${awsKey}' };`,
    `export const github = \`${githubToken}\`;`,
    `export const slack = ['${slackToken}'];`,
    `export const pem = '-----BEGIN RSA PRIVATE KEY-----\\n${privateKeyBody}\\n-----END RSA PRIVATE KEY-----';`,
    `export const header = { Authorization: \`Bearer ${githubToken}\` };`,
  ].join('\n');
  const { typed, untyped } = lintBothWays(source);
  assert.deepEqual(
    typed
      .filter((finding) => finding.ruleId === 'hardcoded-secret')
      .map((finding) => [finding.line, Boolean(finding.contextualReason)]),
    [1, 2, 3, 4, 5, 6].map((line) => [line, false]),
  );
  assert.equal(untyped.filter((finding) => finding.ruleId === 'hardcoded-secret').length, 6);
});

test('known credential shapes are not reported for placeholders, short values and prose', () => {
  const findings = secretFindings(
    [
      "export const a = 'sk_live_xxxxxxxxxxxxxxxxxxxxxxxx';",
      "export const b = 'AKIAIOSFODNN7EXAMPLE';",
      "export const c = 'Set STRIPE_KEY to sk_live_<your key>';",
      "export const d = 'ghp_short';",
      "export const e = '-----BEGIN PRIVATE KEY-----';",
      "export const f = pem.replace('-----BEGIN RSA PRIVATE KEY-----', '');",
      "export const g = 'my_sk_live_ish';",
      "export const h = 'npm_config_registry';",
    ].join('\n'),
  );
  assert.deepEqual(findings, []);
});

test('signing keys written as string literals are reported', () => {
  const source = [
    "import jwt from 'jsonwebtoken';",
    "import session from 'express-session';",
    "import { createHmac } from 'node:crypto';",
    "const SIGNING = 'a-long-hmac-signing-value';",
    'export function sign(payload: object, body: string) {',
    "  jwt.sign(payload, 'hunter2-signing-key');",
    "  jwt.verify('token', process.env.JWT_SECRET || 'fallback-signing-key');",
    "  createHmac('sha256', SIGNING).update(body);",
    "  session({ secret: 'keyboard cat session' });",
    '}',
  ].join('\n');
  assert.deepEqual(
    secretFindings(source).map((finding) => finding.line),
    [4, 6, 7, 9],
  );
});

test('signing keys read from the environment or a variable are not reported', () => {
  const findings = secretFindings(
    [
      "import jwt from 'jsonwebtoken';",
      "import { createHmac } from 'node:crypto';",
      'export function sign(payload: object, key: string) {',
      '  jwt.sign(payload, key);',
      '  jwt.sign(payload, process.env.JWT_SECRET!);',
      "  jwt.sign(payload, '<your-secret-here>');",
      "  jwt.sign(payload, 'JWT_SECRET');",
      "  createHmac('sha256', key).update('body');",
      '}',
    ].join('\n'),
  );
  assert.deepEqual(findings, []);
});

test('named values are default when high-entropy and contextual when low-entropy', () => {
  const source = [
    "export const config = { jwtSecret: 'Xk9$mP2vQ7wLz4Rt', clientSecret: 'cookingschool2024' };",
    "const apiKey = process.env.API_KEY ?? 'Ab3dEf6hIj9kLm2nOp5q';",
    "export class Settings { privateKey = 'aB1!cD2@eF3#gH4$'; }",
    "export function connect(password = 'Pr0d-Passw0rd!x') { return password; }",
    "export const db = { password: 'c1d2e3f4a5b6c7d8e9f0' };",
  ].join('\n');
  const findings = secretFindings(source);
  assert.deepEqual(
    findings.map((finding) => [finding.line, Boolean(finding.contextualReason)]),
    [
      [1, false],
      [1, true],
      [2, false],
      [3, false],
      [4, false],
      [5, true],
    ],
  );
});

// Findings of the secret rule for a file other than main.ts in the virtual project.
function secretFindingsIn(filename, source) {
  const { analyzeFile } = require('../../lib/security/analyze.cjs');
  return withProgram('export {};', { [filename]: source }, (program) => {
    const sourceFile = program.getSourceFiles().find((file) => file.fileName.endsWith(filename));
    return analyzeFile(program, sourceFile).filter((finding) => finding.ruleId === 'hardcoded-secret');
  });
}

test('test, fixture and documentation sources do not report named values', () => {
  const named = "export const user = { password: 'Xk9$mP2vQ7wLz4Rt', jwtSecret: 'aB1!cD2@eF3#gH4$' };";
  assert.equal(secretFindingsIn('src/users.ts', named).length, 2);
  for (const filename of ['fixtures/users.ts', 'src/users.spec.ts', 'src/swagger-example.ts'])
    assert.deepEqual(secretFindingsIn(filename, named), [], filename);
});

test('known credential shapes in test sources are contextual', () => {
  const [finding] = secretFindingsIn('src/billing.spec.ts', `export const key = '${stripeKey}';`);
  assert.equal(finding.contextualReason, 'Test or example source.');
});

// Realistic values that look like credentials to a pattern matcher and are not.
const notSecrets = [
  ["export const a = { password: 'password' };"],
  ["export const a = { password: 'changeme' };"],
  ["export const a = { password: '' };"],
  ["export const a = { password: 'your-password-here' };"],
  ["export const a = { password: '<password>' };"],
  ["export const a = { password: '********' };"],
  ["export const a = { password: 'xxxxxxxxxxxxxxxxxx' };"],
  ["export const a = { password: 'example-password-123' };"],
  ["export const a = { password: 'Please enter your password' };"],
  ["export const a = { secret: 'client-secret' };"],
  ["export const a = { secret: 'JWT_SECRET' };"],
  ["export const a = { secret: 'dummy-secret-value-for-docs' };"],
  ["export const a = { apiKey: 'x-api-key' };"],
  ["export const a = { apiKey: 'X_API_KEY' };"],
  ['export const a = { apiKey: process.env.API_KEY };'],
  ["export const a = { accessToken: 'auth/invalid_access_token' };"],
  ["export const INVALID_ACCESS_TOKEN = 'auth/invalid_access_token';"],
  ["export const FORGOT_PASSWORD = 'forgot-password';"],
  ["export const PASSWORD_RESET_TEMPLATE = 'password-reset-template';"],
  ["export const a = { passwordField: 'password' };"],
  ["export const passwordPattern = '^(?=.*[A-Z])(?=.*[0-9]).{8,}$';"],
  ["export const passwordMessage = 'Password must contain 8 characters';"],
  ["export const passwordUrl = 'https://example.com/reset-password-page';"],
  ["export const secretPath = '/var/run/secrets/kubernetes.io/token';"],
  ["export const authToken = 'Bearer';"],
  ["export const a = { authToken: 'Bearer abc.def.ghi' };"],
  ["export const clientSecret = 'secret';"],
  ["export const encryptionKey = 'encryption-key';"],
  ["export const jwtSecret = 'jwt-secret';"],
  ["export const privateKey = 'private-key-file-name';"],
  ["export const a = { password: 'test-password-for-ci' };"],
  ["export const a = { password: 'dev-password-local' };"],
  ["export const a = { secret: 'default-secret-value' };"],
  ["export const a = { secret: 'my-super-secret-key' };"],
  ["export const a = { secret: 'replace-me-with-a-real-secret' };"],
  ["export const a = { password: 'todo-set-a-password' };"],
  ["export const secret = ['a', 'b'].join('-');"],
  ['export const secret = `${prefix}-secret-key-value`;\ndeclare const prefix: string;'],
  ["export const apiKey = 'abc';"],
  ["export const a = { password: 'short1!' };"],
  ["export const a = { secret: 'aaaaaaaaaaaaaaaaaaaa' };"],
  ["export const a = { secret: '12345678901234567890' };"],
  ["export const a = { secret: 'http://localhost:3000/secret' };"],
  ["export const a = { secret: './config/secret.pem' };"],
  ["export const a = { name: 'Xk9$mP2vQ7wLz4Rt' };"],
  ["export const a = { token: 'Xk9$mP2vQ7wLz4Rt' };"],
  ['export const a = { passwordHash: bcryptHash };\ndeclare const bcryptHash: string;'],
  [
    "@ApiBody({ examples: { ok: { value: { password: 'StrongPass123!' } } } })\nexport class Dto {}\ndeclare function ApiBody(options: object): ClassDecorator;",
  ],
  ["export const REGISTRATION_EXAMPLE = { password: 'SecurePass1!' };"],
  ["export const EXAMPLE_ACCESS_TOKEN = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abc123def456';"],
  ["import jwt from 'jsonwebtoken';\nexport const t = (k: string) => jwt.sign({}, k);"],
];

test('a table of realistic non-secrets is never reported', () => {
  assert.ok(notSecrets.length >= 40);
  for (const [source] of notSecrets) assert.deepEqual(secretFindings(source), [], source);
});
