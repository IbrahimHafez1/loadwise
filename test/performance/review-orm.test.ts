import assert from 'node:assert/strict';
import test from 'node:test';
import ts from 'typescript';
import { withProgram } from './helpers.js';
import { checkRedisCall } from '../../lib/performance/redis.js';
import { isRepeated } from '../../lib/performance/repeated.js';
import type { Node, SourceFile } from 'typescript';
import type { PerformanceRuleContext, ProgramAdapter } from '../../lib/shared/types.js';

const CALLS_IN_LOOP = 4000;
// Quadratic rescans of the loop body took over 10 s for this input; linear takes well under 1 s.
const TIME_BUDGET_MS = 4000;

test('many get calls in one loop do not rescan the loop body for each call', () => {
  const calls = Array.from({ length: CALLS_IN_LOOP }, (_, index) => `  cache.get(ids[${index}]);`).join('\n');
  const source = `const cache = new Map<string, string>();\nfunction run(ids: string[]) { for (const id of ids) {\n${calls}\n} }`;
  withProgram(source, {}, (program: ProgramAdapter, sourceFile: SourceFile) => {
    const checker = program.getTypeChecker();
    const context: PerformanceRuleContext = {
      checker,
      program,
      strictNullChecks: true,
      verbatimModuleSyntax: false,
      fireAndForgetNames: new Set(),
      isPackageType: () => false,
      isRepeated: (node: Node) => isRepeated(node, checker),
      report() {},
    };
    const start = performance.now();
    (function visit(node: Node): void {
      if (ts.isCallExpression(node)) checkRedisCall(node, context);
      ts.forEachChild(node, visit);
    })(sourceFile);
    assert.ok(performance.now() - start < TIME_BUDGET_MS);
  });
});

import { checkPostgresCall } from '../../lib/performance/postgres.js';

const PG_QUERIES_IN_LOOP = 3000;
// Rescanning the loop body for each query took over 30 s for this input; one scan per loop takes
// 4-6 s on a loaded Windows machine, so the budget sits well between the two.
const PG_TIME_BUDGET_MS = 15000;

test('many pg queries in one loop do not rescan the loop body for each query', () => {
  const pgTypes = `interface PgResult { rows: { id: number }[] }
export class Pool { query(input: string, values?: unknown[]): Promise<PgResult>; }`;
  const queries = Array.from(
    { length: PG_QUERIES_IN_LOOP },
    (_, index) => `  await pool.query(sql${index % 10}, [id]);`,
  ).join('\n');
  const source = `import { Pool } from 'pg';\nconst pool = new Pool();\ndeclare const sql0: string, sql1: string, sql2: string, sql3: string, sql4: string, sql5: string, sql6: string, sql7: string, sql8: string, sql9: string;\nasync function run(ids: number[]) { for (const id of ids) {\n${queries}\n} }`;
  withProgram(
    source,
    { 'node_modules/@types/pg/index.d.ts': pgTypes },
    (program: ProgramAdapter, sourceFile: SourceFile) => {
      const checker = program.getTypeChecker();
      let reported = 0;
      const context: PerformanceRuleContext = {
        checker,
        program,
        strictNullChecks: true,
        verbatimModuleSyntax: false,
        fireAndForgetNames: new Set(),
        isRepeated: (node: Node) => isRepeated(node, checker),
        isPackageType: () => true,
        report() {
          reported++;
        },
      };
      const start = performance.now();
      (function visit(node: Node): void {
        if (ts.isCallExpression(node)) checkPostgresCall(node, context);
        ts.forEachChild(node, visit);
      })(sourceFile);
      assert.ok(performance.now() - start < PG_TIME_BUDGET_MS);
      assert.equal(reported, PG_QUERIES_IN_LOOP);
    },
  );
});

import * as findThenCreate from '../../lib/performance/find-then-create.js';

const CREATES_IN_FUNCTION = 8000;
// Rescanning the function text for each create took about 8 s for this input; one scan per function
// takes well under 1 s.
const CREATE_TIME_BUDGET_MS = 2000;

test('many creates in one function do not rescan the function text for each create', () => {
  const prismaClient = `export interface UserDelegate { findFirst(args?: object): Promise<any>; create(args: object): Promise<any>; }
export declare class PrismaClient { user: UserDelegate; }`;
  const creates = Array.from(
    { length: CREATES_IN_FUNCTION },
    (_, index) => `  await prisma.user.create({ data: { email: 'user${index}@example.com', role: 'CUSTOMER' } });`,
  ).join('\n');
  const source = `import { PrismaClient } from '@prisma/client';\ndeclare const prisma: PrismaClient;\nexport async function seed() {\n${creates}\n}`;
  withProgram(
    source,
    { 'node_modules/@prisma/client/index.d.ts': prismaClient },
    (program: ProgramAdapter, sourceFile: SourceFile) => {
      const context: PerformanceRuleContext = {
        checker: program.getTypeChecker(),
        program,
        strictNullChecks: true,
        verbatimModuleSyntax: false,
        fireAndForgetNames: new Set(),
        isPackageType: () => false,
        isRepeated: () => false,
        report() {},
      };
      const start = performance.now();
      (function visit(node: Node): void {
        if (ts.isCallExpression(node)) findThenCreate.check(node, context);
        ts.forEachChild(node, visit);
      })(sourceFile);
      assert.ok(performance.now() - start < CREATE_TIME_BUDGET_MS);
    },
  );
});
