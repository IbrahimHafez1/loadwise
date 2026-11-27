import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import type { TestContext } from 'node:test';

import { collectPaths, discoverMigrations } from '../../lib/performance/migrations/discover.js';
import type { FileMap } from '../types/project-files.js';
import type { MigrationFile } from '../../lib/performance/types/migration-files.js';

function project(context: TestContext, files: FileMap) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'loadwise-migrations-'));
  for (const [name, contents] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(directory, name)), { recursive: true });
    fs.writeFileSync(path.join(directory, name), contents);
  }
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

const relative = (root: string, files: readonly MigrationFile[]) =>
  files.map((file) => [path.relative(root, file.path).split(path.sep).join('/'), file.framework, file.dialect]);

describe('migration discovery', () => {
  test('Prisma migrations with the dialect from migration_lock.toml', (context) => {
    const root = project(context, {
      'package.json': '{"dependencies":{"@prisma/client":"6"}}',
      'prisma/schema.prisma': '',
      'prisma/migrations/migration_lock.toml': 'provider = "postgresql"\n',
      'prisma/migrations/20240102_b/migration.sql': 'SELECT 1;',
      'prisma/migrations/20240101_a/migration.sql': 'SELECT 1;',
    });
    assert.deepEqual(relative(root, discoverMigrations(root).files), [
      ['prisma/migrations/20240101_a/migration.sql', 'prisma', 'postgres'],
      ['prisma/migrations/20240102_b/migration.sql', 'prisma', 'postgres'],
    ]);
  });

  test('Prisma schema location from package.json and unsupported providers are reported', (context) => {
    const root = project(context, {
      'package.json': '{"prisma":{"schema":"db/schema.prisma"}}',
      'db/migrations/migration_lock.toml': 'provider = "sqlite"\n',
      'db/migrations/1_a/migration.sql': 'SELECT 1;',
    });
    const result = discoverMigrations(root);
    assert.deepEqual(result.files, []);
    assert.deepEqual(result.skipped, ['prisma sqlite']);
  });

  test('Drizzle out folder and dialect come from the config, read without executing it', (context) => {
    const root = project(context, {
      'drizzle.config.ts': "export default defineConfig({ dialect: 'mysql', out: './db/out', schema: './s.ts' });",
      'db/out/0001_b.sql': 'SELECT 1;',
      'db/out/0000_a.sql': 'SELECT 1;',
      'db/out/meta/_journal.json': '{}',
    });
    assert.deepEqual(relative(root, discoverMigrations(root).files), [
      ['db/out/0000_a.sql', 'drizzle', 'mysql'],
      ['db/out/0001_b.sql', 'drizzle', 'mysql'],
    ]);
  });

  test('migrations folders skip dependencies, build output, dot folders and test files', (context) => {
    const root = project(context, {
      'package.json': '{"dependencies":{"pg":"8","typeorm":"0.3"}}',
      'src/database/migrations/2-B.ts': '',
      'src/database/migrations/10-C.ts': '',
      'src/database/migrations/1-A.ts': '',
      'src/database/migrations/types.d.ts': '',
      'src/database/migrations/a.spec.ts': '',
      'src/database/migrations/b.db-spec.ts': '',
      'src/database/migrations/notes.md': '',
      'node_modules/lib/migrations/x.js': '',
      'dist/migrations/1-A.js': '',
      '.private/migrations/y.sql': '',
    });
    assert.deepEqual(relative(root, discoverMigrations(root).files), [
      ['src/database/migrations/1-A.ts', 'code', 'postgres'],
      ['src/database/migrations/2-B.ts', 'code', 'postgres'],
      ['src/database/migrations/10-C.ts', 'code', 'postgres'],
    ]);
  });

  test('knexfile and .sequelizerc name migration folders', (context) => {
    const root = project(context, {
      'package.json': '{"dependencies":{"mysql2":"3"}}',
      'knexfile.js': "module.exports = { client: 'mysql2', migrations: { directory: './db/knex' } };",
      '.sequelizerc': "module.exports = { 'migrations-path': path.resolve('db', 'sequelize') };",
      'db/knex/001_a.js': '',
      'db/sequelize/002_b.cjs': '',
    });
    assert.deepEqual(relative(root, discoverMigrations(root).files), [
      ['db/knex/001_a.js', 'code', 'mysql'],
      ['db/sequelize/002_b.cjs', 'code', 'mysql'],
    ]);
  });

  test('ambiguous or unknown dialects ask for --dialect; --dialect overrides', (context) => {
    const both = project(context, {
      'package.json': '{"dependencies":{"pg":"8","mysql2":"3"}}',
      'migrations/1.sql': 'SELECT 1;',
    });
    assert.throws(() => discoverMigrations(both), /--dialect postgres or --dialect mysql/);
    assert.equal(discoverMigrations(both, { dialect: 'mysql' }).files[0].dialect, 'mysql');
  });

  test('explicit files and folders keep their framework', (context) => {
    const root = project(context, {
      'package.json': '{"dependencies":{"pg":"8"}}',
      'prisma/migrations/migration_lock.toml': 'provider = "postgresql"\n',
      'prisma/migrations/1_a/migration.sql': 'SELECT 1;',
      'loose/one.sql': 'SELECT 1;',
    });
    const result = collectPaths(['prisma/migrations/1_a/migration.sql', 'loose'], { cwd: root });
    assert.deepEqual(relative(root, result.files), [
      ['prisma/migrations/1_a/migration.sql', 'prisma', 'postgres'],
      ['loose/one.sql', 'sql', 'postgres'],
    ]);
    assert.throws(() => collectPaths(['missing.sql'], { cwd: root }), /does not exist/);
  });
});
