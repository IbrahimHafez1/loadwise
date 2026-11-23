'use strict';

// One minimal sample per security fix builder, taken from the rule's own tests.
const { stubs } = require('../../../security/helpers.cjs');
const packages = require('./package-stubs.cjs');

const nosqlRoute = [
  "import express from 'express';",
  "import { User } from './models/user.js';",
  'const app = express();',
  "app.post('/login', (req, res) => {",
  '  User.findOne({ email: req.body.email });',
  '});',
].join('\n');

const cookieSample = "declare const res: any;\nres.cookie('session', 'x', { secure: true, sameSite: 'lax' });\n";

const corsSample = [
  "import cors from 'cors';",
  'declare const app: any;',
  String.raw`app.use(cors({ origin: /example\.com$/, credentials: true }));`,
  '',
].join('\n');

const pgSample = [
  "import { Pool } from 'pg';",
  'export async function run(pool: Pool, id: number) {',
  '  await pool.query(`SELECT * FROM accounts WHERE id = ${id}`);',
  '}',
  '',
].join('\n');

const prismaSample = [
  "import { PrismaClient } from '@prisma/client';",
  "import { requireTenantId } from '@app/auth';",
  'const db = new PrismaClient();',
  'export async function list() {',
  '  const tenantId = requireTenantId();',
  '  return db.invoice.findMany({ where: { paid: true } });',
  '}',
  '',
].join('\n');

const drizzleSample = [
  "import type { Database } from 'drizzle-orm/pg-core/db';",
  "import { eq } from 'drizzle-orm';",
  "import { invoices } from '@app/schema';",
  "import { tenant } from '@app/auth';",
  'export async function run(db: Database, id: number) {',
  '  const tenantId = tenant();',
  '  await db.delete(invoices).where(eq(invoices.id, id));',
  '}',
  '',
].join('\n');

