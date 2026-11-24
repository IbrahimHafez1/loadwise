import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import ts from 'typescript';
import { exampleFor } from '../performance-examples.cjs';
import type { FixExample } from '../types/fix-example.cjs';
import {
  sourceRules,
  knownRules,
  indexRules,
  migrationRules,
  contractRules,
  databaseRules,
} from '../../lib/performance/rule-ids.cjs';

const root = path.resolve(__dirname, '../..');

// Findings built from query plans and traces are not part of the source-rule list.
const planAndTraceRules = [
  'duplicate-key-read',
  'repeated-db-span',
  'redis-keys-scan',
  'redis-repeated-read',
  'pg-sequential-scan',
  'pg-disk-sort',
  'pg-deep-offset',
  'mongo-collection-scan',
  'mongo-disk-sort',
  'mongo-deep-skip',
];

// An example the test expects the editor to offer.
function exampleOf(ruleId: string, languageId: string, message?: string): FixExample {
  const example = exampleFor(ruleId, languageId, message);
  assert.ok(example, ruleId + ' has no example');
  return example;
}

function parseDiagnostics(code: string, language: string) {
  const kinds: Record<string, readonly [string, ts.ScriptKind]> = {
    tsx: ['snippet.tsx', ts.ScriptKind.TSX],
    typescript: ['snippet.ts', ts.ScriptKind.TS],
  };
  const [fileName, scriptKind] = kinds[language] ?? ['snippet.js', ts.ScriptKind.JS];
  const { parseDiagnostics } = ts.createSourceFile(fileName, code, ts.ScriptTarget.Latest, true, scriptKind);
  assert.ok(parseDiagnostics);
  return parseDiagnostics;
}

test('each CLI source rule has a syntactically valid hover example', () => {
  assert.ok(sourceRules.length > 0);
  for (const id of sourceRules) {
    const { code, language } = exampleOf(id, 'javascript');
    assert.ok(code.length, id);
    if (language === 'sql') continue;
    // Frontend rules show JSX or decorators, so their examples are tsx or typescript; the rest stay
    // plain JavaScript.
    assert.ok(['javascript', 'tsx', 'typescript'].includes(language), id);
    assert.deepEqual(parseDiagnostics(code, language), [], id);
  }
});

test('every known rule and every plan or trace rule has a compact example', () => {
  for (const id of [...knownRules, ...planAndTraceRules]) {
    const example = exampleFor(id, 'typescript');
    assert.ok(example?.code, id + ' has no example');
    assert.ok(example.code.split(String.fromCharCode(10)).length <= 6, id + ' example is longer than six lines');
  }
});

test('plan, trace, index and migration examples show a before and an after that parse', () => {
  const standalone = [
    ...indexRules,
    ...migrationRules,
    ...contractRules,
    ...databaseRules,
    ...planAndTraceRules,
    'redis-command-in-loop',
    'password-hash-sync-in-async',
  ];
  for (const id of standalone) {
    const { before, code, language, note } = exampleOf(id, 'typescript');
    assert.ok(before, id + ' has no before');
    assert.ok(note, id + ' has no note');
    assert.ok(before.split(String.fromCharCode(10)).length <= 6 && note.length > 0, id);
    assert.notEqual(before, code, id);
    if (['javascript', 'tsx', 'typescript'].includes(language)) {
      assert.deepEqual(parseDiagnostics(before, language), [], id + ' before');
      assert.deepEqual(parseDiagnostics(code, language), [], id);
    }
  }
});

test('each polyglot match gets an example for its language', () => {
  const dir = path.join(root, 'polyglot', 'performance', 'rules');
  for (const name of fs.readdirSync(dir).filter((name) => name.endsWith('.yml') && name !== 'input.yml')) {
    const idMatch = fs.readFileSync(path.join(dir, name), 'utf8').match(/^id: (.+)$/m);
    assert.ok(idMatch?.[1]);
    const id = idMatch[1].trim();
    const language = path.basename(name, '.yml');
    assert.equal(exampleOf(id, language).language, language);
    assert.equal(exampleFor(id, 'javascript'), undefined);
  }
});

test('specializes the suggested operation to the finding and ignores unrelated IDs', () => {
  assert.match(
    exampleOf('promise-combinator-serial-await', 'typescript', 'Promise.allSettled').code,
    /Promise\.allSettled/,
  );
  assert.match(exampleOf('numeric-sort-for-extreme', 'typescriptreact', 'maximum').code, /value > extreme/);
  assert.match(
    exampleOf('orm-count-materialization', 'javascriptreact', 'Consider Model.countDocuments()').code,
    /countDocuments\(filter\)/,
  );
  assert.match(exampleOf('orm-query-in-loop', 'typescript', 'Mongoose Model.find').code, /\$in/);
  assert.match(
    exampleOf('pool-created-per-request-or-item', 'javascript', 'redis.createClient').code,
    /redis\.connect\(/,
  );
  assert.equal(exampleFor('toString', 'typescript'), undefined);
  assert.equal(exampleFor('pg-query-in-loop', 'go'), undefined);
});

test('write diagnostics show a write and batch reads preserve an authorization filter', () => {
  const fsWrite = exampleOf('node-sync-fs-in-async', 'typescript', 'fs.writeFileSync blocks the event loop');
  assert.match(fsWrite.code, /await writeFile\(filename, contents, options\)/);
  for (const [method, replacement] of [
    ['create', 'createMany'],
    ['update', 'updateMany'],
    ['delete', 'deleteMany'],
    ['upsert', 'upsert'],
  ]) {
    const write = exampleOf('prisma-query-in-loop', 'typescript', 'Prisma ' + method + '() is called per iteration.');
    assert.ok(write.code.includes('.' + replacement + '('));
    assert.doesNotMatch(write.code, /findMany/);
  }
  for (const orm of ['TypeORM', 'Sequelize', 'Mongoose', 'Knex', 'Kysely']) {
    assert.match(
      exampleOf('orm-query-in-loop', 'typescript', orm + '.findOne()').code,
      /scope|authorizedOrganizationId/,
    );
  }
});
