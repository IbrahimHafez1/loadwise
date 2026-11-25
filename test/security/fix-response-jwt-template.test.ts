import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanWithFixes, requireOnlyChange, requireFix, withSecurity } from '../performance/site-fix-helpers.js';
import type { TestContext } from 'node:test';

const jwtTypes = {
  'node_modules/@types/jsonwebtoken/index.d.ts': [
    'export declare function sign(payload: object | string, key: string | Buffer, options?: object): string;',
    'export declare function verify(token: string, key: string, options?: object): any;',
  ].join('\n'),
};

function findingFor(context: TestContext, ruleId: string, source: string, extraFiles: Record<string, string> = {}) {
  const { findings } = scanWithFixes(context, { 'main.ts': source, ...extraFiles }, { analyzers: withSecurity });
  const found = findings.find((finding) => finding.ruleId === ruleId);
  assert.ok(found, `${ruleId} reported nothing`);
  return found;
}

const handler = (body: string) =>
  `export function route(res: any, load: () => void) { try { load(); } catch (err: any) { ${body} } }`;

test('a stack property is removed, a stack value or whole error is replaced, always for review', (context) => {
  const removed = findingFor(
    context,
    'error-stack-in-response',
    handler('res.status(500).json({ message: "x", stack: err.stack });'),
  );
  assert.equal(requireFix(removed).requiresReview, true);
  assert.doesNotMatch(requireOnlyChange(removed).after, /stack/);
  assert.match(requireOnlyChange(removed).after, /res\.status\(500\)/);

  const replaced = findingFor(
    context,
    'error-stack-in-response',
    handler('res.status(500).json({ error: err.stack });'),
  );
  assert.match(requireOnlyChange(replaced).after, /error: 'Internal server error'/);

  const whole = findingFor(context, 'error-stack-in-response', handler('res.status(500).json(err);'));
  assert.match(requireOnlyChange(whole).after, /json\(\{ message: 'Internal server error' \}\)/);
});

test('error response fixes are withheld when the stack cannot be dropped without guessing', (context) => {
  const cases = [
    'res.status(500).json({ stack: err.stack });',
    'res.status(500).send(`<pre>${err.stack}</pre>`);',
    'res.json({ ...err });',
    'res.send([err]);',
  ];
  for (const body of cases) {
    const finding = findingFor(context, 'error-stack-in-response', handler(body));
    assert.ok(finding, body);
    assert.equal(finding.fix, undefined, body);
  }
});

test('a database error message is replaced and a template literal is left to the user', (context) => {
  const database = (body: string) =>
    `import { Pool } from 'pg';\nexport async function route(pool: Pool, res: any) { try { await pool.query('SELECT 1'); } catch (err: any) { ${body} } }`;
  const files = {
    'node_modules/pg/index.d.ts': 'export declare class Pool { query(text: string): Promise<unknown>; }',
  };
  const fixed = findingFor(
    context,
    'database-error-in-response',
    database('res.status(500).json({ error: err.message });'),
    files,
  );
  assert.match(requireOnlyChange(fixed).after, /error: 'Internal server error'/);
  const templated = findingFor(
    context,
    'database-error-in-response',
    database('res.status(500).send(`failed: ${err.message}`);'),
    files,
  );
  assert.equal(templated.fix, undefined);
});

test('jwt none is removed from an algorithms list but never replaced when signing', (context) => {
  const header = "import jwt from 'jsonwebtoken';\n";
  const list = findingFor(
    context,
    'jwt-none-algorithm',
    `${header}export const c = (t: string) => jwt.verify(t, 'k', { algorithms: ['HS256', 'none'] });`,
    jwtTypes,
  );
  assert.match(requireOnlyChange(list).after, /algorithms: \['HS256'\]/);
  const onlyNone = findingFor(
    context,
    'jwt-none-algorithm',
    `${header}export const c = (t: string) => jwt.verify(t, 'k', { algorithms: ['none'] });`,
    jwtTypes,
  );
  assert.equal(onlyNone.fix, undefined);
  const signing = findingFor(
    context,
    'jwt-none-algorithm',
    `${header}export const t = jwt.sign({ a: 1 }, 'k', { algorithm: 'none', expiresIn: 60 });`,
    jwtTypes,
  );
  assert.equal(signing.fix, undefined);
});

test('jwt expiry is a marked placeholder for review and withheld for non-literal payloads', (context) => {
  const header = "import jwt from 'jsonwebtoken';\n";
  const literal = findingFor(
    context,
    'jwt-sign-without-expiry',
    `${header}export const t = (id: string) => jwt.sign({ id }, 'k');`,
    jwtTypes,
  );
  assert.equal(requireFix(literal).requiresReview, true);
  assert.match(requireFix(literal).note ?? '', /placeholder/);
  assert.match(requireOnlyChange(literal).after, /\{ expiresIn: '15m' \}/);
  const opaque = findingFor(
    context,
    'jwt-sign-without-expiry',
    `${header}export const t = (claims: object) => jwt.sign(claims, 'k');`,
    jwtTypes,
  );
  assert.equal(opaque.fix, undefined);
});

test('autoescape is switched back on for review only for a literal false', (context) => {
  const nunjucks = {
    'node_modules/nunjucks/index.d.ts':
      'declare const n: { configure(p: string, o?: object): void }; export default n;',
  };
  const header = "import nunjucks from 'nunjucks';\n";
  const fixed = findingFor(
    context,
    'template-autoescape-disabled',
    `${header}nunjucks.configure('views', { autoescape: false });`,
    nunjucks,
  );
  assert.equal(requireFix(fixed).requiresReview, true);
  assert.match(requireOnlyChange(fixed).after, /autoescape: true/);
});
