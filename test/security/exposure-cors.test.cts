import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultFindingsOf } from './exposure-helpers.cjs';

const ruleId = 'cors-credentials-any-origin';
const corsImport = "import cors from 'cors';\ndeclare const app: any;\n";

test('credentials with a wildcard, true, match-everything or always-allow origin are reported', () => {
  const origins = [
    "'*'",
    'true',
    '/.*/',
    '(origin, done) => done(null, true)',
    '(origin, done) => { done(null, origin); }',
    '(origin, done) => { return done(null, true); }',
  ];
  for (const origin of origins) {
    const source = `${corsImport}app.use(cors({ origin: ${origin}, credentials: true }));`;
    assert.equal(defaultFindingsOf(ruleId, source).length, 1, origin);
  }
});

test('the other entry points are reported too', () => {
  const options = '{ origin: true, credentials: true }';
  const sources = [
    `declare const app: any;\napp.enableCors(${options});`,
    `declare const app: any; declare const NestFactory: any; declare const AppModule: any;\nNestFactory.create(AppModule, { cors: ${options} });`,
    `import fastifyCors from '@fastify/cors';\ndeclare const app: any;\napp.register(fastifyCors, ${options});`,
    `declare class Server { constructor(http: unknown, options: unknown); }\nnew Server({}, { cors: ${options} });`,
    `import koaCors from '@koa/cors';\ndeclare const app: any;\napp.use(koaCors(${options}));`,
    `import cors from 'cors';\nconst options = ${options};\ndeclare const app: any;\napp.use(cors(options));`,
  ];
  for (const source of sources) assert.equal(defaultFindingsOf(ruleId, source).length, 1, source);
});

test('a manual origin echo with credentials in the same function is reported', () => {
  const source = [
    'export function allow(req: any, res: any) {',
    "  res.setHeader('Access-Control-Allow-Origin', req.headers.origin);",
    "  res.setHeader('Access-Control-Allow-Credentials', 'true');",
    '}',
  ].join('\n');
  assert.equal(defaultFindingsOf(ruleId, source).length, 1);
  const bracket = source.replace('req.headers.origin', "req.headers['origin']");
  assert.equal(defaultFindingsOf(ruleId, bracket).length, 1);
});

test('listed origins, config values, a public wildcard and unrelated options are clean', () => {
  const clean = [
    "app.use(cors({ origin: 'https://app.example.com', credentials: true }));",
    "app.use(cors({ origin: ['https://a.example.com'], credentials: true }));",
    'app.use(cors({ origin: process.env.WEB_ORIGIN, credentials: true }));',
    "app.use(cors({ origin: '*' }));",
    "app.use(cors({ origin: '*', credentials: false }));",
    'app.use(cors({ origin: true }));',
    'app.use(cors({ origin: true, credentials: enabled }));',
    'app.use(cors({ origin: (origin, done) => done(null, allowed.includes(origin)), credentials: true }));',
    "app.use(cors({ origin: (origin, done) => { if (allowed.includes(origin)) return done(null, true); done(new Error('no')); }, credentials: true }));",
    'app.use(cors({ origin: /example[.]com$/, credentials: true }));',
    'app.use(cors({ ...base, credentials: true }));',
    'app.use(cors());',
  ];
  for (const line of clean) {
    const source = `${corsImport}declare const allowed: string[]; declare const enabled: boolean; declare const base: object;\n${line}`;
    assert.equal(defaultFindingsOf(ruleId, source).length, 0, line);
  }
  assert.equal(
    defaultFindingsOf(ruleId, "declare function cors(o: object): void;\ncors({ origin: '*', credentials: true });")
      .length,
    0,
  );
});

test('a manual origin echo without credentials, or from another source, is clean', () => {
  const withoutCredentials = [
    'export function allow(req: any, res: any) {',
    "  res.setHeader('Access-Control-Allow-Origin', req.headers.origin);",
    '}',
  ].join('\n');
  assert.equal(defaultFindingsOf(ruleId, withoutCredentials).length, 0);
  const fixedOrigin = [
    'export function allow(res: any) {',
    "  res.setHeader('Access-Control-Allow-Origin', 'https://app.example.com');",
    "  res.setHeader('Access-Control-Allow-Credentials', 'true');",
    '}',
  ].join('\n');
  assert.equal(defaultFindingsOf(ruleId, fixedOrigin).length, 0);
});
