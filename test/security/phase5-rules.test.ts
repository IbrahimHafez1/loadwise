import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withProgram } from '../performance/helpers.js';
import { collectPhase5SecurityFindings } from '../../lib/security/phase5-rules.js';
import type { SourceFile } from 'typescript';
import type { ProgramAdapter } from '../../lib/shared/types.js';

function scan(source: string, ruleId?: string) {
  return withProgram(source, {}, (program: ProgramAdapter, sourceFile: SourceFile) => {
    const found = collectPhase5SecurityFindings(program, sourceFile);
    return ruleId ? found.filter((f) => f.ruleId === ruleId) : found;
  });
}

test('server-action-missing-auth: reports exported or inline Server Actions without auth', () => {
  const fileAction = [
    "'use server';",
    'export async function deleteAccount(userId: string) {',
    '  await db.user.delete({ where: { id: userId } });',
    '}',
  ].join('\n');
  assert.equal(scan(fileAction, 'server-action-missing-auth').length, 1);

  const arrowAction = [
    "'use server';",
    'export const updateRole = async (id: string, role: string) => {',
    '  await db.user.update({ where: { id }, data: { role } });',
    '};',
  ].join('\n');
  assert.equal(scan(arrowAction, 'server-action-missing-auth').length, 1);

  const inlineAction = [
    'export function Page() {',
    '  async function submitForm(data: FormData) {',
    "    'use server';",
    '    await saveItem(data);',
    '  }',
    '  return submitForm;',
    '}',
  ].join('\n');
  assert.equal(scan(inlineAction, 'server-action-missing-auth').length, 1);
});

test('server-action-missing-auth: allows Server Actions with auth checks, HOCs, or non-actions', () => {
  const withAuthCall = [
    "'use server';",
    'export async function deleteAccount(userId: string) {',
    '  const session = await getServerSession();',
    '  if (!session) throw new Error("Unauthorized");',
    '  await db.user.delete({ where: { id: userId } });',
    '}',
  ].join('\n');
  assert.deepEqual(scan(withAuthCall, 'server-action-missing-auth'), []);

  const withHoc = [
    "'use server';",
    'export const updateProfile = withAuth(async (data: unknown) => {',
    '  await saveProfile(data);',
    '});',
  ].join('\n');
  assert.deepEqual(scan(withHoc, 'server-action-missing-auth'), []);

  const nonExportedHelper = ["'use server';", 'async function helper(id: string) {', '  return id;', '}'].join('\n');
  assert.deepEqual(scan(nonExportedHelper, 'server-action-missing-auth'), []);
});

test('ssrf-redirect-bypass: reports dynamic URL requests without redirect disabled', () => {
  assert.equal(scan("app.get('/p', async (req, res) => fetch(req.query.url));", 'ssrf-redirect-bypass').length, 1);
  assert.equal(scan("app.get('/p', async (req, res) => axios.get(req.query.url));", 'ssrf-redirect-bypass').length, 1);
  assert.equal(scan("app.get('/p', async (req, res) => got(req.query.url));", 'ssrf-redirect-bypass').length, 1);
  assert.equal(scan("app.get('/p', (req, res) => http.request(req.query.url));", 'ssrf-redirect-bypass').length, 1);
});

test('ssrf-redirect-bypass: allows literal URLs, redirect-disabled options, and validated URLs', () => {
  assert.deepEqual(
    scan('async function go() { return fetch("https://api.example.com/v1/items"); }', 'ssrf-redirect-bypass'),
    [],
  );
  assert.deepEqual(
    scan('async function go(url: string) { return fetch(url, { redirect: "manual" }); }', 'ssrf-redirect-bypass'),
    [],
  );
  assert.deepEqual(
    scan('async function go(url: string) { return fetch(url, { redirect: "error" }); }', 'ssrf-redirect-bypass'),
    [],
  );
  assert.deepEqual(
    scan('async function go(url: string) { return axios.get(url, { maxRedirects: 0 }); }', 'ssrf-redirect-bypass'),
    [],
  );
  assert.deepEqual(
    scan('async function go(url: string) { return got(url, { followRedirect: false }); }', 'ssrf-redirect-bypass'),
    [],
  );
  assert.deepEqual(
    scan(
      'async function go(url: string) { if (!isAllowedUrl(url)) throw new Error("bad"); return fetch(url); }',
      'ssrf-redirect-bypass',
    ),
    [],
  );
});

test('vm-sandbox-escape: reports vm dynamic execution, untrusted context, and vm2', () => {
  assert.equal(
    scan('import vm from "node:vm";\nvm.runInNewContext(userCode, sandbox);', 'vm-sandbox-escape').length,
    1,
  );
  assert.equal(scan('import vm from "node:vm";\nvm.runInThisContext(code);', 'vm-sandbox-escape').length, 1);
  assert.equal(scan('import vm from "node:vm";\nnew vm.Script(userCode);', 'vm-sandbox-escape').length, 1);
  assert.equal(scan('import { NodeVM } from "vm2";\nnew NodeVM({ sandbox: {} });', 'vm-sandbox-escape').length, 1);
});

