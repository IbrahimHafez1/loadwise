'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');
const { exampleFor } = require('../performance-examples.cjs');

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

function parsesAsJavaScript(code) {
  return ts.createSourceFile('snippet.js', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS).parseDiagnostics;
}

test('each CLI source rule has a syntactically valid hover example', () => {
  const { sourceRules } = require('../../lib/performance/rule-ids.cjs');
  assert.ok(sourceRules.length > 0);
  for (const id of sourceRules) {
    const { code, language } = exampleFor(id, 'javascript');
    assert.ok(code.length, id);
    if (language === 'sql') continue;
    assert.equal(language, 'javascript', id);
    assert.deepEqual(parsesAsJavaScript(code), [], id);
  }
});

test('every known rule and every plan or trace rule has a compact example', () => {
  const { knownRules } = require('../../lib/performance/rule-ids.cjs');
  for (const id of [...knownRules, ...planAndTraceRules]) {
    const example = exampleFor(id, 'typescript');
    assert.ok(example?.code, id + ' has no example');
    assert.ok(example.code.split(String.fromCharCode(10)).length <= 6, id + ' example is longer than six lines');
  }
});

test('plan, trace, index and migration examples show a before and an after that parse', () => {
  const { indexRules, migrationRules, contractRules, databaseRules } = require('../../lib/performance/rule-ids.cjs');
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
    const { before, code, language, note } = exampleFor(id, 'typescript');
    assert.ok(before.split(String.fromCharCode(10)).length <= 6 && note.length > 0, id);
    assert.notEqual(before, code, id);
    if (language === 'javascript') {
      assert.deepEqual(parsesAsJavaScript(before), [], id + ' before');
      assert.deepEqual(parsesAsJavaScript(code), [], id);
    }
  }
});

test('each polyglot match gets an example for its language', () => {
  const dir = path.join(root, 'polyglot', 'performance', 'rules');
  for (const name of fs.readdirSync(dir).filter((name) => name.endsWith('.yml') && name !== 'input.yml')) {
    const id = fs
      .readFileSync(path.join(dir, name), 'utf8')
      .match(/^id: (.+)$/m)[1]
      .trim();
    const language = path.basename(name, '.yml');
    assert.equal(exampleFor(id, language).language, language);
    assert.equal(exampleFor(id, 'javascript'), undefined);
  }
});

test('specializes the suggested operation to the finding and ignores unrelated IDs', () => {
  assert.match(
    exampleFor('promise-combinator-serial-await', 'typescript', 'Promise.allSettled').code,
    /Promise\.allSettled/,
  );
  assert.match(exampleFor('numeric-sort-for-extreme', 'typescriptreact', 'maximum').code, /value > extreme/);
  assert.match(
    exampleFor('orm-count-materialization', 'javascriptreact', 'Consider Model.countDocuments()').code,
    /countDocuments\(filter\)/,
  );
  assert.match(exampleFor('orm-query-in-loop', 'typescript', 'Mongoose Model.find').code, /\$in/);
  assert.match(
    exampleFor('pool-created-per-request-or-item', 'javascript', 'redis.createClient').code,
    /redis\.connect\(/,
  );
  assert.equal(exampleFor('toString', 'typescript'), undefined);
  assert.equal(exampleFor('pg-query-in-loop', 'go'), undefined);
});

test('write diagnostics show a write and batch reads preserve an authorization filter', () => {
  const fsWrite = exampleFor('node-sync-fs-in-async', 'typescript', 'fs.writeFileSync blocks the event loop');
  assert.match(fsWrite.code, /await writeFile\(filename, contents, options\)/);
  for (const [method, replacement] of [
    ['create', 'createMany'],
    ['update', 'updateMany'],
    ['delete', 'deleteMany'],
    ['upsert', 'upsert'],
  ]) {
    const write = exampleFor('prisma-query-in-loop', 'typescript', 'Prisma ' + method + '() is called per iteration.');
    assert.ok(write.code.includes('.' + replacement + '('));
    assert.doesNotMatch(write.code, /findMany/);
  }
  for (const orm of ['TypeORM', 'Sequelize', 'Mongoose', 'Knex', 'Kysely']) {
    assert.match(
      exampleFor('orm-query-in-loop', 'typescript', orm + '.findOne()').code,
      /scope|authorizedOrganizationId/,
    );
  }
});
