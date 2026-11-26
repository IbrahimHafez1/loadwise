import assert from 'node:assert/strict';
import { test } from 'node:test';
import ts from 'typescript';
import { withProgram } from './helpers.js';
import { collectPhase5PerfFindings } from '../../lib/performance/phase5-rules.js';
import { typeFromPackage } from '../../lib/performance/package-types.js';
import type { Node, SourceFile } from 'typescript';
import type { Finding, PerformanceRuleContext, ProgramAdapter } from '../../lib/shared/types.js';
import type { FileMap } from '../types/project-files.js';

function runPhase5(sourceFile: SourceFile, program: ProgramAdapter): Finding[] {
  const checker = program.getTypeChecker();
  const found: Finding[] = [];
  const context: PerformanceRuleContext = {
    checker,
    program,
    strictNullChecks: true,
    verbatimModuleSyntax: false,
    fireAndForgetNames: new Set(),
    isRepeated: () => false,
    isPackageType: (node: Node, packages: readonly string[], typeNames?: readonly string[]) =>
      typeFromPackage(checker.getTypeAtLocation(node), packages, typeNames),
    report(node: Node, ruleId: string, message: string, contextualReason?: string) {
      const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      found.push({
        file: sourceFile.fileName,
        line: line + 1,
        column: character + 1,
        ruleId,
        message,
        contextualReason,
      });
    },
  };
  collectPhase5PerfFindings(sourceFile, context);
  return found;
}

function findingsFor(source: string, ruleId: string, files: FileMap = {}, fileName = 'main.ts'): Finding[] {
  const isTsx = fileName.endsWith('.tsx');
  const allFiles: FileMap = fileName === 'main.ts' ? files : { ...files, [fileName]: source };
  const mainSource = fileName === 'main.ts' ? source : '';
  return withProgram(
    mainSource,
    allFiles,
    (program: ProgramAdapter, mainFile: SourceFile) => {
      const target =
        fileName === 'main.ts' ? mainFile : program.getSourceFiles?.().find((sf) => sf.fileName.endsWith(fileName));
      assert.ok(target, `Expected source file ${fileName}`);
      return runPhase5(target, program).filter((f) => f.ruleId === ruleId);
    },
    isTsx ? { jsx: ts.JsxEmit.ReactJSX } : {},
  );
}

const mongooseStub: FileMap = {
  'node_modules/mongoose/index.d.ts': `
    export interface Query<T> {
      lean(): Promise<T>;
      select(fields: string): Query<T>;
      sort(arg: unknown): Query<T>;
      limit(n: number): Query<T>;
      exec(): Promise<T>;
    }
    export interface Doc {
      name: string;
      save(): Promise<this>;
      markModified(path: string): void;
    }
    export interface Model<T> {
      find(filter?: unknown): Query<T[]>;
      findOne(filter?: unknown): Query<T | null>;
      findById(id: unknown): Query<T | null>;
    }
  `,
};

// --- 1. unbounded-promise-all --------------------------------------------------------------------

test('unbounded-promise-all flags Promise.all over mapped array or dynamic iterable', () => {
  const mapped = `async function loadAll(req: { body: { ids: string[] } }, fetchUser: (id: string) => Promise<unknown>) {
    return Promise.all(req.body.ids.map((id) => fetchUser(id)));
  }`;
  assert.equal(findingsFor(mapped, 'unbounded-promise-all').length, 1);

  const dynamicList = `async function run(tasks: Promise<unknown>[]) {
    return Promise.all(tasks);
  }`;
  assert.equal(findingsFor(dynamicList, 'unbounded-promise-all').length, 1);
});

test('unbounded-promise-all stays quiet for small array literals, p-limit, and chunking loops', () => {
  const smallLiteral = `async function loadPair(a: () => Promise<number>, b: () => Promise<string>) {
    return Promise.all([a(), b()]);
  }`;
  assert.equal(findingsFor(smallLiteral, 'unbounded-promise-all').length, 0);

  const withPLimit = `import pLimit from 'p-limit';
  const limit = pLimit(5);
  async function loadAll(ids: string[], fetchUser: (id: string) => Promise<unknown>) {
    return Promise.all(ids.map((id) => limit(() => fetchUser(id))));
  }`;
  assert.equal(findingsFor(withPLimit, 'unbounded-promise-all').length, 0);

  const chunked = `async function loadChunked(ids: string[], fetchUser: (id: string) => Promise<unknown>) {
    for (let i = 0; i < ids.length; i += 10) {
      await Promise.all(ids.slice(i, i + 10).map((id) => fetchUser(id)));
    }
  }`;
  assert.equal(findingsFor(chunked, 'unbounded-promise-all').length, 0);
});

// --- 2. mongoose-missing-lean --------------------------------------------------------------------

