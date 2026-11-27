import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findingsOf } from './exposure-helpers.js';
import type { LocatedFinding } from '../types/security.js';

const ruleId = 'auth-route-without-rate-limit';
const express = "import express from 'express';\nconst app = express();\ndeclare const loginHandler: any;\n";

function reported(source: string, files: Record<string, string> = {}) {
  const findings = findingsOf(ruleId, source, files);
  return { defaults: findings.filter((finding: LocatedFinding) => !finding.contextualReason), all: findings };
}

test('a login route with no limiter anywhere is reported', () => {
  const { defaults } = reported(`${express}app.post('/login', loginHandler);`);
  assert.equal(defaults.length, 1);
});

test('other credential paths and methods are reported', () => {
  const source = `${express}
app.post('/api/auth/forgot-password', loginHandler);
app.put('/signup', (req: any, res: any) => res.send('ok'));
app.all('/verify-otp', loginHandler);
router.route('/register').post(loginHandler);
declare const router: any;`;
  assert.equal(reported(source).defaults.length, 4);
});

test('Nest login decorators are reported', () => {
  const source = `import { Controller, Post } from '@nestjs/common';
@Controller('auth')
export class AuthController {
  @Post('login')
  login() {}
}`;
  assert.equal(reported(source).defaults.length, 1);
});

test('a limiter in the same registration is accepted', () => {
  const source = `${express}import rateLimit from 'express-rate-limit';
const loginLimiter = rateLimit({ windowMs: 60000, max: 5 });
app.post('/login', loginLimiter, loginHandler);
app.post('/signup', rateLimit({ max: 3 }), loginHandler);`;
  assert.equal(reported(source).all.length, 0);
});

test('Fastify route options with a rate limit are accepted', () => {
  const source = `import Fastify from 'fastify';
const fastify = Fastify();
declare const handler: any;
fastify.post('/login', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, handler);`;
  assert.equal(reported(source).all.length, 0);
});

test('a global app.use limiter is accepted', () => {
  const source = `${express}import rateLimit from 'express-rate-limit';
app.use(rateLimit({ max: 100 }));
app.post('/login', loginHandler);`;
  assert.equal(reported(source).all.length, 0);
});

test('a global limiter in another file is accepted', () => {
  const files = {
    'limits.ts':
      "import rateLimit from 'express-rate-limit';\nexport const app: any = {};\napp.use(rateLimit({ max: 5 }));",
  };
  assert.equal(reported(`${express}app.post('/login', loginHandler);`, files).all.length, 0);
});

test('Nest throttler decorators and guards are accepted', () => {
  const source = `import { Controller, Post, UseGuards } from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
@Controller('auth')
export class AuthController {
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @Post('login')
  login() {}
}
@UseGuards(ThrottlerGuard)
@Controller('users')
export class UsersController {
  @Post('register')
  register() {}
}`;
  assert.equal(reported(source).all.length, 0);
});

const limiterImportLine = "import rateLimit from 'express-rate-limit';\n";
const loginRoute = `${express}app.post('/login', loginHandler);`;

test('a limiter in a module unrelated to the route is still reported by default', () => {
  const files = { 'unused.ts': `${limiterImportLine}export const unused = rateLimit({ max: 1 });` };
  const { defaults, all } = reported(loginRoute, files);
  assert.equal(defaults.length, 1);
  assert.equal(all.length, 1);
});

test('a limiter imported in the route file itself is contextual', () => {
  const { defaults, all } = reported(`${limiterImportLine}const unused = rateLimit({ max: 1 });
${loginRoute}`);
  assert.equal(defaults.length, 0);
  assert.equal(all.length, 1);
});

test('a limiter in a module the route file imports is contextual', () => {
  const files = { 'limits.ts': `${limiterImportLine}export const unused = rateLimit({ max: 1 });` };
  const { defaults, all } = reported(
    `import { unused } from './limits';
void unused;
${loginRoute}`,
    files,
  );
  assert.equal(defaults.length, 0);
  assert.equal(all.length, 1);
});

test('a limiter in app setup that imports the route file is contextual', () => {
  const files = {
    'app.ts': `${limiterImportLine}import './main';
export const unused = rateLimit({ max: 1 });`,
  };
  const { defaults, all } = reported(loginRoute, files);
  assert.equal(defaults.length, 0);
  assert.equal(all.length, 1);
});

test('non-credential routes, GET routes and HTTP clients are not reported', () => {
  const source = `${express}import axios from 'axios';
declare const credentials: any;
app.post('/orders', loginHandler);
app.get('/login', loginHandler);
app.post('/tokens/list', loginHandler);
app.post('/footprint', loginHandler);
axios.post('/login', credentials);`;
  assert.equal(reported(source).all.length, 0);
});

test('a limiter from another module applied to the route app is accepted', () => {
  const files = { 'limits.ts': `${limiterImportLine}export const loginLimiter = rateLimit({ max: 5 });` };
  const source = `${express}import { loginLimiter } from './limits';
app.use(loginLimiter);
app.post('/login', loginHandler);`;
  assert.equal(reported(source, files).all.length, 0);
});

test('a router mounted on an app that applies a limiter is accepted', () => {
  const source = `${express}${limiterImportLine}const authRouter = express.Router();
app.use(rateLimit({ max: 100 }));
app.use('/auth', authRouter);
authRouter.post('/login', loginHandler);`;
  assert.equal(reported(source).all.length, 0);
});

test('a limiter applied only to another router in the route file is contextual', () => {
  const source = `${express}${limiterImportLine}const adminRouter = express.Router();
adminRouter.use(rateLimit({ max: 100 }));
app.use('/admin', adminRouter);
app.post('/login', loginHandler);`;
  const { defaults, all } = reported(source);
  assert.equal(defaults.length, 0);
  assert.equal(all.length, 1);
  assert.match(all[0].contextualReason ?? '', /another app or router/);
});
