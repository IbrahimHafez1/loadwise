import assert from 'node:assert/strict';
import test from 'node:test';
import { createRuleContext, lint, withProgram } from './helpers.cjs';
import type { CallExpression, Node, SourceFile } from 'typescript';
import type { Finding, PerformanceRuleContext, ProgramAdapter } from '../../lib/shared/types.cjs';
import type { FileMap } from '../types/project-files.cjs';
import type * as Typescript from 'typescript';
import type * as Compiler from '../../lib/performance/compiler.cjs';
import type * as Analyze from '../../lib/performance/analyze.cjs';

const files: FileMap = {
  'node_modules/typeorm/index.d.ts':
    'export class Repository<T> { findOne(options: object): Promise<T | null>; findOneBy(where: object): Promise<T | null>; }',
};
const header = `import { Repository } from 'typeorm';
declare const repo: Repository<{ id: number }>;
declare const ids: number[];
declare const kind: number;
`;

function reportedLines(body: string) {
  const headerLines = header.split('\n').length - 1;
  return lint(header + body, files)
    .filter((finding: Finding) => finding.ruleId === 'orm-query-in-loop')
    .map((finding: Finding) => Number(finding.line) - headerLines);
}

test('a break that leaves a one-item inner loop does not end the outer loop', () => {
  assert.deepEqual(
    reportedLines(`async function load() {
  for (const id of ids) {
    for (const key of [id]) {
      await repo.findOneBy({ id: key });
      break;
    }
  }
}`),
    [4],
  );
});

test('a labelled break that leaves only a one-item inner loop does not end the outer loop', () => {
  assert.deepEqual(
    reportedLines(`async function load() {
  for (const id of ids) {
    inner: for (const key of [id]) {
      await repo.findOneBy({ id: key });
      break inner;
    }
  }
}`),
    [4],
  );
});

test('a break that leaves a switch inside the loop does not end the loop', () => {
  assert.deepEqual(
    reportedLines(`async function load() {
  for (const id of ids) {
    for (const key of [id]) {
      switch (kind) {
        case 1: {
          await repo.findOneBy({ id: key });
          break;
        }
      }
    }
  }
}`),
    [6],
  );
});

test('a break or labelled break out of the scanned loop right after the query stays quiet', () => {
  assert.deepEqual(
    reportedLines(`async function first() {
  for (const id of ids) {
    await repo.findOneBy({ id });
    break;
  }
}
async function firstLabelled() {
  outer: for (const id of ids) {
    for (const key of [id]) {
      await repo.findOneBy({ id: key });
      break outer;
    }
  }
}`),
    [],
  );
});

const pgFiles: FileMap = {
  'node_modules/pg/package.json': '{ "name": "pg", "types": "index.d.ts" }',
  'node_modules/pg/index.d.ts':
    'export declare class Pool { query(text: string, values?: unknown[]): Promise<unknown>; }',
};

// Counts the child walks the whole analysis makes, through private copies of the rules that see a
// counting compiler; unlike a stopwatch this does not depend on how busy the machine is.
function childWalks(source: string, files: FileMap): number {
  const ts: typeof Typescript = require('typescript');
  const { requireWithSyntax }: typeof Compiler = require('../../lib/performance/compiler.cjs');
  let walks = 0;
  const countingSyntax: typeof ts = Object.create(ts, {
    forEachChild: {
      value(...args: Parameters<typeof ts.forEachChild>) {
        walks++;
        return ts.forEachChild(...args);
      },
    },
  });
  const { analyzeFile } = requireWithSyntax<typeof Analyze>(
    require.resolve('../../lib/performance/analyze.cjs'),
    countingSyntax,
  );
  withProgram(source, files, (program: ProgramAdapter, sourceFile: SourceFile) => analyzeFile(program, sourceFile));
  return walks;
}

function countedLoop(queryCount: number): string {
  const queries = Array.from(
    { length: queryCount },
    (_, index) => `    const row${index} = await pool.query('UPDATE t SET a = $1 WHERE id = $2', [item, i]);`,
  );
  return `import { Pool } from 'pg';
declare const pool: Pool;
export async function run(items: number[]) {
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
${queries.join('\n')}
  }
  while (items.length) {
    const item = items.pop();
${queries.join('\n')}
  }
}
`;
}

// The walk count is engine independent, and the counting copies run on the JS compiler.
test(
  'many queries in one loop body do not rescan the body once per query',
  { skip: process.env.PERF_CHECK_TEST_NATIVE === '1' },
  () => {
    const small = childWalks(countedLoop(200), pgFiles);
    const large = childWalks(countedLoop(800), pgFiles);
    // Four times the queries is about four times the linear work; a per-query rescan of the body
    // grows with the square.
    assert.ok(large / small < 6, `analysis grew ${(large / small).toFixed(1)}x`);
  },
);

interface CallRuleModule {
  check(node: CallExpression, context: PerformanceRuleContext): void;
}

// Runs one call rule over every call in the file and counts the checker requests it makes; on the
// native engine each request is a synchronous round trip.
function checkerRequests(rulePath: string, source: string, files: FileMap = {}): number {
  const ts: typeof Typescript = require('typescript');
  const { check }: CallRuleModule = require(rulePath);
  return withProgram(source, files, (program: ProgramAdapter, sourceFile: SourceFile) => {
    const checker = program.getTypeChecker();
    let requests = 0;
    const countingChecker = new Proxy(checker, {
      get(target, name) {
        const value: unknown = Reflect.get(target, name);
        if (typeof value !== 'function') return value;
        return (...args: unknown[]) => {
          requests++;
          return value.apply(target, args);
        };
      },
    });
    const context = createRuleContext(program, { checker: countingChecker });
    (function visit(node: Node): void {
      if (ts.isCallExpression(node)) check(node, context);
      ts.forEachChild(node, visit);
    })(sourceFile);
    return requests;
  });
}

test('a program without bcryptjs never resolves call signatures for the hashing rule', () => {
  assert.equal(
    checkerRequests(
      '../../lib/performance/pure-js-hashing.cjs',
      `declare function hash(value: string, rounds: number): Promise<string>;
export async function save(value: string) {
  return hash(value, 10);
}`,
    ),
    0,
  );
});

test('a per-item call to a project helper that does no database work skips the loop and argument checks', () => {
  const requests = checkerRequests(
    '../../lib/performance/service-loops.cjs',
    `function label(values: string[]) {
  return values.join(',');
}
export function run(groups: string[][]) {
  for (const group of groups) label(group);
}`,
  );
  // Resolving `label(group)` and the one call inside its body; no type requests for the loop or the
  // argument.
  assert.ok(requests <= 2, `${requests} checker requests`);
});
