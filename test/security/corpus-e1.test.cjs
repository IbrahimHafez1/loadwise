'use strict';

// Corpus round d (hoppscotch, payload, admissions, formbricks, immich, pos, n8n, twenty, novu, outline, aquanex,
// documenso, juice-shop, NodeGoat): false positives that stay quiet, and the nearest unsafe shapes still reported.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { stubs } = require('./helpers.cjs');
const { findingsOf } = require('./exposure-helpers.cjs');
const { withProgram } = require('../performance/helpers.cjs');
const { analyzeFile } = require('../../lib/security/analyze.cjs');

// [line, 'D' default | 'C' contextual] for one rule, with the typed and untyped runs compared.
function ruleLines(ruleId, source, files) {
  return findingsOf(ruleId, source, files).map((finding) => [finding.line, finding.contextualReason ? 'C' : 'D']);
}

function findingsInFile(ruleId, filename, source, mainSource = 'export {};', files = {}) {
  return withProgram(mainSource, { ...files, [filename]: source }, (program) => {
    const sourceFile = program.getSourceFiles().find((file) => file.fileName.endsWith(filename));
    return analyzeFile(program, sourceFile).filter((finding) => finding.ruleId === ruleId);
  });
}

test('hardcoded-secret: publishable keys and translated labels are not credentials', () => {
  const source = [
    "export const POSTHOG_API_KEY = 'phc_Abc123Def456Ghi789Jkl012';",
    "export const STRIPE_PUBLISHABLE_KEY = 'pk_live_Abc123Def456Ghi789';",
    "export const de = { apiKey: 'API-Schlüssel', password: 'Passwörter-Ändern' };",
    "export const SERVER_API_KEY = 'xk9_Abc123Def456Ghi789Jkl012';",
  ].join('\n');
  assert.deepEqual(ruleLines('hardcoded-secret', source), [[4, 'D']]);
});

test('hardcoded-secret: a test helper named after its role is test source', () => {
  const source = "export const secret = process.env.JWT_SECRET ?? 'test-Jwt-Secret-9f8e7d6c5b4a';";
  for (const filename of ['src/jwt-test.helper.ts', 'src/test-utils.ts', 'src/testSetup.ts'])
    assert.deepEqual(findingsInFile('hardcoded-secret', filename, source), [], filename);
  for (const filename of ['src/jwt.helper.ts', 'src/contest-utils.ts'])
    assert.equal(findingsInFile('hardcoded-secret', filename, source).length, 1, filename);
});

const caught = (body) =>
  `declare function load(): void;\nexport function route(req: any, res: any) { try { load(); } catch (error) {\n${body}\n} }`;

test('error-stack-in-response: a plain object with message and stack fields is not an error', () => {
  const plain = [
    'declare const isDev: boolean;',
    'export function send(res: any, err: Error, message: string) {',
    '  const response = { success: false, message, ...(isDev && { stack: err.stack }) };',
    '  res.status(500).json(response);',
    '}',
  ].join('\n');
  assert.deepEqual(ruleLines('error-stack-in-response', plain), []);
  const derived = [
    'class AppError extends Error { code = 1 }',
    'export function send(res: any, err: AppError) { res.status(500).json(err); }',
  ].join('\n');
  assert.deepEqual(ruleLines('error-stack-in-response', derived), [[2, 'C']]);
});

test('error-stack-in-response: a four-parameter function needs Express parameter names', () => {
  const helper =
    'export const gone = (message: string, details?: object, cors = false, cache = "none") => Response.json({ message, details, cors, cache });';
  assert.deepEqual(ruleLines('error-stack-in-response', helper), []);
  const handler = 'export function onError(err: any, _req: any, res: any, _next: any) { res.json({ error: err }); }';
  assert.deepEqual(ruleLines('error-stack-in-response', handler), [[1, 'C']]);
});

test('error-stack-in-response: `instanceof Error ? error.message : error` exposes only the message', () => {
  assert.deepEqual(
    ruleLines(
      'error-stack-in-response',
      caught('res.json({ error: error instanceof Error ? error.message : error });'),
    ),
    [],
  );
  assert.deepEqual(
    ruleLines(
      'error-stack-in-response',
      caught('res.json({ error: !(error instanceof Error) ? error : error.message });'),
    ),
    [],
  );
  assert.deepEqual(
    ruleLines(
      'error-stack-in-response',
      caught('res.json({ error: error instanceof Error ? error : error.message });'),
    ),
    [[3, 'C']],
  );
});

