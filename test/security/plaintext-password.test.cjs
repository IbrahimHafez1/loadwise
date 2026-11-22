'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { lint, lintBothWays } = require('./helpers.cjs');

const ruleId = 'plaintext-password-storage';

function passwordFindings(source, files) {
  return lint(source, files).filter((finding) => finding.ruleId === ruleId);
}

const expressHeader = [
  "import express from 'express';",
  "import bcrypt from 'bcrypt';",
  'const app = express();',
  'declare const prisma: any;',
  'declare const User: any;',
  'declare const db: any;',
  'declare const LoginCommand: any;',
].join('\n');

test('request passwords written by ORM calls are reported', () => {
  const source = [
    expressHeader,
    "app.post('/a', async (req, res) => {",
    '  await prisma.user.create({ data: { email: req.body.email, password: req.body.password } });',
    '  await User.create({ email: req.body.email, password: req.body.password });',
    '  const { password } = req.body;',
    '  await db.insert({ password });',
    '  await prisma.user.update({ where: { id: 1 }, data: { password: req.body.password } });',
    '});',
  ].join('\n');
  const { typed, untyped } = lintBothWays(source);
  const lines = (findings) => findings.filter((finding) => finding.ruleId === ruleId).map((finding) => finding.line);
  assert.deepEqual(lines(typed), [9, 10, 12, 13]);
  assert.deepEqual(lines(untyped), [9, 10, 12, 13]);
  assert.ok(typed.every((finding) => !finding.contextualReason));
});

test('assignment followed by save is reported', () => {
  const source = [
    expressHeader,
    "app.post('/a', async (req, res) => {",
    '  const user = new User();',
    '  user.password = req.body.password;',
    '  await user.save();',
    '});',
  ].join('\n');
  assert.deepEqual(
    passwordFindings(source).map((finding) => finding.line),
    [10],
  );
});

test('raw SQL inserts of a request password are reported', () => {
  const source = [
    expressHeader,
    "app.post('/a', async (req, res) => {",
    "  await db.query('INSERT INTO users (email, password) VALUES (?, ?)', [req.body.email, req.body.password]);",
    "  await db.query('SELECT * FROM users WHERE password = ?', [req.body.password]);",
    '});',
  ].join('\n');
  assert.deepEqual(
    passwordFindings(source).map((finding) => finding.line),
    [9],
  );
});

test('hashed values and non-password fields are not reported', () => {
  const source = [
    expressHeader,
    "app.post('/a', async (req, res) => {",
    '  const hashed = await bcrypt.hash(req.body.password, 12);',
    '  await prisma.user.create({ data: { password: hashed } });',
    '  await prisma.user.create({ data: { password: await bcrypt.hash(req.body.password, 12) } });',
    '  await prisma.user.create({ data: { passwordHash: req.body.password } });',
    '  await prisma.user.create({ data: { passwordResetToken: req.body.token } });',
    '  await prisma.user.findFirst({ where: { password: req.body.password } });',
    '  LoginCommand.create({ password: req.body.password });',
    '  await prisma.user.create({ data: { password: req.body.passwordHash } });',
    '});',
  ].join('\n');
  assert.deepEqual(passwordFindings(source), []);
});

test('a project helper that hashes is followed', () => {
  const source = [
    expressHeader,
    'async function protect(plain: string) {',
    '  return bcrypt.hash(plain, 12);',
    '}',
    "app.post('/a', async (req, res) => {",
    '  await User.create({ password: await protect(req.body.password) });',
    '});',
  ].join('\n');
  assert.deepEqual(passwordFindings(source), []);
});

test('a model with a hashing hook suppresses the finding', () => {
  const model = [
    "import bcrypt from 'bcrypt';",
    'export class UserEntity {',
    '  password!: string;',
    '  @BeforeInsert()',
    '  async hash() { this.password = await bcrypt.hash(this.password, 12); }',
    '}',
    'declare function BeforeInsert(): MethodDecorator;',
  ].join('\n');
  const source = [
    expressHeader,
    "app.post('/a', async (req) => {",
    '  await User.create({ password: req.body.password });',
    '});',
  ].join('\n');
  assert.deepEqual(passwordFindings(source, { 'model.ts': model }), []);
});

test('a bare password parameter is contextual', () => {
  const source = [
    expressHeader,
    'export async function add(email: string, password: string) {',
    '  await User.create({ email, password });',
    '}',
  ].join('\n');
  const findings = passwordFindings(source);
  assert.equal(findings.length, 1);
  assert.ok(findings[0].contextualReason);
});
