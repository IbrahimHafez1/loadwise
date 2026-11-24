// Handler shapes of Next.js, Hono, Fastify and tRPC: a list query returned from a recognised
// handler is reported by
// `unbounded-list-query`, the same query in an ordinary function is not.
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { withProgram } from './helpers.cjs';
import type { Finding, ProgramAdapter } from '../../lib/shared/types.cjs';
import type { FileMap } from '../types/project-files.cjs';
import { lineOf } from '../types/finding-fix.cjs';
import { sourceFileAt } from '../types/schema-lookups.cjs';
import { requireNativeSourceFile } from '../types/native-program.cjs';
import type * as NativeRuntime from '../../lib/performance/native-runtime.cjs';
import type * as Compiler from '../../lib/performance/compiler.cjs';
import type * as NativeChecker from '../../lib/performance/native-checker.cjs';
import type * as PerformanceAnalyze from '../../lib/performance/analyze.cjs';
import type * as NativeSyntax from '../../lib/performance/native-syntax.cjs';

const RULE_ID = 'unbounded-list-query';
const useNative = process.env.PERF_CHECK_TEST_NATIVE === '1';
const virtualRoot = path.join(__dirname, 'virtual-project');
const prismaStub = {
  'node_modules/@prisma/client/index.d.ts': "export * from '.prisma/client';",
  'node_modules/.prisma/client/index.d.ts': `export interface UserDelegate {
      findMany(args?: object): Promise<{ id: number }[]>;
    }
    export declare class PrismaClient { user: UserDelegate }`,
};
const prelude = `import type { PrismaClient } from '@prisma/client';
declare const prisma: PrismaClient;
`;
const preludeLines = prelude.split('\n').length - 1;

function lintNative(fileName: string, source: string, files: FileMap) {
  const { requireNative }: typeof NativeRuntime = require('../../lib/performance/native-runtime.cjs');
  const { API, ModuleKind, ModuleResolutionKind } = requireNative('typescript/sync');
  const { ScriptTarget } = requireNative('typescript/ast');
  const { createFileSystemWithLib } = requireNative('typescript/fs');
  const { selectNativeSyntax }: typeof Compiler = require('../../lib/performance/compiler.cjs');
  const { adaptProgram }: typeof NativeChecker = require('../../lib/performance/native-checker.cjs');
  const nativeSyntax: typeof NativeSyntax = require('../../lib/performance/native-syntax.cjs');
  selectNativeSyntax(nativeSyntax.default);
  const { analyzeFile }: typeof PerformanceAnalyze = require('../../lib/performance/analyze.cjs');
  const entries = Object.entries({ [fileName]: source, ...files }).map(([name, contents]) => [
    path.join(virtualRoot, name),
    contents,
  ]);
  const rootFiles = entries
    .filter(([name]) => !name.includes(path.sep + 'node_modules' + path.sep) && /\.[cm]?[jt]sx?$/.test(name))
    .map(([name]) => name);
  const api = new API();
  try {
    const snapshot = api.createSnapshot({
      fileSystem: createFileSystemWithLib(entries),
      createPrograms: [
        {
          rootFiles,
          compilerOptions: {
            target: ScriptTarget.ES2022,
            module: ModuleKind.NodeNext,
            moduleResolution: ModuleResolutionKind.NodeNext,
            strict: true,
            allowJs: true,
            skipLibCheck: true,
            types: [],
            lib: ['es2022'],
          },
        },
      ],
    });
    try {
      const program = snapshot.operation.createdPrograms[0];
      try {
        const adapted = adaptProgram(program, { strict: true });
        return analyzeFile(adapted, requireNativeSourceFile(program, path.join(virtualRoot, fileName)));
      } finally {
        program.dispose();
      }
    } finally {
      snapshot.dispose();
    }
  } finally {
    api.close();
  }
}

function lintTypeScript(fileName: string, source: string, files: FileMap) {
  return withProgram('', { [fileName]: source, ...files }, (program: ProgramAdapter) => {
    const { analyzeFile }: typeof PerformanceAnalyze = require('../../lib/performance/analyze.cjs');
    return analyzeFile(program, sourceFileAt(program, path.join(virtualRoot, fileName)));
  });
}

// Lines (relative to `body`) of unbounded list queries in a file called `fileName`.
function reportedLines(fileName: string, body: string, extraFiles: FileMap = {}, directive = '') {
  const files = { ...prismaStub, ...extraFiles };
  const source = directive + prelude + body;
  const offset = preludeLines + directive.split('\n').length - 1;
  const findings = useNative ? lintNative(fileName, source, files) : lintTypeScript(fileName, source, files);
  return findings
    .filter((finding: Finding) => finding.ruleId === RULE_ID)
    .map((finding: Finding) => lineOf(finding) - offset);
}

const honoStub = {
  'node_modules/hono/index.d.ts': 'export declare class Hono { get(path: string, ...handlers: unknown[]): this }',
};
const fastifyStub = {
  'node_modules/fastify/index.d.ts': 'declare const fastify: () => unknown; export default fastify;',
};