const securityCases = [
  {
    ruleId: 'nosql-operator-injection',
    files: { 'src.ts': nosqlRoute, ...stubs.express, ...packages.mongoose },
  },
  {
    ruleId: 'tls-verification-disabled',
    files: {
      'src/database.config.ts': 'export const database = {\n  ssl: { rejectUnauthorized: false },\n};\n',
    },
  },
  {
    ruleId: 'bcrypt-low-cost',
    files: {
      'app.ts': "import bcrypt from 'bcrypt';\nexport const hash = (password: string) => bcrypt.hash(password, 8);\n",
      ...packages.bcrypt,
    },
  },
  {
    ruleId: 'insecure-random-for-secret',
    files: {
      'app.ts':
        "import { readFileSync } from 'node:fs';\nexport const resetPin = () => Math.floor(Math.random() * 10000);\nexport const read = readFileSync;\n",
      ...packages.nodeModules,
    },
  },
  {
    ruleId: 'jwt-verify-without-algorithms',
    files: {
      'app.ts': [
        "import jwt from 'jsonwebtoken';",
        'export const issue = (id: string, secret: string) => jwt.sign({ id }, secret, { expiresIn: 60 });',
        'export const check = (token: string, secret: string) => jwt.verify(token, secret);',
        '',
      ].join('\n'),
      ...packages.jsonwebtoken,
    },
  },
  {
    ruleId: 'secret-compared-non-constant-time',
    files: {
      'app.mts': [
        "import 'node:crypto';",
        "import type { Request } from 'express';",
        'export function equal(req: Request, stored: { secret: string }) { return req.headers.signature === stored.secret; }',
        '',
      ].join('\n'),
      ...stubs.express,
      'node_modules/express/package.json': '{"types":"./index.d.ts"}',
      ...packages.nodeModules,
    },
  },
  { ruleId: 'cookie-missing-security-flags', files: { 'main.ts': cookieSample } },
  { ruleId: 'cors-origin-regex-unanchored', files: { 'main.ts': corsSample, ...packages.cors } },
  {
    ruleId: 'graphql-introspection-enabled',
    files: {
      'main.ts':
        'declare class ApolloServer { constructor(options: object); }\nnew ApolloServer({ introspection: true });\n',
    },
  },
  {
    ruleId: 'nest-validation-without-whitelist',
    files: {
      'main.ts': "import { ValidationPipe } from '@nestjs/common';\nexport const pipe = new ValidationPipe();\n",
      ...stubs.nest,
    },
  },
  { ruleId: 'pg-dynamic-query-text', files: { 'src.ts': pgSample, ...packages.pg } },
  {
    ruleId: 'prisma-scope-unverified',
    files: { 'src.ts': prismaSample, ...packages.prisma },
    policy: packages.prismaPolicy,
  },
  {
    ruleId: 'drizzle-scope-unverified',
    files: { 'src.ts': drizzleSample, ...packages.drizzle },
    policy: packages.drizzlePolicy,
  },
  {
    ruleId: 'error-stack-in-response',
    files: {
      'handler.ts': [
        'declare function load(): void;',
        'export function route(res: any) {',
        '  try {',
        '    load();',
        '  } catch (err: any) {',
        '    res.status(500).json({ message: err.message, stack: err.stack });',
        '  }',
        '}',
        '',
      ].join('\n'),
    },
  },
  {
    ruleId: 'database-error-in-response',
    files: {
      'handler.ts': [
        "import { Pool } from 'pg';",
        'export async function route(pool: Pool, res: any) {',
        '  try {',
        "    await pool.query('SELECT 1');",
        '  } catch (err: any) {',
        '    res.status(500).json({ error: err.message });',
        '  }',
        '}',
        '',
      ].join('\n'),
      ...packages.pg,
    },
  },
  {
    ruleId: 'jwt-none-algorithm',
    files: {
      'app.ts': [
        "import jwt from 'jsonwebtoken';",
        "export const check = (token: string, secret: string) => jwt.verify(token, secret, { algorithms: ['HS256', 'none'] });",
        '',
      ].join('\n'),
      ...packages.jsonwebtoken,
    },
  },
  {
    ruleId: 'jwt-sign-without-expiry',
    files: {
      'app.ts': [
        "import jwt from 'jsonwebtoken';",
        'export const issue = (id: string, secret: string) => jwt.sign({ id }, secret);',
        '',
      ].join('\n'),
      ...packages.jsonwebtoken,
    },
  },
  {
    ruleId: 'template-autoescape-disabled',
    files: {
      'app.ts': ["import nunjucks from 'nunjucks';", "nunjucks.configure('views', { autoescape: false });", ''].join(
        '\n',
      ),
      'node_modules/nunjucks/index.d.ts': [
        'declare const nunjucks: { configure(path: string, options?: object): void };',
        'export default nunjucks;',
      ].join('\n'),
      'node_modules/nunjucks/package.json': '{"types":"./index.d.ts"}',
    },
  },
  {
    ruleId: 'dom-xss-sink',
    files: { 'app.ts': 'declare const el: HTMLElement;\nel.innerHTML = location.hash;\n' },
  },
  {
    ruleId: 'postmessage-missing-origin-check',
    files: {
      'app.ts': "window.postMessage('ready', '*');\n",
      'tsconfig.json': '{"compilerOptions":{"lib":["ES2022","DOM"]}}',
    },
  },
  {
    ruleId: 'express-missing-helmet',
    files: {
      'app.ts': "import express from 'express';\nconst app = express();\napp.listen(3000);\n",
      'node_modules/express/index.d.ts': [
        'export interface Application { use(handler: unknown): void; listen(port: number): unknown }',
        'declare function express(): Application;',
        'export default express;',
      ].join('\n'),
      'node_modules/express/package.json': '{"types":"./index.d.ts"}',
      'node_modules/helmet/index.d.ts': 'declare function helmet(): unknown;\nexport default helmet;',
      'node_modules/helmet/package.json': '{"types":"./index.d.ts"}',
    },
  },
];

module.exports = { securityCases };
