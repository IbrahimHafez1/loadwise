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
      ['service.spec.ts', [true, false]],
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
  const { testWriteContext } = require('../lib/review-context.cjs');
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
  const classify = require('../lib/review-context.cjs').createTestWriteClassifier();
  assert.equal(classify(path.join(checkout, 'src', 'service.ts'), 'drizzle-unfiltered-write'), undefined);
  assert.ok(classify(path.join(checkout, 'test', 'setup.ts'), 'drizzle-unfiltered-write'));
});
