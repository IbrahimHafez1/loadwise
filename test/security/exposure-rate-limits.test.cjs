'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { findingsOf } = require('./exposure-helpers.cjs');

const ruleId = 'auth-route-without-rate-limit';
const express = "import express from 'express';\nconst app = express();\ndeclare const loginHandler: any;\n";

function reported(source, files) {
  const findings = findingsOf(ruleId, source, files);
  return { defaults: findings.filter((finding) => !finding.contextualReason), all: findings };
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

test('a limiter imported but not connected to the route is contextual', () => {
  const files = {
    'unused.ts': "import rateLimit from 'express-rate-limit';\nexport const unused = rateLimit({ max: 1 });",
  };
  const { defaults, all } = reported(`${express}app.post('/login', loginHandler);`, files);
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