test('mongoose-missing-lean flags read queries returned or serialized without .lean()', () => {
  const directReturn = `import type { Model, Doc } from 'mongoose';
  declare const User: Model<Doc>;
  export async function listUsers() {
    return await User.find({ active: true }).select('name');
  }`;
  assert.equal(findingsFor(directReturn, 'mongoose-missing-lean', mongooseStub).length, 1);

  const serialized = `import type { Model, Doc } from 'mongoose';
  declare const User: Model<Doc>;
  export async function getUser(req: { params: { id: string } }, res: { json: (v: unknown) => void }) {
    const user = await User.findById(req.params.id);
    res.json(user);
  }`;
  assert.equal(findingsFor(serialized, 'mongoose-missing-lean', mongooseStub).length, 1);
});

test('mongoose-missing-lean stays quiet with .lean(), document mutation, or Array.find', () => {
  const withLean = `import type { Model, Doc } from 'mongoose';
  declare const User: Model<Doc>;
  export async function listUsers() {
    return await User.find({ active: true }).lean();
  }`;
  assert.equal(findingsFor(withLean, 'mongoose-missing-lean', mongooseStub).length, 0);

  const withSave = `import type { Model, Doc } from 'mongoose';
  declare const User: Model<Doc>;
  export async function updateUser(id: string) {
    const user = await User.findOne({ _id: id });
    if (user) {
      user.name = 'updated';
      await user.save();
    }
    return user;
  }`;
  assert.equal(findingsFor(withSave, 'mongoose-missing-lean', mongooseStub).length, 0);

  const arrayFind = `export function pick(items: { id: string }[], id: string) {
    return items.find((item) => item.id === id);
  }`;
  assert.equal(findingsFor(arrayFind, 'mongoose-missing-lean').length, 0);
});

// --- 3. graphql-n-plus-one-resolver --------------------------------------------------------------

test('graphql-n-plus-one-resolver flags @ResolveField and resolver map field queries without DataLoader', () => {
  const nestResolver = `function ResolveField() { return (_t: unknown, _k: string, _d: PropertyDescriptor) => {}; }
  function Parent() { return (_t: unknown, _k: string, _i: number) => {}; }
  class UserResolver {
    constructor(private prisma: { post: { findMany: (q: unknown) => Promise<unknown[]> } }) {}
    @ResolveField()
    async posts(@Parent() user: { id: string }) {
      return this.prisma.post.findMany({ where: { userId: user.id } });
    }
  }`;
  assert.equal(findingsFor(nestResolver, 'graphql-n-plus-one-resolver').length, 1);

  const mapResolver = `export const resolvers = {
    Post: {
      author: async (post: { authorId: string }, _args: unknown, ctx: { db: { user: { findUnique: (q: unknown) => Promise<unknown> } } }) => {
        return ctx.db.user.findUnique({ where: { id: post.authorId } });
      },
    },
  };`;
  assert.equal(findingsFor(mapResolver, 'graphql-n-plus-one-resolver').length, 1);
});

test('graphql-n-plus-one-resolver stays quiet with DataLoader .load() or root Query resolvers', () => {
  const withDataLoader = `function ResolveField() { return (_t: unknown, _k: string, _d: PropertyDescriptor) => {}; }
  class UserResolver {
    constructor(private postsLoader: { load: (id: string) => Promise<unknown[]> }) {}
    @ResolveField()
    async posts(user: { id: string }) {
      return this.postsLoader.load(user.id);
    }
  }`;
  assert.equal(findingsFor(withDataLoader, 'graphql-n-plus-one-resolver').length, 0);

  const rootQuery = `export const resolvers = {
    Query: {
      users: async (_parent: unknown, _args: unknown, ctx: { db: { user: { findMany: () => Promise<unknown[]> } } }) => {
        return ctx.db.user.findMany();
      },
    },
  };`;
  assert.equal(findingsFor(rootQuery, 'graphql-n-plus-one-resolver').length, 0);
});

// --- 4. react-context-value-recreated ------------------------------------------------------------

test('react-context-value-recreated flags inline object and array literals in Provider value', () => {
  const tsxObj = `declare const AuthContext: { Provider: (props: { value: unknown; children?: unknown }) => unknown };
  export function App({ user, logout }: { user: unknown; logout: () => void }) {
    return <AuthContext.Provider value={{ user, logout }}>hi</AuthContext.Provider>;
  }`;
  assert.equal(findingsFor(tsxObj, 'react-context-value-recreated', {}, 'app.tsx').length, 1);

  const tsxArr = `declare const ThemeContext: { Provider: (props: { value: unknown; children?: unknown }) => unknown };
  export function App({ theme, setTheme }: { theme: string; setTheme: (t: string) => void }) {
    return <ThemeContext.Provider value={[theme, setTheme]}>hi</ThemeContext.Provider>;
  }`;
  assert.equal(findingsFor(tsxArr, 'react-context-value-recreated', {}, 'app.tsx').length, 1);
});