test('Next App Router handlers are recognised in route files whatever the parameter names', () => {
  const body = [
    'export async function GET(incoming: Request, { params }: { params: { id: string } }) {',
    '  return Response.json(await prisma.user.findMany());',
    '}',
    'export const POST = async (input: Request) => Response.json(await prisma.user.findMany());',
    'export const HEAD = async function (input: Request) { return prisma.user.findMany(); };',
    'async function helper() { return prisma.user.findMany(); }',
    'export const LIMIT = async () => prisma.user.findMany();',
  ].join('\n');
  assert.deepEqual(reportedLines('app/api/users/route.ts', body), [2, 4, 5]);
  assert.deepEqual(reportedLines('src/lib/users.ts', body), []);
});

test('Next Pages API default exports are handlers whatever the parameter names', () => {
  const direct =
    'export default async function (incoming: any, response: any) { response.json(await prisma.user.findMany()); }';
  const named = [
    'async function list(a: any, response: any) { response.json(await prisma.user.findMany()); }',
    'export default list;',
  ].join('\n');
  assert.deepEqual(reportedLines('pages/api/users.ts', direct), [1]);
  assert.deepEqual(reportedLines('pages/api/users.ts', named), [1]);
  assert.deepEqual(reportedLines('lib/users.ts', direct), []);
});

test('server actions are the exported async functions of a use-server file or functions with the directive', () => {
  const fileLevel = [
    'export async function listUsers() { return prisma.user.findMany(); }',
    'export const listAgain = async () => prisma.user.findMany();',
    'async function internal() { return prisma.user.findMany(); }',
  ].join('\n');
  assert.deepEqual(reportedLines('actions.ts', fileLevel, {}, "'use server';\n"), [1, 2]);
  const functionLevel = [
    'export function Page() {',
    '  async function load() {',
    "    'use server';",
    '    return prisma.user.findMany();',
    '  }',
    '  return load;',
    '}',
  ].join('\n');
  assert.deepEqual(reportedLines('page.ts', functionLevel), [4]);
  const plain = 'export async function listUsers() { return prisma.user.findMany(); }';
  assert.deepEqual(reportedLines('actions.ts', plain), []);
});

test('Hono callbacks are handlers when they use the context, found by import or by the c.req shape', () => {
  const body = [
    "import { Hono } from 'hono';",
    "const app = new Hono().basePath('/api');",
    "app.get('/users', async (c) => c.json(await prisma.user.findMany()));",
    "app.post('/users', async (store) => prisma.user.findMany());",
    "app.on('GET', '/all', async (c) => c.json(await prisma.user.findMany()));",
    "const cache = new Map<string, number>(); cache.get('/k');",
  ].join('\n');
  assert.deepEqual(reportedLines('main.ts', body, honoStub), [3, 5]);
  const untyped = [
    'declare const app: any;',
    "app.get('/other', async (ctx: any) => { const query = ctx.req.query('q'); return prisma.user.findMany({ where: { query } }); });",
    "app.get('/helper', async (store: any) => prisma.user.findMany());",
  ].join('\n');
  assert.deepEqual(reportedLines('main.ts', untyped), []);
});

test('Fastify route calls, route options and plugins are handlers', () => {
  const body = [
    "import fastify from 'fastify';",
    'const server: any = fastify();',
    "server.get('/users', async (request: any) => prisma.user.findMany());",
    "server.get('/typed', { schema: {} }, async (incoming: any, reply: any) => reply.send(await prisma.user.findMany()));",
    "server.route({ method: 'GET', url: '/route', handler: async (request: any) => prisma.user.findMany() });",
    "server.route({ method: 'GET', url: '/short', async handler(request: any) { return prisma.user.findMany(); } });",
    "export default async function (fastify: any, opts: object) { fastify.get('/p', async (request: any) => prisma.user.findMany()); }",
    'async function plain() { return prisma.user.findMany(); }',
  ].join('\n');
  assert.deepEqual(reportedLines('main.ts', body, fastifyStub), [3, 4, 5, 6, 7]);
  const unrelated = [
    'declare const cache: any;',
    "cache.get('/users', async (request: any) => prisma.user.findMany());",
  ].join('\n');
  assert.deepEqual(reportedLines('main.ts', unrelated), []);
});

test('tRPC resolvers on procedure builders are handlers', () => {
  const body = [
    'declare const publicProcedure: any, t: any, protectedProcedure: any, client: any, schema: object;',
    'const router = {',
    '  list: publicProcedure.input(schema).query(async ({ input, ctx }: any) => prisma.user.findMany()),',
    '  save: protectedProcedure.input(schema).mutation(async (options: any) => prisma.user.findMany()),',
    '  feed: t.procedure.subscription(async () => prisma.user.findMany()),',
    '  other: client.fetch.query(async () => prisma.user.findMany()),',
    '};',
  ].join('\n');
  assert.deepEqual(reportedLines('main.ts', body), [3, 4, 5]);
});

test('Express handlers keep working next to the new shapes', () => {
  const body = [
    'declare const app: { get(path: string, handler: (req: any, res: any) => void): void };',
    "app.get('/users', async (req, res) => res.json(await prisma.user.findMany()));",
  ].join('\n');
  assert.deepEqual(reportedLines('main.ts', body), [2]);
});