test('cors-credentials-any-origin: a development-only branch is not reported', () => {
  const source = [
    'declare const app: any, isProduction: boolean, allowed: string[];',
    'if (isProduction) app.enableCors({ origin: allowed, credentials: true });',
    'else app.enableCors({ origin: true, credentials: true });',
    'app.enableCors({ origin: true, credentials: true });',
  ].join('\n');
  assert.deepEqual(ruleLines('cors-credentials-any-origin', source), [[4, 'D']]);
});

test('cors-credentials-any-origin: an origin echoed only after an allowlist check is not reported', () => {
  const handler = (condition) =>
    [
      'declare const allowed: string[], config: { origins: string[] };',
      'export function withCors(req: any, res: any) {',
      '  const requestOrigin = req.headers.origin;',
      `  if (${condition}) {`,
      "    res.setHeader('Access-Control-Allow-Credentials', 'true');",
      "    res.setHeader('Access-Control-Allow-Origin', requestOrigin!);",
      '  }',
      '}',
    ].join('\n');
  for (const condition of [
    'allowed.includes(requestOrigin)',
    '(Array.isArray(allowed) && allowed.indexOf(requestOrigin!) > -1) || config.origins.indexOf(requestOrigin!) !== -1',
    'allowed.some((item) => item === requestOrigin)',
  ])
    assert.deepEqual(ruleLines('cors-credentials-any-origin', handler(condition)), [], condition);
  for (const condition of [
    'requestOrigin',
    '!allowed.includes(requestOrigin)',
    'allowed.indexOf(requestOrigin) === -1',
    'allowed.includes(requestOrigin) || requestOrigin',
  ])
    assert.deepEqual(ruleLines('cors-credentials-any-origin', handler(condition)), [[6, 'D']], condition);
});

test('tls-verification-disabled: an explicit self-signed opt-in or a libpq no-verify mode is not reported', () => {
  const source = [
    'declare const config: { get(key: string): unknown };',
    "export const a = { ssl: process.env.PG_SSL_ALLOW_SELF_SIGNED === 'true' ? { rejectUnauthorized: false } : undefined };",
    "export const b = { ssl: config.get('PG_SSL_ALLOW_SELF_SIGNED') ? { rejectUnauthorized: false } : true };",
    'export function sslConfig(mode?: string) {',
    "  if (mode === 'require' || mode === 'prefer' || mode === 'allow') return { rejectUnauthorized: false };",
    "  if (mode === 'verify-full') return { rejectUnauthorized: true };",
    '  return false;',
    '}',
    "export const c = { ssl: process.env.PG_SSL_ALLOW_SELF_SIGNED !== 'false' ? { rejectUnauthorized: false } : true };",
    'export const d = { ssl: process.env.ALLOW_SELF_SIGNED || process.env.CI ? { rejectUnauthorized: false } : true };',
    "export const e = { ssl: process.env.SSL_MODE === 'require' || other() ? { rejectUnauthorized: false } : true };",
    "export const f = { ssl: process.env.SSL_MODE === 'verify-full' ? { rejectUnauthorized: false } : true };",
    'declare function other(): boolean;',
  ].join('\n');
  assert.deepEqual(
    ruleLines('tls-verification-disabled', source),
    [9, 10, 11, 12].map((line) => [line, 'D']),
  );
});

test('prototype-pollution: a single-key write of a primitive value cannot change a prototype', () => {
  const route = (body) =>
    [
      "import express from 'express';",
      'declare function clean(value: string): string;',
      'const app = express();',
      `app.post('/x', (req, res) => { const target: any = {}; const key: string = req.body.key; ${body} });`,
    ].join('\n');
  for (const body of [
    "target[key] = req.body.order === 'asc' ? 1 : -1;",
    'target[key] = true;',
    'target[key] = clean(req.body.value);',
    'target[key] = undefined;',
  ])
    assert.deepEqual(ruleLines('prototype-pollution', route(body), stubs.express), [], body);
  assert.deepEqual(ruleLines('prototype-pollution', route('target[key] = req.body.value;'), stubs.express), [[4, 'C']]);
  assert.deepEqual(ruleLines('prototype-pollution', route('target[key][req.body.field] = 1;'), stubs.express), [
    [4, 'D'],
  ]);
});