test('react-context-value-recreated stays quiet when value is memoized', () => {
  const memoized = `declare function useMemo<T>(fn: () => T, deps: unknown[]): T;
  declare const AuthContext: { Provider: (props: { value: unknown; children?: unknown }) => unknown };
  export function App({ user, logout }: { user: unknown; logout: () => void }) {
    const value = useMemo(() => ({ user, logout }), [user, logout]);
    return <AuthContext.Provider value={value}>hi</AuthContext.Provider>;
  }`;
  assert.equal(findingsFor(memoized, 'react-context-value-recreated', {}, 'app.tsx').length, 0);
});

// --- 5. node-event-listener-leak -----------------------------------------------------------------

test('node-event-listener-leak flags uncleaned listeners in handlers, loops, and hooks', () => {
  const inHandler = `declare const eventBus: { on: (ev: string, fn: () => void) => void };
  export function handler(req: unknown, res: { write: (s: string) => void }) {
    eventBus.on('tick', () => res.write('tick'));
  }`;
  assert.equal(findingsFor(inHandler, 'node-event-listener-leak').length, 1);

  const inLoop = `declare const emitter: { addListener: (ev: string, fn: () => void) => void };
  export function attach(items: string[], fn: () => void) {
    for (const item of items) {
      emitter.addListener(item, fn);
    }
  }`;
  assert.equal(findingsFor(inLoop, 'node-event-listener-leak').length, 1);

  const inHook = `declare function useEffect(fn: () => void, deps: unknown[]): void;
  declare const window: { addEventListener: (ev: string, fn: () => void) => void };
  export function Comp(onResize: () => void) {
    useEffect(() => {
      window.addEventListener('resize', onResize);
    }, []);
  }`;
  assert.equal(findingsFor(inHook, 'node-event-listener-leak').length, 1);

  const underscoreRoute = `declare const app: { get: (p: string, fn: (req: unknown, res: { write: (s: string) => void }) => void) => void };
  declare const eventBus: { on: (ev: string, fn: () => void) => void };
  app.get('/events', (_req, res) => {
    eventBus.on('update', () => res.write('ok'));
  });`;
  assert.equal(findingsFor(underscoreRoute, 'node-event-listener-leak').length, 1);
});

test('node-event-listener-leak stays quiet for req/res listeners, cleanup, or { once: true }', () => {
  const reqScoped = `export function handler(req: { on: (ev: string, fn: (c: unknown) => void) => void }, res: unknown) {
    req.on('data', () => {});
  }`;
  assert.equal(findingsFor(reqScoped, 'node-event-listener-leak').length, 0);

  const underscoreReqScoped = `export function handler(_req: { on: (ev: string, fn: () => void) => void }, _res: unknown) {
    _req.on('close', () => {});
  }`;
  assert.equal(findingsFor(underscoreReqScoped, 'node-event-listener-leak').length, 0);

  const withCleanup = `declare function useEffect(fn: () => () => void, deps: unknown[]): void;
  declare const window: {
    addEventListener: (ev: string, fn: () => void) => void;
    removeEventListener: (ev: string, fn: () => void) => void;
  };
  export function Comp(onResize: () => void) {
    useEffect(() => {
      window.addEventListener('resize', onResize);
      return () => window.removeEventListener('resize', onResize);
    }, []);
  }`;
  assert.equal(findingsFor(withCleanup, 'node-event-listener-leak').length, 0);

  const withOnce = `declare function useEffect(fn: () => void, deps: unknown[]): void;
  declare const window: { addEventListener: (ev: string, fn: () => void, opts?: { once?: boolean }) => void };
  export function Comp(onResize: () => void) {
    useEffect(() => {
      window.addEventListener('resize', onResize, { once: true });
    }, []);
  }`;
  assert.equal(findingsFor(withOnce, 'node-event-listener-leak').length, 0);
});

// --- 6. json-stringify-in-loop -------------------------------------------------------------------

test('json-stringify-in-loop flags JSON.stringify inside statement and array loops', () => {
  const forLoop = `export function logAll(items: unknown[], log: (s: string) => void) {
    for (const item of items) {
      log(JSON.stringify(item));
    }
  }`;
  assert.equal(findingsFor(forLoop, 'json-stringify-in-loop').length, 1);

  const mapLoop = `export function serializeAll(items: unknown[]) {
    return items.map((item) => JSON.stringify(item));
  }`;
  assert.equal(findingsFor(mapLoop, 'json-stringify-in-loop').length, 1);
});

test('json-stringify-in-loop stays quiet outside loops and in test files', () => {
  const outsideLoop = `export function serializeOnce(items: unknown[]) {
    return JSON.stringify(items);
  }`;
  assert.equal(findingsFor(outsideLoop, 'json-stringify-in-loop').length, 0);

  const inTestFile = `export function logAll(items: unknown[]) {
    return items.map((item) => JSON.stringify(item));
  }`;
  assert.equal(findingsFor(inTestFile, 'json-stringify-in-loop', {}, 'sample.test.ts').length, 0);
});
