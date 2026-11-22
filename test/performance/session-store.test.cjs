'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { lint } = require('./helpers.cjs');

const files = {
  'node_modules/express-session/index.d.ts': `declare function session(options: object): () => void; export default session;`,
  'node_modules/cookie-session/index.d.ts': `declare function cookieSession(options: object): () => void; export default cookieSession;`,
  'node_modules/@fastify/session/index.d.ts': `declare const plugin: (app: object, options: object) => void; export default plugin;`,
};

function check(source) {
  return lint(source, files).filter((finding) => finding.ruleId === 'session-memory-store');
}

test('reports express-session without a store', () => {
  const findings = check(
    [
      "import session from 'express-session';",
      'export const middleware = session({ secret: "s", resave: false });',
    ].join('\n'),
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].contextualReason, undefined);
  assert.match(findings[0].message, /connect-redis/);
});

test('reports options resolved from a local const object', () => {
  const findings = check(
    [
      "import session from 'express-session';",
      'const options = { secret: "s" };',
      'export const middleware = session(options);',
    ].join('\n'),
  );
  assert.equal(findings.length, 1);
});

test('reports fastify session registered without a store', () => {
  const findings = check(
    [
      "import fastifySession from '@fastify/session';",
      'declare const app: { register(plugin: unknown, options: object): void };',
      'app.register(fastifySession, { secret: "s" });',
    ].join('\n'),
  );
  assert.equal(findings.length, 1);
});

test('skips a configured store, including a conditional one', () => {
  const findings = check(
    [
      "import session from 'express-session';",
      'declare const sharedStore: object;',
      'declare const isProd: boolean;',
      'export const first = session({ secret: "s", store: sharedStore });',
      'export const second = session({ secret: "s", store: isProd ? sharedStore : undefined });',
    ].join('\n'),
  );
  assert.equal(findings.length, 0);
});

test('skips spread, unknown options and cookie-session', () => {
  const findings = check(
    [
      "import session from 'express-session';",
      "import cookieSession from 'cookie-session';",
      'declare const base: object;',
      'declare const external: object;',
      'export const first = session({ ...base, secret: "s" });',
      'export const second = session(external);',
      'export const third = cookieSession({ keys: ["k"] });',
    ].join('\n'),
  );
  assert.equal(findings.length, 0);
});
