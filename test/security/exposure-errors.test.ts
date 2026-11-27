import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findingsOf, defaultFindingsOf } from './exposure-helpers.js';

const ruleId = 'error-stack-in-response';
const handler = (body: string) =>
  `declare const isDev: boolean; declare function load(): void;\nexport function route(req: any, res: any, reply: any, ctx: any) { try { load(); } catch (err: any) { ${body} } }`;

test('an error stack in a response body is reported by default', () => {
  const bodies = [
    'res.status(500).json({ message: err.message, stack: err.stack });',
    'res.send(err.stack);',
    'res.status(500).send(`<pre>${err.stack}</pre>`);',
    'reply.send({ error: err.stack });',
    'ctx.body = { stack: err.stack };',
    'return new Response(JSON.stringify({ stack: err.stack }), { status: 500 });',
    'res.json({ details: String(err.stack) });',
  ];
  for (const body of bodies) assert.equal(defaultFindingsOf(ruleId, handler(body)).length, 1, body);
  const nest =
    "import { HttpException } from '@nestjs/common';\ndeclare const err: any;\nthrow new HttpException({ stack: err.stack }, 500);";
  assert.equal(defaultFindingsOf(ruleId, nest).length, 1);
  const nextResponse =
    'declare const NextResponse: any; declare const err: any;\nNextResponse.json({ stack: err.stack });';
  assert.equal(defaultFindingsOf(ruleId, nextResponse).length, 1);
});

test('a whole error object in a response body is contextual', () => {
  const bodies = [
    'res.status(500).json(err);',
    'res.status(500).json({ error: err });',
    'res.send([err]);',
    'res.json({ ...err });',
  ];
  for (const body of bodies) {
    const findings = findingsOf(ruleId, handler(body));
    assert.equal(findings.length, 1, body);
    assert.ok(findings[0].contextualReason, body);
  }
  const shorthand = handler('res.status(500).json({ err });');
  assert.equal(findingsOf(ruleId, shorthand).length, 1);
  const handlerShape = 'export function onError(err: any, req: any, res: any, next: any) { res.json({ error: err }); }';
  assert.equal(findingsOf(ruleId, handlerShape).length, 1);
});

test('the message and message-only responses', () => {
  const [finding] = findingsOf(ruleId, handler('res.send(err.stack);'));
  assert.match(finding.message, /^This response includes the error stack/);
  const clean = [
    'res.status(500).json({ message: err.message });',
    'res.status(500).send("Internal error");',
    'console.error(err.stack);',
    'res.json({ error: err.message, code: err.code });',
    'const stack = err.stack; res.send("failed");',
    'res.json({ error: String(err) });',
  ];
  for (const body of clean) assert.equal(findingsOf(ruleId, handler(body)).length, 0, body);
});

test('a stack returned only outside production is clean', () => {
  const bodies = [
    "if (process.env.NODE_ENV !== 'production') { res.json({ stack: err.stack }); }",
    "res.json({ stack: process.env.NODE_ENV === 'production' ? undefined : err.stack });",
    "res.json({ stack: process.env.NODE_ENV !== 'production' && err.stack });",
    'res.json({ stack: isDev ? err.stack : undefined });',
    "if (process.env.NODE_ENV === 'production') { res.json({}); } else { res.json({ stack: err.stack }); }",
  ];
  for (const body of bodies) assert.equal(findingsOf(ruleId, handler(body)).length, 0, body);
});

test('a stack passed to a receiver that is not a response is clean', () => {
  const source = (body: string) => `declare const logger: any; declare const other: any;
${handler(body)}`;
  assert.equal(findingsOf(ruleId, source('logger.send(err.stack);')).length, 0);
  assert.equal(findingsOf(ruleId, source('other.json({ stack: err.stack });')).length, 0);
});