const jwtTypes = {
  'node_modules/@types/jsonwebtoken/index.d.ts': [
    'export declare function sign(payload: object | string, key: string, options?: object): string;',
    'export declare function decode(token: string, options?: object): any;',
  ].join('\n'),
};

test('jwt-sign-without-expiry: an explicit exp or expiresAt claim, also after a spread, is an expiry', () => {
  const source = [
    "import jwt from 'jsonwebtoken';",
    'declare const payload: object, key: string, iat: number, user: { id: string }, later: Date, maybe: Date | undefined;',
    'const exp = iat + 3600;',
    'export const a = jwt.sign({ ...payload, iat, exp }, key);',
    'export const b = jwt.sign({ id: user.id, expiresAt: later.toISOString() }, key);',
    'export const c = jwt.sign({ id: user.id, expiresAt: maybe ? maybe.toISOString() : undefined }, key);',
    'export const d = jwt.sign({ exp, ...payload }, key);',
    'export const e = jwt.sign({ id: user.id, expiresAt: maybe }, key);',
  ].join('\n');
  assert.deepEqual(ruleLines('jwt-sign-without-expiry', source, jwtTypes), [
    [6, 'D'],
    [7, 'C'],
    [8, 'D'],
  ]);
});

test('jwt-decode-for-auth: decoding a token this code just signed is not reported', () => {
  const source = [
    "import jwt from 'jsonwebtoken';",
    'declare const key: string, incoming: string;',
    'export function issue() {',
    "  const token = jwt.sign({ purpose: 'gateway' }, key, { expiresIn: 60 });",
    '  const decoded = jwt.decode(token);',
    "  if (!decoded || typeof decoded !== 'object') throw new Error('bad token');",
    '  return { token, decoded };',
    '}',
    'export function read() {',
    '  const decoded = jwt.decode(incoming);',
    "  if (!decoded || typeof decoded !== 'object') throw new Error('bad token');",
    '  return decoded;',
    '}',
  ].join('\n');
  assert.deepEqual(ruleLines('jwt-decode-for-auth', source, jwtTypes), [[10, 'C']]);
});

test('secret-in-log: a whole request body passed through a masking replacer is not reported', () => {
  const source = [
    'declare const logger: { verbose(text: string): void };',
    "const replacer = (key: string, value: unknown) => (key.toLowerCase().includes('password') ? '********' : value);",
    'function mask(key: string, value: unknown) { return /token|secret/i.test(key) ? undefined : value; }',
    'export function log(req: any) {',
    '  logger.verbose(JSON.stringify(req.body, replacer));',
    '  logger.verbose(JSON.stringify(req.body, mask));',
    '  logger.verbose(JSON.stringify(req.body, (key, value) => value));',
    '  logger.verbose(JSON.stringify(req.body));',
    '}',
  ].join('\n');
  assert.deepEqual(ruleLines('secret-in-log', source), [
    [7, 'C'],
    [8, 'C'],
  ]);
});

test('weak-password-hash: a SHA-1 prefix for the HaveIBeenPwned range API is not a stored hash', () => {
  const source = [
    "import { createHash } from 'crypto';",
    'export async function isCompromised(password: string) {',
    "  const sha1 = createHash('sha1').update(password).digest('hex').toUpperCase();",
    '  const response = await fetch(`https://api.pwnedpasswords.com/range/${sha1.substring(0, 5)}`);',
    '  return (await response.text()).includes(sha1.substring(5));',
    '}',
    'export function store(password: string) {',
    "  const digest = createHash('sha1').update(password).digest('hex');",
    '  return { digest, short: digest.slice(0, 8) };',
    '}',
  ].join('\n');
  assert.deepEqual(ruleLines('weak-password-hash', source), [[8, 'D']]);
});

test('weak-password-hash: a project MD5 helper is followed one call deep', () => {
  const helper = {
    'lib/insecurity.ts': [
      "import crypto from 'crypto';",
      "export const hash = (data: string) => crypto.createHash('md5').update(data).digest('hex');",
      'export const checksum = (data: string) => data.length.toString(16);',
    ].join('\n'),
  };
  const source = [
    "import * as security from './lib/insecurity.js';",
    'declare const body: { password: string; email: string };',
    'export const a = security.hash(body.password);',
    'export const passwordHash = security.hash(body.email);',
    'export const b = security.hash(body.email);',
    'export const c = security.checksum(body.password);',
  ].join('\n');
  assert.deepEqual(ruleLines('weak-password-hash', source, helper), [
    [3, 'D'],
    [4, 'D'],
  ]);
});

