import assert from 'node:assert/strict';
import { requireNativeSourceFile } from '../types/native-program.cjs';
import path from 'node:path';
import test from 'node:test';
import type { Node, SourceFile } from 'typescript';
import type { ProgramAdapter } from '../../lib/shared/types.cjs';
import type {
  FunctionSummaries,
  FunctionSummary,
  FunctionWithBody,
} from '../../lib/shared/types/function-summaries.cjs';
import type { FileMap } from '../types/project-files.cjs';
import type * as Compiler from '../../lib/performance/compiler.cjs';
import type * as NativeRuntime from '../../lib/performance/native-runtime.cjs';
import type * as NativeChecker from '../../lib/performance/native-checker.cjs';
import type * as NativeSyntax from '../../lib/performance/native-syntax.cjs';

const native = process.env.PERF_CHECK_TEST_NATIVE === '1';
// The native syntax must be selected before any rule module captures the compiler.
if (native) {
  const { selectNativeSyntax }: typeof Compiler = require('../../lib/performance/compiler.cjs');
  const nativeSyntax: typeof NativeSyntax = require('../../lib/performance/native-syntax.cjs');
  selectNativeSyntax(nativeSyntax.default);
}
import { loadSyntax } from '../../lib/performance/compiler.cjs';
import { withProgram } from '../performance/helpers.cjs';
import { functionSummaries } from '../../lib/shared/function-summaries.cjs';
const ts = loadSyntax();

const root = path.resolve(__dirname, '../performance/virtual-project');

