'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { lint } = require('./helpers.cjs');

test('context requires bounded seed data, timed polling or an actual benchmark entry', () => {
  const { withProgram } = require('./helpers.cjs');
  const { analyzeFile } = require('../../lib/performance/analyze.cjs');
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
    'model-benchmark.ts': `declare const input:string, list:number[]; const keys:number[]=JSON.parse(input);
       function benchmark() { const filtered=list.filter(id=>keys.includes(id)); process.exit(0); }
       void benchmark();
       export function runtime() { return list.filter(id=>keys.includes(id)); }`,
  };
  withProgram('', fixtures, (program) => {
    for (const [filename, expected] of [
      // A seed is contextual either way; only the small literal catalogue has its own reason.
      ['seeds/setup.ts', [true, true]],
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

test('the loadwise-reviewed directive and the old warden-reviewed and backend-perf-reviewed ones all apply', () => {
  const source = [
    "import { readFileSync as read } from 'node:fs';",
    'export async function handle() {',
    '  // loadwise-reviewed node-sync-fs-in-async -- New directive name.',
    '  read("one");',
    '  // warden-reviewed node-sync-fs-in-async -- Previous directive name.',
    '  read("three");',
    '  // backend-perf-reviewed node-sync-fs-in-async -- Old directive name.',
    '  read("two");',
    '}',
  ].join('\n');
  assert.deepEqual(
    lint(source).map(({ line, contextualReason }) => [line, contextualReason]),
    [
      [4, 'Reviewed in source: New directive name.'],
      [6, 'Reviewed in source: Previous directive name.'],
      [8, 'Reviewed in source: Old directive name.'],
    ],
  );
});

test('a source review cannot lower a transaction contract', () => {
  const findings = lint(
    [
      "import { Pool } from 'pg';",
      'const pool = new Pool();',
      '// backend-perf-reviewed pg-transaction-on-pool -- This annotation cannot waive the contract.',
      "pool.query('BEGIN');",
    ].join('\n'),
    { 'node_modules/pg/index.d.ts': 'export class Pool { query(text: string): Promise<unknown> }' },
  );
  assert.deepEqual(
    findings.map(({ ruleId, contextualReason }) => [ruleId, contextualReason]),
    [['pg-transaction-on-pool', undefined]],
  );
});

test('only test write advisories receive an automatic test-path context', () => {
  const { testWriteContext } = require('../../lib/performance/review-context.cjs');
  for (const file of [
    'service.spec.ts',
    'src/model.test.mts',
    'test/integration/setup.ts',
    'src\\__tests__\\setup.js',
  ]) {
    assert.ok(testWriteContext(file, 'prisma-dependent-writes'));
    assert.ok(testWriteContext(file, 'drizzle-unfiltered-write'));
    assert.equal(testWriteContext(file, 'pg-transaction-on-pool'), undefined);
  }
  for (const file of ['src/contest/setup.ts', 'src/testing-service.ts', 'src/testimonials.js']) {
    assert.equal(testWriteContext(file, 'drizzle-unfiltered-write'), undefined);
  }
});

test('test-directory context is relative to the owning package, independently of invocation directory', (context) => {
  const fs = require('node:fs');
  const path = require('node:path');
  const base = process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, 'Temp', 'AI-Work')
    : require('node:os').tmpdir();
  fs.mkdirSync(base, { recursive: true });
  const directory = fs.mkdtempSync(path.join(base, 'backend-perf-review-'));
  const testParent = path.join(directory, 'tests');
  const checkout = path.join(testParent, 'checkout');
  fs.mkdirSync(checkout, { recursive: true });
  const manifest = path.join(checkout, 'package.json');
  fs.writeFileSync(manifest, '{}');
  context.after(() => {
    fs.unlinkSync(manifest);
    for (const folder of [checkout, testParent, directory]) fs.rmdirSync(folder);
  });
  const classify = require('../../lib/performance/review-context.cjs').createTestWriteClassifier();
  assert.equal(classify(path.join(checkout, 'src', 'service.ts'), 'drizzle-unfiltered-write'), undefined);
  assert.ok(classify(path.join(checkout, 'test', 'setup.ts'), 'drizzle-unfiltered-write'));
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
  const { analyzeFile } = require('../../lib/performance/analyze.cjs');
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
  const { repeatedReviewContext } = require('../../lib/performance/review-context.cjs');
  const ts = require('../../lib/performance/compiler.cjs').syntax;
  const reason = (file) => {
    const source = ts.createSourceFile(file, 'hashSync();', ts.ScriptTarget.Latest, true);
    return repeatedReviewContext(source, 'node-sync-fs-in-async', undefined, source);
  };
  assert.equal(reason(path.join(checkout, 'src', 'service.ts')), undefined);
  assert.ok(reason(path.join(checkout, 'test', 'helper.ts')));
});

test('seed, script and tooling sources are contextual for every request-path-only rule', (context) => {
  const fs = require('node:fs');
  const path = require('node:path');
  const directory = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'backend-perf-setup-'));
  fs.writeFileSync(path.join(directory, 'package.json'), '{}');
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const { repeatedReviewContext } = require('../../lib/performance/review-context.cjs');
  const ts = require('../../lib/performance/compiler.cjs').syntax;
  const reason = (file, ruleId) => {
    const source = ts.createSourceFile(path.join(directory, file), 'run();', ts.ScriptTarget.Latest, true);
    return repeatedReviewContext(source, ruleId, undefined, source);
  };
  const rules = [
    'orm-query-in-loop',
    'prisma-query-in-loop',
    'serial-awaits-in-literal',
    'redis-keys-command',
    'index-missing-order',
    'index-missing-filter',
    'password-hash-pure-js',
    'service-query-in-loop',
    'queue-add-in-loop',
    'typeorm-transaction-in-loop',
    'external-call-in-transaction',
    'http-call-without-timeout',
  ];
  for (const ruleId of rules) {
    for (const file of [
      'prisma/seed.ts',
      'seeds/bootstrap.ts',
      'scripts/backfill.ts',
      'src/database/scripts/fix.ts',
      'users.seed.ts',
      'src/users.spec.ts',
    ]) {
      assert.ok(reason(file, ruleId), `${ruleId} ${file}`);
    }
    assert.equal(reason('src/users.service.ts', ruleId), undefined, ruleId);
  }
});

test('a standalone entry point or a database run script is operator tooling wherever it lives', (context) => {
  const fs = require('node:fs');
  const path = require('node:path');
  const directory = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'backend-perf-entry-'));
  fs.writeFileSync(path.join(directory, 'package.json'), '{}');
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const { repeatedReviewContext } = require('../../lib/performance/review-context.cjs');
  const ts = require('../../lib/performance/compiler.cjs').syntax;
  const reason = (file, text) => {
    const source = ts.createSourceFile(path.join(directory, file), text, ts.ScriptTarget.Latest, true);
    return repeatedReviewContext(source, 'service-query-in-loop', undefined, source);
  };
  const library = 'export async function run() { return 1; }';
  const exitingMain = 'async function main() { await work(); }\nmain().catch(() => { process.exitCode = 1; });';
  const guardedMain = 'async function main() { await work(); }\nif (require.main === module) void main();';
  assert.match(reason('src/billing/backfill.ts', exitingMain), /standalone entry points/);
  assert.match(reason('src/billing/backfill.ts', guardedMain), /standalone entry points/);
  assert.ok(reason('src/database/run-balance-conversion.ts', library));
  assert.ok(reason('src/database/tools/reindex.cli.ts', library));
  assert.equal(reason('src/billing/backfill.ts', library), undefined);
  assert.equal(reason('src/billing/run-report.ts', library), undefined);
  // A guarded entry point that also exports, ESM or CommonJS, is imported by other code too.
  for (const exported of [
    'export { main };',
    'module.exports = { main };',
    'module.exports.main = main;',
    'exports.main = main;',
  ])
    assert.equal(
      reason(
        'src/billing/backfill.js',
        `${guardedMain}
${exported}`,
      ),
      undefined,
      exported,
    );
});
