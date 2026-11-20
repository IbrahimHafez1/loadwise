'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');
const { exampleFor } = require('../performance-examples.cjs');

const root = path.resolve(__dirname, '../..');

test('each CLI source rule has a syntactically valid hover example', () => {
  const cli = fs.readFileSync(path.join(root, 'bin', 'backend-perf-check.cjs'), 'utf8');
  const entries = cli.match(/const sourceRules = new Set\(\[([\s\S]*?)\]\)/)[1];
  const ids = [...entries.matchAll(/'([a-z-]+)'/g)].map((match) => match[1]);
  assert.ok(ids.length > 0);
  for (const id of ids) {
    const { code, language } = exampleFor(id, 'javascript');
    assert.ok(code.length, id);
    if (language === 'sql') continue;
    assert.equal(language, 'javascript', id);
    assert.deepEqual(
      ts.createSourceFile('snippet.js', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS).parseDiagnostics,
      [],
      id,
    );
  }
});

test('each polyglot match gets an example for its language', () => {
  const dir = path.join(root, 'polyglot', 'rules');
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
