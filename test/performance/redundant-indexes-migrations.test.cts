// Which migration statements count as applied schema for index-redundant-prefix: comments, rollback
// steps, re-created indexes and baseline dumps.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { checkRedundantSchemaIndexes } from '../../lib/performance/redundant-indexes.cjs';
import type { FileMap } from '../types/project-files.cjs';

function findingsOf(files: FileMap) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loadwise-redundant-migrations-'));
  try {
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ dependencies: { pg: '8.0.0' } }));
    for (const [name, contents] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
      fs.writeFileSync(path.join(root, name), contents);
    }
    return checkRedundantSchemaIndexes(root).map(({ file, line }) => [path.basename(file ?? ''), line]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('migrations: an index inside a block comment is not schema', () => {
  const findings = findingsOf({
    'migrations/001-roles.ts': [
      "await createTable('role').withIndexOn('scopeSlug').withColumns(column('id').int);",
      '/*',
      " await createTable('role').withIndexOn('scopeslug', true);",
      '*/',
      '',
    ].join('\n'),
  });
  assert.deepEqual(findings, []);
});

test('migrations: an index in a line comment of a SQL file is not schema', () => {
  const findings = findingsOf({
    'migrations/001.sql': 'CREATE INDEX a_idx ON items (owner_id, kind);\n-- CREATE INDEX b_idx ON items (owner_id);\n',
  });
  assert.deepEqual(findings, []);
});

test('migrations: re-creating an index of the same name replaces it instead of duplicating itself', () => {
  const findings = findingsOf({
    'migrations/001.sql': 'CREATE INDEX items_created_at ON items (created_at);\n',
    'migrations/002.js': [
      'module.exports = {',
      '  async up(queryInterface) {',
      '    await queryInterface.sequelize.query(',
      '      \'CREATE INDEX IF NOT EXISTS "items_created_at" ON "items" ("created_at");\'',
      '    );',
      '  },',
      '};',
      '',
    ].join('\n'),
  });
  assert.deepEqual(findings, []);
});

test('migrations: statements in the down step do not count, and a DROP INDEX in up removes the index', () => {
  const findings = findingsOf({
    'migrations/001.sql': 'CREATE INDEX items_owner ON items (owner_id);\n',
    'migrations/002.js': [
      'module.exports = {',
      '  async up(queryInterface) {',
      '    await queryInterface.sequelize.query(',
      '      \'CREATE INDEX IF NOT EXISTS "items_owner_created" ON "items" ("owner_id", "created_at");\'',
      '    );',
      '    await queryInterface.sequelize.query(\'DROP INDEX IF EXISTS "items_owner";\');',
      '  },',
      '',
      '  async down(queryInterface) {',
      '    await queryInterface.sequelize.query(',
      '      \'CREATE INDEX IF NOT EXISTS "items_owner" ON "items" ("owner_id");\'',
      '    );',
      '  },',
      '};',
      '',
    ].join('\n'),
  });
  assert.deepEqual(findings, []);
});

test('migrations: a baseline dump replays before the dated migrations that change it', () => {
  const findings = findingsOf({
    'migrations/baseline/schema.sql': 'CREATE INDEX items_owner ON items (owner_id);\n',
    'migrations/20260101-narrow.js': [
      'module.exports = {',
      '  async up(queryInterface) {',
      '    await queryInterface.sequelize.query(',
      '      \'CREATE INDEX IF NOT EXISTS "items_owner_created" ON "items" ("owner_id", "created_at");\'',
      '    );',
      '    await queryInterface.sequelize.query(\'DROP INDEX IF EXISTS "items_owner";\');',
      '  },',
      '};',
      '',
    ].join('\n'),
  });
  assert.deepEqual(findings, []);
});

test('migrations: a real prefix index is still reported', () => {
  const findings = findingsOf({
    'migrations/001.sql': 'CREATE INDEX a_idx ON items (owner_id);\nCREATE INDEX b_idx ON items (owner_id, kind);\n',
  });
  assert.deepEqual(findings, [['001.sql', 1]]);
});
