'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { lint } = require('./helpers.cjs');

test('context requires bounded seed data, timed polling or an actual benchmark entry', () => {
  const { withProgram } = require('./helpers.cjs');
  const { analyzeFile } = require('../lib/analyze.cjs');
  const fixtures = {
    'node_modules/typeorm/index.d.ts': 'export class Repository<T> { findBy(where: object): Promise<T[]>; }',
    'models.ts': 'export const catalogue = [{id:1},{id:2}];',
    'seeds/setup.ts': `import {Repository} from 'typeorm'; import {catalogue} from '../models';
       declare const repo: Repository<object>, input: {id:number}[];
       async function load() {
         for (const record of catalogue) await repo.findBy({id:record.id});
         for (const record of input) await repo.findBy({id:record.id});
       }`,
    'service.spec.ts': `async function check(keys: number[], id: number) {
       for(let index=0;index<30;index++){if(keys.includes(id))return;await new Promise((done)=>setTimeout(done,500));}
       for(let index=0;index<30;index++){if(keys.includes(id))return;}
     }`,
    'model-benchmark.ts': `declare const keys:number[], list:number[];
       function benchmark() { const filtered=list.filter(id=>keys.includes(id)); process.exit(0); }
       void benchmark();
       export function runtime() { return list.filter(id=>keys.includes(id)); }`,
  };
  withProgram('', fixtures, (program) => {
    for (const [filename, expected] of [
      ['seeds/setup.ts', [true, false]],
      // A test source is contextual either way; only the timed poll has its own reason.
      ['service.spec.ts', [true, true]],
      ['model-benchmark.ts', [true, false]],
    ]) {
      const file = program
        .getSourceFiles()
        .find((item) => item.fileName.replaceAll('\\', '/').endsWith('/' + filename));
      assert.deepEqual(
        analyzeFile(program, file).map((finding) => Boolean(finding.contextualReason)),
        expected,
        filename,
      );
    }
    const spec = program.getSourceFiles().find((item) => item.fileName.endsWith('service.spec.ts'));
    assert.match(analyzeFile(program, spec)[0].contextualReason, /polls with a timer/);
    assert.doesNotMatch(analyzeFile(program, spec)[1].contextualReason, /polls with a timer/);
  });
});

test('a review applies to one advisory rule on the next physical line', () => {
  const source = [
    "import { readFileSync as read } from 'node:fs';",
    'export async function handle() {',
    '  // backend-perf-reviewed node-sync-fs-in-async -- Offline snapshot written once.',
    '  read("one");',
    '  read("two");',
    '  // backend-perf-reviewed unrelated-rule -- Other review.',
    '  read("three");',
    '  // backend-perf-reviewed node-sync-fs-in-async',
    '  read("four");',
    '  /*',
    '  // backend-perf-reviewed node-sync-fs-in-async -- Inside a block comment.',
    '  */ read("five");',
    '  const text = `',
    '  // backend-perf-reviewed node-sync-fs-in-async -- Inside a template.',
    '  ${read("six")}`;',
    '}',
  ].join('\r\n');
  const findings = lint(source);
  assert.deepEqual(
    findings.map(({ line, contextualReason }) => [line, contextualReason]),
    [
      [4, 'Reviewed in source: Offline snapshot written once.'],
      [5, undefined],
      [7, undefined],
      [9, undefined],
      [12, undefined],
      [15, undefined],
    ],
  );
});

const contextHelpers = require('./helpers.cjs');
const pgDeclaration = `export class Pool { query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }> }`;
const prismaFiles = {
  'node_modules/@prisma/client/index.d.ts': "export * from '.prisma/client';",
  'node_modules/.prisma/client/index.d.ts':
    'export interface UserDelegate { findMany(options?: object): Promise<{ id: number }[]> }\n' +
    'export declare class PrismaClient { user: UserDelegate }',
};
const perItemSource = `import { Pool } from 'pg';
  declare const pool: Pool; declare const ids: number[], column: string;
  export async function load() {
    for (const id of ids) await pool.query('SELECT 1 WHERE id = $1', [id]);
    await pool.query('SELECT ' + column + ' FROM t');
  }`;

