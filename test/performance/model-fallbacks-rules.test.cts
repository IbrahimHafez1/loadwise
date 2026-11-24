import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lint } from './helpers.cjs';
import type { Finding } from '../../lib/shared/types.cjs';
import { reasonOf } from '../types/finding-reason.cjs';
import type { FileMap } from '../types/project-files.cjs';

function ruleIds(source: string, files: FileMap, ruleId: string) {
  return lint(source, files).filter((finding: Finding) => finding.ruleId === ruleId);
}

test('orm-query-in-loop reports a TypeORM entity repository without installed types', () => {
  const findings = ruleIds(
    `import { DataSource } from 'typeorm';
     import { User } from './user.entity';
     export async function run(source: DataSource, ids: number[]) {
       const repo = source.getRepository(User);
       for (const id of ids) await repo.findOne({ where: { id } });
     }`,
    { 'user.entity.ts': "import { Entity } from 'typeorm'; @Entity() export class User { id!: number }" },
    'orm-query-in-loop',
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].contextualReason, undefined);
});

test('a write of a value of unknown shape in a loop stays contextual', () => {
  const findings = ruleIds(
    `import { DataSource } from 'typeorm';
     import { User } from './user.entity';
     export async function run(source: DataSource, groups: unknown[]) {
       const repo = source.getRepository(User);
       for (const group of groups) await repo.save(group);
     }`,
    { 'user.entity.ts': "import { Entity } from 'typeorm'; @Entity() export class User { id!: number }" },
    'orm-query-in-loop',
  );
  assert.equal(findings.length, 1);
  assert.match(reasonOf(findings[0]), /may already be a list/);
});

test('orm-query-in-loop reports Mongoose and Sequelize project models', () => {
  const files = {
    'user.model.ts': "import { model } from 'mongoose'; export const UserModel = model('User', {} as never);",
    'account.ts': "import { Model } from 'sequelize'; export class Account extends Model {}",
  };
  const source = `import { UserModel } from './user.model';
     import { Account } from './account';
     export async function run(ids: string[]) {
       for (const id of ids) { await UserModel.findOne({ id }).exec(); await Account.findByPk(id); }
     }`;
  const findings = ruleIds(source, files, 'orm-query-in-loop');
  assert.ok(findings.some((finding: Finding) => finding.message.startsWith('Sequelize.findByPk')));
});

test('lookalike objects with the same method names stay quiet', () => {
  const findings = lint(
    `import { cache } from './cache';
     export async function run(ids: number[]) { for (const id of ids) await cache.findOne({ id }); }`,
    { 'cache.ts': 'export const cache = { async findOne(key: object) { return key; } };' },
  );
  assert.deepEqual(
    findings.filter((finding: Finding) => /orm|drizzle/.test(finding.ruleId)),
    [],
  );
});

test('drizzle-query-in-loop reports a Drizzle client without installed types', () => {
  const findings = ruleIds(
    `import { drizzle } from 'drizzle-orm/node-postgres';
     import { eq } from 'drizzle-orm';
     import { users } from './schema';
     const db = drizzle(process.env.DATABASE_URL!);
     export async function run(ids: number[]) {
       for (const id of ids) await db.select().from(users).where(eq(users.id, id));
     }`,
    {
      'schema.ts':
        "import { pgTable, serial } from 'drizzle-orm/pg-core'; export const users = pgTable('users', { id: serial('id') });",
    },
    'drizzle-query-in-loop',
  );
  assert.equal(findings.length, 1);
});
