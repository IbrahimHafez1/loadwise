// Request data of Next.js, Hono, Fastify and tRPC handlers reaches SQL text; the same code outside
// a handler does not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sourceFileNamed } from './helpers.js';
import { withProgram } from '../performance/helpers.js';
import type { ProgramAdapter } from '../../lib/shared/types.js';
import type { LocatedFinding } from '../types/security.js';
import { analyzeFile } from '../../lib/security/analyze.js';

const RULE_ID = 'prisma-raw-unsafe-dynamic';
const prelude = 'declare const prisma: any;\n';
const preludeLines = prelude.split('\n').length - 1;

// Lines (relative to `body`) of default findings of the rule in a file called `fileName`.
function taintedLines(fileName: string, body: string, directive = '') {
  const source = directive + prelude + body;
  const offset = preludeLines + directive.split('\n').length - 1;
  const findings = withProgram('', { [fileName]: source }, (program: ProgramAdapter) =>
    analyzeFile(program, sourceFileNamed(program, fileName)),
  );
  return findings
    .filter((finding: LocatedFinding) => finding.ruleId === RULE_ID && !finding.contextualReason)
    .map((finding: LocatedFinding) => finding.line - offset);
}

test('Next App Router handler parameters are request data whatever they are called', () => {
  const body = [
    'export async function GET(incoming: Request, { params }: { params: { id: string } }) {',
    '  const sort = new URL(incoming.url).searchParams.get("sort");',
    '  await prisma.$queryRawUnsafe(`SELECT * FROM t WHERE id = ${params.id}`);',
    '  await prisma.$queryRawUnsafe(`SELECT * FROM t ORDER BY ${(incoming as any).nextUrl.searchParams.get("sort")}`);',
    '}',
    'export const POST = async (input: Request) => prisma.$queryRawUnsafe(await input.text());',
    'function helper(params: { id: string }) { return prisma.$queryRawUnsafe(`SELECT ${params.id}`); }',
  ].join('\n');
  assert.deepEqual(taintedLines('app/api/users/route.ts', body), [3, 4, 6]);
  assert.deepEqual(taintedLines('lib/users.ts', body), []);
});

test('Next Pages API default exports read req.query and req.body', () => {
  const body = [
    'export default async function (incoming: any, outgoing: any) {',
    '  await prisma.$queryRawUnsafe(`SELECT * FROM t WHERE a = ${incoming.query.a}`);',
    '  await prisma.$queryRawUnsafe(`SELECT * FROM t WHERE b = ${incoming.body.b}`);',
    '}',
  ].join('\n');
  assert.deepEqual(taintedLines('pages/api/users.ts', body), [2, 3]);
  assert.deepEqual(taintedLines('lib/users.ts', body), []);
});

test('server action arguments and FormData entries are request data', () => {
  const body = [
    'export async function search(term: string, form: FormData) {',
    '  await prisma.$queryRawUnsafe(`SELECT * FROM t WHERE a = ${term}`);',
    '  await prisma.$queryRawUnsafe(`SELECT * FROM t WHERE b = ${form.get("b")}`);',
    '}',
    'async function internal(term: string) { await prisma.$queryRawUnsafe(`SELECT ${term}`); }',
  ].join('\n');
  assert.deepEqual(taintedLines('actions.ts', body, "'use server';\n"), [2, 3]);
  assert.deepEqual(taintedLines('actions.ts', body), []);
  const inline = [
    'export function Page() {',
    '  async function save(term: string) {',
    "    'use server';",
    '    await prisma.$queryRawUnsafe(`SELECT ${term}`);',
    '  }',
    '  return save;',
    '}',
  ].join('\n');
  assert.deepEqual(taintedLines('page.ts', inline), [4]);
});

test('Hono context reads are request data', () => {
  const body = [
    "import { Hono } from 'hono';",
    'const app = new Hono();',
    "app.get('/users', async (c) => {",
    "  await prisma.$queryRawUnsafe(`SELECT * FROM t WHERE a = ${c.req.query('a')}`);",
    "  await prisma.$queryRawUnsafe(`SELECT * FROM t WHERE b = ${c.req.param('b')}`);",
    '  const payload = await c.req.json();',
    '  await prisma.$queryRawUnsafe(`SELECT * FROM t WHERE c = ${payload.c}`);',
    "  await prisma.$queryRawUnsafe(`SELECT * FROM t WHERE d = ${c.req.valid('json').d}`);",
    '  return c.json({});',
    '});',
    "app.get('/safe', async (c) => { await prisma.$queryRawUnsafe(`SELECT ${c.get('tenant')}`); return c.text(''); });",
  ].join('\n');
  assert.deepEqual(taintedLines('main.ts', body), [4, 5, 7, 8]);
});

test('Fastify request fields are request data in route calls and route options', () => {
  const body = [
    "import fastify from 'fastify';",
    'const server: any = fastify();',
    "server.get('/a', async (incoming: any) => prisma.$queryRawUnsafe(`SELECT ${incoming.query.a}`));",
    "server.route({ method: 'POST', url: '/b', handler: async (incoming: any) => prisma.$queryRawUnsafe(`SELECT ${incoming.body.b}`) });",
    "server.get('/c', async (incoming: any) => prisma.$queryRawUnsafe(`SELECT ${incoming.user.id}`));",
  ].join('\n');
  assert.deepEqual(taintedLines('main.ts', body), [3, 4]);
});

test('tRPC procedure input is request data', () => {
  const body = [
    'declare const publicProcedure: any, schema: object;',
    'const router = {',
    '  list: publicProcedure.input(schema).query(async ({ input }: any) => prisma.$queryRawUnsafe(`SELECT ${input.sort}`)),',
    '  other: publicProcedure.input(schema).query(async ({ ctx }: any) => prisma.$queryRawUnsafe(`SELECT ${ctx.tenant}`)),',
    '};',
  ].join('\n');
  assert.deepEqual(taintedLines('main.ts', body), [3]);
});