function withNativeProgram<Result>(
  source: string,
  files: FileMap,
  callback: (program: ProgramAdapter, sourceFile: SourceFile) => Result,
): Result {
  const { requireNative }: typeof NativeRuntime = require('../../lib/performance/native-runtime.cjs');
  const { API, ModuleKind, ModuleResolutionKind } = requireNative('typescript/sync');
  const { ScriptTarget } = requireNative('typescript/ast');
  const { createFileSystemWithLib } = requireNative('typescript/fs');
  const { adaptProgram }: typeof NativeChecker = require('../../lib/performance/native-checker.cjs');
  const entries = Object.entries({ 'main.ts': source, ...files }).map(([name, contents]) => [
    path.join(root, name),
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
        return callback(adapted, requireNativeSourceFile(program, path.join(root, 'main.ts')));
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

function hasBody(node: Node): node is FunctionWithBody {
  return ts.isFunctionLike(node) && 'body' in node && Boolean(node.body);
}

function summaryNamed(summaries: FunctionSummaries, declaration: FunctionWithBody): FunctionSummary {
  const summary = summaries.summaryOf(declaration);
  assert.ok(summary, 'the fixture function should have a summary');
  return summary;
}

// Runs `callback(summaries, functionNamed)` on the engine the test run selected.
function withSummaries<Result>(
  source: string,
  files: FileMap,
  callback: (summaries: FunctionSummaries, functionNamed: (name: string) => FunctionWithBody) => Result,
): Result {
  const run = native ? withNativeProgram : withProgram;
  return run(source, files, (program: ProgramAdapter, sourceFile: SourceFile) => {
    const functions = new Map<string, FunctionWithBody>();
    (function visit(node: Node) {
      if (hasBody(node)) {
        const name =
          node.name && ts.isIdentifier(node.name)
            ? node.name.text
            : ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name)
              ? node.parent.name.text
              : undefined;
        if (name) functions.set(name, node);
      }
      ts.forEachChild(node, visit);
    })(sourceFile);
    const functionNamed = (name: string) => {
      const found = functions.get(name);
      assert.ok(found, `fixture function ${name}`);
      return found;
    };
    return callback(functionSummaries(program), functionNamed);
  });
}

const packages = {
  'node_modules/@prisma/client/index.d.ts': `export class PrismaClient { user: { findUnique(args: object): Promise<object | null> } }`,
  'node_modules/typeorm/index.d.ts': `export class Repository<T> { findOne(options: object): Promise<T | null>; create(entity: object): T }`,
  'node_modules/pg/index.d.ts': `export class Pool { query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }> }`,
  'node_modules/bcrypt/index.d.ts': `export function hashSync(data: string, rounds: number): string;
    export function hash(data: string, rounds: number): Promise<string>;`,
  'node_modules/axios/index.d.ts': `export interface AxiosStatic { get(url: string, config?: object): Promise<unknown> }
    declare const axios: AxiosStatic; export default axios;`,
};

const layers = {
  'repository.ts': `import { PrismaClient } from '@prisma/client';
    import { Repository } from 'typeorm';
    import { Pool } from 'pg';
    export class UserRepository {
      constructor(private prisma: PrismaClient, private users: Repository<{ id: string }>, private pool: Pool) {}
      byId(id: string) { return this.prisma.user.findUnique({ where: { id } }); }
      byEmail(email: string) { return this.users.findOne({ where: { email } }); }
      raw(id: string) { return this.pool.query('select 1 where id = $1', [id]); }
      build(id: string) { return this.users.create({ id }); }
    }`,
  'service.ts': `import { UserRepository } from './repository.js';
    export class UserService {
      constructor(private repo: UserRepository) {}
      get(id: string) { return this.repo.byId(id); }
      find(email: string) { return this.repo.byEmail(email); }
      viaPg(id: string) { return this.repo.raw(id); }
      make(id: string) { return this.repo.build(id); }
    }`,
};

test('queries are followed through injected service and repository methods to prisma, typeorm and pg', () => {
  const source = `import { UserService } from './service.js';
    import { UserRepository } from './repository.js';
    class UserController {
      constructor(private userService: UserService, private repo: UserRepository) {}
      show(id: string) { return this.userService.get(id); }
      search(email: string) { return this.userService.find(email); }
      legacy(id: string) { return this.userService.viaPg(id); }
      direct(id: string) { return this.repo.byId(id); }
      draft(id: string) { return this.userService.make(id); }
    }`;
  withSummaries(source, { ...packages, ...layers }, (summaries, functionNamed) => {
    const show = summaryNamed(summaries, functionNamed('show'));
    assert.deepEqual(
      show.queries.map(({ kind, family, label, via }) => ({ kind, family, label, via })),
      [{ kind: 'db', family: 'prisma', label: 'user.findUnique', via: ['UserService.get', 'UserRepository.byId'] }],
    );
    assert.equal(show.complete, true);
    assert.equal(summaryNamed(summaries, functionNamed('search')).queries[0].family, 'typeorm');
    assert.equal(summaryNamed(summaries, functionNamed('legacy')).queries[0].family, 'pg');
    assert.deepEqual(summaryNamed(summaries, functionNamed('direct')).queries[0].via, ['UserRepository.byId']);
    assert.deepEqual(summaryNamed(summaries, functionNamed('draft')).queries, []);
  });
});

test('redis and HTTP calls count as queries, external callees add nothing', () => {
  const source = `import axios from 'axios';
    import { helper } from 'some-package';
    async function load(url: string) { return axios.get(url); }
    async function ping() { return fetch('https://example.com/health'); }
    function wrapped(url: string) { return load(url); }
    function external(value: string) { return helper(value); }`;
  const files = {
    ...packages,
    'node_modules/some-package/index.d.ts': 'export function helper(value: string): string;',
  };
  withSummaries(source, files, (summaries, functionNamed) => {
    assert.deepEqual(
      summaryNamed(summaries, functionNamed('wrapped')).queries.map(({ kind, family, via }) => ({ kind, family, via })),
      [{ kind: 'http', family: 'axios', via: ['load'] }],
    );
    assert.equal(summaryNamed(summaries, functionNamed('ping')).queries[0].family, 'fetch');
    const external = summaryNamed(summaries, functionNamed('external'));
    assert.deepEqual([external.queries, external.blocking, external.validates], [[], [], []]);
  });
});

test('sync bcrypt, fs and crypto calls block the event loop through a helper', () => {
  const source = `import * as bcrypt from 'bcrypt';
    import { readFileSync } from 'node:fs';
    import * as crypto from 'node:crypto';
    function hashPassword(password: string) { return bcrypt.hashSync(password, 10); }
    function readConfig(file: string) { return readFileSync(file, 'utf8'); }
    function derive(password: string) { return crypto.scryptSync(password, 'salt', 64); }
    async function register(password: string, file: string) {
      hashPassword(password);
      readConfig(file);
      return derive(password);
    }
    async function asyncHash(password: string) { return bcrypt.hash(password, 10); }`;
  withSummaries(source, packages, (summaries, functionNamed) => {
    assert.deepEqual(
      summaryNamed(summaries, functionNamed('register')).blocking.map(({ kind, label, via }) => ({ kind, label, via })),
      [
        { kind: 'password-hash', label: 'hashSync', via: ['hashPassword'] },
        { kind: 'fs', label: 'fs.readFileSync', via: ['readConfig'] },
        { kind: 'crypto', label: 'crypto.scryptSync', via: ['derive'] },
      ],
    );
    assert.deepEqual(summaryNamed(summaries, functionNamed('asyncHash')).blocking, []);
  });
});

test('validators that throw, return a boolean or return the clean value', () => {
  const source = `import path from 'node:path';
    import { isValidObjectId } from 'mongoose';
    const ALLOWED = ['/home', '/account'];
    const HOSTS = ['example.com'];
    const ROOT = '/srv/uploads';
    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    function assertAllowed(next: string) { if (!ALLOWED.includes(next)) throw new Error('bad'); }
    function isAllowedHost(raw: string) { const url = new URL(raw); return HOSTS.includes(url.hostname); }
    function safeRedirect(next: string) { return ALLOWED.includes(next) ? next : '/'; }
    function insideRoot(name: string) {
      const resolved = path.resolve(ROOT, name);
      if (!resolved.startsWith(ROOT + path.sep)) throw new Error('outside');
      return resolved;
    }
    function isInside(name: string) { const resolved = path.resolve(ROOT, name); return resolved.startsWith(ROOT + path.sep); }
    function isUuid(id: string) { return UUID.test(id); }
    function assertObjectId(id: string) { if (!isValidObjectId(id)) throw new Error('bad id'); }
    function checkThroughHelper(next: string) { assertAllowed(next); return true; }
    function guardedByHelper(next: string) { if (!isAllowedHost(next)) return false; return true; }
    function notAValidator(next: string) { if (next.length > 3) return true; return false; }
    function earlyReturn(next: string) { if (!next.length) return; assertAllowed(next); }`;
  const files = { 'node_modules/mongoose/index.d.ts': 'export function isValidObjectId(value: unknown): boolean;' };
  withSummaries(source, files, (summaries, functionNamed) => {
    const validates = (name: string) => summaryNamed(summaries, functionNamed(name)).validates;
    // The security helpers behind validation run on the TypeScript engine only.
    if (native) return assert.deepEqual(validates('assertAllowed'), []);
    assert.deepEqual(validates('assertAllowed'), [
      { parameterIndex: 0, kind: 'url', mode: 'throws' },
      { parameterIndex: 0, kind: 'id', mode: 'throws' },
    ]);
    assert.deepEqual(validates('isAllowedHost'), [{ parameterIndex: 0, kind: 'url', mode: 'boolean' }]);
    assert.deepEqual(
      validates('safeRedirect').filter((validation) => validation.kind === 'url'),
      [{ parameterIndex: 0, kind: 'url', mode: 'returns' }],
    );
    assert.deepEqual(validates('insideRoot'), [{ parameterIndex: 0, kind: 'path', mode: 'returns' }]);
    assert.deepEqual(validates('isInside'), [{ parameterIndex: 0, kind: 'path', mode: 'boolean' }]);
    assert.deepEqual(validates('isUuid'), [{ parameterIndex: 0, kind: 'id', mode: 'boolean' }]);
    assert.deepEqual(validates('assertObjectId'), [{ parameterIndex: 0, kind: 'id', mode: 'throws' }]);
    assert.deepEqual(
      validates('checkThroughHelper').filter((validation) => validation.kind === 'url'),
      [{ parameterIndex: 0, kind: 'url', mode: 'throws' }],
    );
    assert.deepEqual(validates('guardedByHelper'), [{ parameterIndex: 0, kind: 'url', mode: 'boolean' }]);
    assert.deepEqual(validates('notAValidator'), []);
    assert.deepEqual(validates('earlyReturn'), []);
  });
});

test('request data returned directly, through a const and through a helper', () => {
  const source = `function readNext(req: any) { return req.query.next; }
    function aliased(request: any) { const value = request.body.url; return value; }
    function forwarded(req: any) { return readNext(req); }
    function serverData(req: any) { return req.user.id; }
    function notRequest(options: any) { return options.query.next; }`;
  withSummaries(source, {}, (summaries, functionNamed) => {
    const returned = (name: string) => summaryNamed(summaries, functionNamed(name)).returnsRequestData;
    if (native) return assert.equal(returned('readNext'), undefined);
    assert.deepEqual(returned('readNext'), { parameterIndex: 0, path: 'query.next' });
    assert.deepEqual(returned('aliased'), { parameterIndex: 0, path: 'body.url' });
    assert.deepEqual(returned('forwarded'), { parameterIndex: 0, path: 'query.next' });
    assert.equal(returned('serverData'), undefined);
    assert.equal(returned('notRequest'), undefined);
  });
});

test('recursion terminates and summaries are memoised per program', () => {
  const source = `import { PrismaClient } from '@prisma/client';
    declare const prisma: PrismaClient;
    function walk(depth: number): unknown { if (depth > 0) return walk(depth - 1); return prisma.user.findUnique({}); }
    function ping(value: string): boolean { return pong(value); }
    function pong(value: string): boolean { return ping(value); }`;
  withSummaries(source, packages, (summaries, functionNamed) => {
    const walk = summaryNamed(summaries, functionNamed('walk'));
    assert.equal(walk.queries.length, 1);
    assert.deepEqual(summaryNamed(summaries, functionNamed('ping')).validates, []);
    assert.equal(summaryNamed(summaries, functionNamed('pong')).returnsRequestData, undefined);
    assert.equal(summaries.summaryOf(functionNamed('walk')), walk);
    assert.equal(walk.queries, walk.queries);
  });
});
