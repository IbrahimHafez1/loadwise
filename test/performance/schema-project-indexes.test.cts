import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { migrationIndexes } from '../../lib/performance/schema/project-indexes.cjs';
import { requireEntry } from '../types/schema-lookups.cjs';
import type { FileMap } from '../types/project-files.cjs';

// A throwaway project whose migrations folder holds the given files.
function projectWith(files: FileMap) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'project-indexes-'));
  fs.writeFileSync(path.join(root, 'package.json'), '{}');
  for (const [name, contents] of Object.entries(files)) {
    const file = path.join(root, 'migrations', name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents);
  }
  return root;
}

test('an expression index does not mark its plain column as mentioned', (context) => {
  const root = projectWith({ '001_users.sql': 'CREATE UNIQUE INDEX "ux_users_email" ON users (lower("email"));' });
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const users = requireEntry(migrationIndexes(root), 'users');
  assert.equal(users.mentioned.has('email'), false);
  assert.equal(users.expressionColumns.has('email'), true);
  assert.equal(users.others.length, 1);
});

test('a later DROP INDEX removes the index, and a rollback step does not count', (context) => {
  const root = projectWith({
    '001_init.sql': [
      'CREATE INDEX "AuditLog_entityType_entityId_idx" ON "AuditLog"("entityType", "entityId");',
      'CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");',
      'CREATE INDEX "orders_status_idx" ON orders (status) WHERE paid;',
    ].join('\n'),
    '002_drop.sql': 'DROP INDEX IF EXISTS "public"."AuditLog_entityType_entityId_idx", "orders_status_idx";',
    '003_drop_constraint.sql': [
      'ALTER TABLE orders ADD CONSTRAINT "orders_code_key" UNIQUE (code);',
      'ALTER TABLE orders DROP CONSTRAINT "orders_code_key";',
    ].join('\n'),
    '004-Rollback.ts': `export class Rollback {
  async up(queryRunner) {
    await queryRunner.query('CREATE INDEX "orders_total_idx" ON orders (total)');
  }
  async down(queryRunner) {
    await queryRunner.query('DROP INDEX "orders_total_idx"');
    await queryRunner.query('CREATE INDEX "AuditLog_entityType_entityId_idx" ON "AuditLog"("entityType", "entityId")');
  }
}`,
  });
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const tables = migrationIndexes(root);
  const keysOf = (table: string) =>
    tables.get(table)?.indexes.map((index) => index.keys.map((key) => key.column)) ?? [];
  assert.deepEqual(keysOf('auditlog'), [['createdat']]);
  assert.deepEqual(keysOf('orders'), [['total']]);
  assert.equal(requireEntry(tables, 'orders').mentioned.has('status'), false);
});
