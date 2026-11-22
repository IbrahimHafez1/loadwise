'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { projects, projectFiles, indexFindings } = require('./index-rules-fixtures.cjs');

// One schema per ORM declaring the same index through every source that ORM offers. Each `covered` column must
// stay silent; each `bare` column has no index and must be reported.
function lintProject(orm, files, source) {
  return indexFindings(source, projectFiles(orm, files));
}

function reportedColumns(findings) {
  return findings.map((finding) => /^`\w+\.(\w+)`/.exec(finding.message)?.[1]);
}

const drizzleSchema = `import { pgTable, uuid, text, index, uniqueIndex, unique, primaryKey } from 'drizzle-orm/pg-core';
export { eq } from 'drizzle-orm';
export type { Database } from 'drizzle-orm/pg-core';
export const things = pgTable(
  'things',
  {
    id: uuid().primaryKey(),
    plain: text().notNull(),
    uniqueOnly: text().notNull(),
    constrained: text().notNull(),
    inlineUnique: text().unique(),
    pairFirst: text().notNull(),
    pairSecond: text().notNull(),
    bare: text().notNull(),
  },
  (table) => [
    index('things_plain_idx').on(table.plain),
    uniqueIndex('things_unique_only_idx').on(table.uniqueOnly),
    unique('things_constrained_key').on(table.constrained),
    primaryKey({ columns: [table.pairFirst, table.pairSecond] }),
  ],
);
`;

test('Drizzle: index, uniqueIndex, unique, column unique and a composite primaryKey all lead their first column', () => {
  const findings = lintProject(
    'drizzle',
    { 'schema.ts': drizzleSchema },
    `import { things, eq, type Database } from '${projects.drizzle}schema';
declare const db: Database;
export async function run(value: string) {
  await db.select().from(things).where(eq(things.plain, value));
  await db.select().from(things).where(eq(things.uniqueOnly, value));
  await db.select().from(things).where(eq(things.constrained, value));
  await db.select().from(things).where(eq(things.inlineUnique, value));
  await db.select().from(things).where(eq(things.pairFirst, value));
  await db.select().from(things).where(eq(things.pairSecond, value));
  await db.select().from(things).where(eq(things.bare, value));
}`,
  );
  assert.deepEqual(reportedColumns(findings), ['pairSecond', 'bare']);
  assert.match(findings[0].message, /only the 2nd column of the index on \(`pairFirst`, `pairSecond`\)/);
});

const typeormEntities = `import { Column, Entity, Index, Unique, PrimaryColumn, PrimaryGeneratedColumn, Repository } from 'typeorm';
export { Repository };
@Entity('accounts')
@Index(['tenantId', 'handle'])
@Unique(['externalRef'])
export class Account {
  @PrimaryGeneratedColumn('uuid')
  id!: string;
  @Column()
  tenantId!: string;
  @Column()
  handle!: string;
  @Column()
  externalRef!: string;
  @Index()
  @Column()
  decorated!: string;
  @Column({ unique: true })
  inlineUnique!: string;
  @Column()
  bare!: string;
}
`;

test('TypeORM: @Index, @Unique, a column unique option and a composite lead only their first column', () => {
  const findings = lintProject(
    'typeorm',
    { 'entities.ts': typeormEntities },
    `import { Account, Repository } from '${projects.typeorm}entities';
export class AccountService {
  constructor(private readonly accounts: Repository<Account>) {}
  async run(value: string) {
    await this.accounts.find({ where: { tenantId: value } });
    await this.accounts.find({ where: { handle: value } });
    await this.accounts.find({ where: { externalRef: value } });
    await this.accounts.find({ where: { decorated: value } });
    await this.accounts.find({ where: { inlineUnique: value } });
    await this.accounts.find({ where: { bare: value } });
  }
}`,
  );
  assert.deepEqual(reportedColumns(findings), ['handle', 'bare']);
});

const sequelizeModels = `import { Table, Column, Model, DataType, PrimaryKey, Index, Unique } from 'sequelize-typescript';
@Table({
  tableName: 'Tickets',
  indexes: [{ fields: ['queue', 'openedAt'] }, { unique: true, fields: ['reference'] }],
})
export class Ticket extends Model<Ticket> {
  @PrimaryKey
  @Column(DataType.UUID)
  id!: string;
  @Column(DataType.STRING)
  queue!: string;
  @Column(DataType.DATE)
  openedAt!: Date;
  @Column(DataType.STRING)
  reference!: string;
  @Unique
  @Column(DataType.STRING)
  decoratedUnique!: string;
  @Column({ type: DataType.STRING, unique: true })
  inlineUnique!: string;
  @Column(DataType.STRING)
  bare!: string;
}
`;

test('Sequelize: the indexes option, @Unique and a column unique option cover their columns', () => {
  const findings = lintProject(
    'sequelize',
    { 'models.ts': sequelizeModels },
    `import { Ticket } from '${projects.sequelize}models';
export async function run(value: string) {
  await Ticket.findAll({ where: { queue: value } });
  await Ticket.findAll({ where: { openedAt: value } });
  await Ticket.findAll({ where: { reference: value } });
  await Ticket.findAll({ where: { decoratedUnique: value } });
  await Ticket.findAll({ where: { inlineUnique: value } });
  await Ticket.findAll({ where: { bare: value } });
}`,
  );
  assert.deepEqual(reportedColumns(findings), ['openedAt', 'bare']);
});

const mongooseModels = `import mongoose, { Schema } from 'mongoose';
const noteSchema = new Schema({
  indexedField: { type: String, index: true },
  uniqueField: { type: String, unique: true },
  compoundFirst: String,
  compoundSecond: String,
  bare: String,
});
noteSchema.index({ compoundFirst: 1, compoundSecond: -1 });
export const Note = mongoose.model('Note', noteSchema);
`;

test('Mongoose: index: true, unique: true and schema.index cover their leading field', () => {
  const findings = lintProject(
    'mongoose',
    { 'models.ts': mongooseModels },
    `import { Note } from '${projects.mongoose}models';
export async function run(value: string) {
  await Note.find({ indexedField: value });
  await Note.find({ uniqueField: value });
  await Note.find({ compoundFirst: value });
  await Note.find({ compoundSecond: value });
  await Note.find({ bare: value });
}`,
  );
  assert.deepEqual(reportedColumns(findings), ['compoundSecond', 'bare']);
});