function contextualReasons(fileName, source, files, ruleIds) {
  const { analyzeFile } = require('../lib/analyze.cjs');
  const path = require('node:path');
  return contextHelpers.withProgram('export {};', { [fileName]: source, ...files }, (program) =>
    analyzeFile(program, program.getSourceFile(path.join(__dirname, 'virtual-project', fileName)))
      .filter((finding) => ruleIds.includes(finding.ruleId))
      .map((finding) => [finding.ruleId, Boolean(finding.contextualReason)]),
  );
}

test('per-item query and dynamic SQL findings are contextual in tests, seeds and benchmarks only', () => {
  const files = { 'node_modules/pg/index.d.ts': pgDeclaration };
  const rules = ['pg-query-in-loop', 'pg-dynamic-query-text'];
  for (const [fileName, contextual] of [
    ['service.ts', false],
    ['src/testing/service.ts', false],
    ['tests/helpers/db.ts', true],
    ['__tests__/db.ts', true],
    ['users.spec.ts', true],
    ['seeder/users.ts', true],
    ['db/rich-data/users.ts', true],
    ['users.seed.ts', true],
    ['bench/users.ts', true],
    ['users.benchmark.ts', true],
  ]) {
    assert.deepEqual(
      contextualReasons(fileName, perItemSource, files, rules),
      rules.map((ruleId) => [ruleId, contextual]),
      fileName,
    );
  }
});

test('Prisma per-item queries are contextual in seed sources', () => {
  const source = `import { PrismaClient } from '@prisma/client';
    declare const prisma: PrismaClient, ids: number[];
    export async function seed() { for (const id of ids) await prisma.user.findMany({ where: { id } }); }`;
  const files = prismaFiles;
  assert.deepEqual(contextualReasons('seeder/run.ts', source, files, ['prisma-query-in-loop']), [
    ['prisma-query-in-loop', true],
  ]);
  assert.deepEqual(contextualReasons('service.ts', source, files, ['prisma-query-in-loop']), [
    ['prisma-query-in-loop', false],
  ]);
});

test('seed and test helper files make blocking calls contextual even inside a loop', () => {
  const source = `import { readFileSync } from 'node:fs';
    export async function load(names: string[]) { for (const name of names) readFileSync(name); }`;
  assert.deepEqual(contextualReasons('service.ts', source, {}, ['node-sync-fs-in-async']), [
    ['node-sync-fs-in-async', false],
  ]);
  for (const fileName of ['rich-account.seed.ts', 'seeder/users.ts', 'tests/helpers/load.ts']) {
    assert.deepEqual(
      contextualReasons(fileName, source, {}, ['node-sync-fs-in-async']),
      [['node-sync-fs-in-async', true]],
      fileName,
    );
  }
});

test('a project that itself lives under a test directory keeps its sources visible', (context) => {
  const fs = require('node:fs');
  const path = require('node:path');
  const base = process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, 'Temp', 'AI-Work')
    : require('node:os').tmpdir();
  fs.mkdirSync(base, { recursive: true });
  const directory = fs.mkdtempSync(path.join(base, 'backend-perf-review-'));
  const checkout = path.join(directory, 'tests', 'checkout');
  fs.mkdirSync(path.join(checkout, 'src'), { recursive: true });
  const manifest = path.join(checkout, 'package.json');
  fs.writeFileSync(manifest, '{}');
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const { repeatedReviewContext } = require('../lib/review-context.cjs');
  const ts = require('../lib/compiler.cjs').syntax;
  const reason = (file) => {
    const source = ts.createSourceFile(file, 'hashSync();', ts.ScriptTarget.Latest, true);
    return repeatedReviewContext(source, 'node-sync-fs-in-async', undefined, source);
  };
  assert.equal(reason(path.join(checkout, 'src', 'service.ts')), undefined);
  assert.ok(reason(path.join(checkout, 'test', 'helper.ts')));
});