test('vm-sandbox-escape: allows static vm literals without context and isolated-vm', () => {
  assert.deepEqual(scan('import vm from "node:vm";\nvm.runInNewContext("1 + 1");', 'vm-sandbox-escape'), []);
  assert.deepEqual(scan('import vm from "node:vm";\nnew vm.Script("return 42;");', 'vm-sandbox-escape'), []);
  assert.deepEqual(scan('import ivm from "isolated-vm";\nconst isolate = new ivm.Isolate();', 'vm-sandbox-escape'), []);
});

test('jwt-weak-secret-literal: reports short or weak literal secrets in jwt calls', () => {
  assert.equal(
    scan('import jwt from "jsonwebtoken";\njwt.sign({ sub: 1 }, "short-secret");', 'jwt-weak-secret-literal').length,
    1,
  );
  assert.equal(
    scan('import jwt from "jsonwebtoken";\nconst KEY = "my-secret";\njwt.verify(tok, KEY);', 'jwt-weak-secret-literal')
      .length,
    1,
  );
  assert.equal(
    scan(
      'import { jwtVerify } from "jose";\njwtVerify(tok, new TextEncoder().encode("weak"));',
      'jwt-weak-secret-literal',
    ).length,
    1,
  );
  assert.equal(
    scan('JwtModule.register({ secret: "changeme-super-secret-value-123456" });', 'jwt-weak-secret-literal').length,
    1,
  );
});

test('jwt-weak-secret-literal: allows env vars, PEM keys, and strong 32+ char secrets', () => {
  assert.deepEqual(
    scan('import jwt from "jsonwebtoken";\njwt.sign({ sub: 1 }, process.env.JWT_SECRET);', 'jwt-weak-secret-literal'),
    [],
  );
  assert.deepEqual(
    scan(
      'import jwt from "jsonwebtoken";\njwt.sign({ sub: 1 }, "K9#mP2$vL8@xQ5!wR7&zN4*jT6^cB3%yH");',
      'jwt-weak-secret-literal',
    ),
    [],
  );
  assert.deepEqual(
    scan(
      'import jwt from "jsonwebtoken";\njwt.sign({ sub: 1 }, "-----BEGIN PRIVATE KEY-----\\nMIIEvQ\\n-----END PRIVATE KEY-----");',
      'jwt-weak-secret-literal',
    ),
    [],
  );
});

test('graphql-batching-unbounded: reports GraphQL batching enabled without limits', () => {
  assert.equal(
    scan('new ApolloServer({ typeDefs, resolvers, allowBatchedHttpRequests: true });', 'graphql-batching-unbounded')
      .length,
    1,
  );
  assert.equal(scan('createYoga({ schema, batching: true });', 'graphql-batching-unbounded').length, 1);
  assert.equal(
    scan('GraphQLModule.forRoot({ allowBatchedHttpRequests: true });', 'graphql-batching-unbounded').length,
    1,
  );
});

test('graphql-batching-unbounded: allows disabled batching or batching with limits', () => {
  assert.deepEqual(
    scan('new ApolloServer({ typeDefs, resolvers, allowBatchedHttpRequests: false });', 'graphql-batching-unbounded'),
    [],
  );
  assert.deepEqual(scan('createYoga({ schema, batching: { limit: 5 } });', 'graphql-batching-unbounded'), []);
  assert.deepEqual(
    scan(
      'new ApolloServer({ typeDefs, resolvers, allowBatchedHttpRequests: true, validationRules: [depthLimit(5)] });',
      'graphql-batching-unbounded',
    ),
    [],
  );
});

test('express-cookie-auth-missing-csrf: reports cookie auth with state-changing routes and no CSRF', () => {
  const expressApp = [
    "import express from 'express';",
    "import cookieParser from 'cookie-parser';",
    'const app = express();',
    'app.use(cookieParser());',
    "app.post('/transfer', (req, res) => res.send('ok'));",
  ].join('\n');
  assert.equal(scan(expressApp, 'express-cookie-auth-missing-csrf').length, 1);

  const sessionApp = [
    "import session from 'express-session';",
    "app.use(session({ secret: process.env.SESSION_SECRET, cookie: { sameSite: 'lax' } }));",
    "app.delete('/account', handler);",
  ].join('\n');
  assert.equal(scan(sessionApp, 'express-cookie-auth-missing-csrf').length, 1);
});

test('express-cookie-auth-missing-csrf: allows CSRF middleware, sameSite strict, or read-only routes', () => {
  const withCsrf = [
    "import express from 'express';",
    "import cookieParser from 'cookie-parser';",
    "import csurf from 'csurf';",
    'const app = express();',
    'app.use(cookieParser());',
    'app.use(csurf({ cookie: true }));',
    "app.post('/transfer', (req, res) => res.send('ok'));",
  ].join('\n');
  assert.deepEqual(scan(withCsrf, 'express-cookie-auth-missing-csrf'), []);

  const withStrict = [
    "import session from 'express-session';",
    "app.use(session({ secret: process.env.SESSION_SECRET, cookie: { sameSite: 'strict' } }));",
    "app.post('/login', handler);",
  ].join('\n');
  assert.deepEqual(scan(withStrict, 'express-cookie-auth-missing-csrf'), []);

  const readOnly = [
    "import cookieParser from 'cookie-parser';",
    'app.use(cookieParser());',
    "app.get('/health', (req, res) => res.send('ok'));",
  ].join('\n');
  assert.deepEqual(scan(readOnly, 'express-cookie-auth-missing-csrf'), []);
});