const expressRoute = (...body) =>
  [
    "import express from 'express';",
    'declare const db: any, MarsDB: any, firestore: any;',
    'const app = express();',
    "app.post('/x', (req, res) => {",
    ...body,
    '});',
  ].join('\n');

test('nosql-operator-injection: collections named by a literal are MongoDB receivers', () => {
  const source = expressRoute(
    "  db.collection('users').findOne({ userName: req.body.userName });",
    "  const reviews = new MarsDB.Collection('reviews');",
    '  reviews.update({ _id: req.body.id }, { $set: { message: req.body.message } });',
    "  firestore.collection('users').where(req.body.field, '==', 1);",
    "  db.collection(req.body.name).findOne({ userName: 'admin' });",
  );
  assert.deepEqual(ruleLines('nosql-operator-injection', source, stubs.express), [
    [5, 'D'],
    [7, 'D'],
  ]);
});

test('nosql-operator-injection: request text in $where is reported on any receiver', () => {
  const source = expressRoute(
    '  const orders: { find(filter: object): unknown } = MarsDB.open();',
    '  orders.find({ $where: `this.orderId === "${req.params.id}"` });',
    "  orders.find({ status: req.body.status, $where: 'this.total > 0' });",
  );
  assert.deepEqual(ruleLines('nosql-operator-injection', source, stubs.express), [[6, 'D']]);
});

test('nosql-operator-injection: a filter built by a local function and a this.method DAO are followed', () => {
  const dao = [
    'export function AllocationsDAO(db) {',
    "  const allocations = db.collection('allocations');",
    '  this.getByThreshold = (userId, threshold, callback) => {',
    '    const searchCriteria = () => {',
    '      if (threshold) return { $where: `this.userId == ${userId} && this.stocks > ${threshold}` };',
    '      return { userId: userId };',
    '    };',
    '    allocations.find(searchCriteria()).toArray(callback);',
    '  };',
    '}',
  ].join('\n');
  const source = [
    "import express from 'express';",
    "import { AllocationsDAO } from './allocations-dao.js';",
    'declare const db: any;',
    'const app = express();',
    'const allocationsDAO = new AllocationsDAO(db);',
    "app.get('/allocations', (req, res) => {",
    '  allocationsDAO.getByThreshold(1, req.query.threshold, () => res.send("ok"));',
    '});',
  ].join('\n');
  const findings = findingsInFile('nosql-operator-injection', 'allocations-dao.js', dao, source, stubs.express);
  assert.deepEqual(
    findings.map((finding) => [finding.line, finding.message.includes('req.query.threshold')]),
    [[5, true]],
  );
});

test('template-autoescape-disabled: swig, nunjucks and Handlebars with escaping turned off', () => {
  const source = [
    "import swig from 'swig';",
    "import nunjucks from 'nunjucks';",
    "import Handlebars from 'handlebars';",
    'declare const loader: unknown, page: string;',
    'swig.setDefaults({ autoescape: false });',
    "nunjucks.configure('views', { autoescape: false });",
    'const environment = new nunjucks.Environment(loader, { autoescape: false });',
    'const render = Handlebars.compile(page, { noEscape: true });',
    'swig.setDefaults({ autoescape: true, cache: false });',
    'nunjucks.configure({ autoescape: true });',
    'const safe = Handlebars.compile(page, { noEscape: false });',
    'const other = { setDefaults(options: object) {} };',
    'other.setDefaults({ autoescape: false });',
  ].join('\n');
  assert.deepEqual(
    ruleLines('template-autoescape-disabled', source),
    [5, 6, 7, 8].map((line) => [line, 'D']),
  );
});

test('nosql-operator-injection: a collection exported from a module and read through a namespace import', () => {
  const files = {
    ...stubs.express,
    'data/mongodb.ts': "declare const MarsDB: any;\nexport const reviews = new MarsDB.Collection('posts');",
  };
  const source = [
    "import express from 'express';",
    "import * as db from './data/mongodb.js';",
    'const app = express();',
    "app.post('/x', (req, res) => {",
    '  db.reviews.update({ _id: req.body.id }, { $set: { message: req.body.message } });',
    '});',
  ].join('\n');
  assert.deepEqual(ruleLines('nosql-operator-injection', source, files), [[5, 'D']]);
});
