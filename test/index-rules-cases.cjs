'use strict';

const { projects, projectFiles, indexFindings } = require('./index-rules-fixtures.cjs');

// Condensed ORM sources shared by the index rule tests; each runner lints a body against one fixture project.
const prismaImport = `import { PrismaClient } from '${projects.prisma}node_modules/.prisma/client';\ndeclare const prisma: PrismaClient;\n`;

function prisma(body) {
  return indexFindings(prismaImport + body, projectFiles('prisma', {}));
}

const drizzleSchema = `import { pgTable, uuid, text, integer, boolean, timestamp, index, unique } from 'drizzle-orm/pg-core';
import { mysqlTable, int, varchar, timestamp as mysqlTimestamp, index as mysqlIndex } from 'drizzle-orm/mysql-core';
import { sql } from 'drizzle-orm';
export { eq, and, or, gt, gte, like, ilike, inArray, desc, sql } from 'drizzle-orm';
export type { Database } from 'drizzle-orm/pg-core';
export const cases = pgTable(
  'cases',
  {
    id: uuid().primaryKey(),
    organizationId: uuid('organization_id').notNull(),
    name: text().notNull(),
    email: text('email'),
    archived: boolean('archived'),
    head: integer().notNull(),
    updatedAt: timestamp('updated_at').notNull(),
  },
  (table) => [
    index('cases_organization_updated').on(table.organizationId, table.updatedAt.desc()),
    index('cases_name_lower_idx').on(sql\`lower(\${table.name})\`),
  ],
);
export const abandonedCarts = mysqlTable(
  'abandoned_carts',
  {
    id: int('id').primaryKey(),
    userId: int('user_id'),
    guestEmail: varchar('guest_email', { length: 255 }),
    lastUpdated: mysqlTimestamp('last_updated').notNull(),
  },
  (table) => [mysqlIndex('user_last_updated_idx').on(table.userId, table.lastUpdated)],
);
`;

function drizzle(body) {
  const source = `import { cases, abandonedCarts, eq, and, or, gt, gte, like, ilike, inArray, desc, sql, type Database } from '${projects.drizzle}schema';
declare const db: Database;
${body}`;
  return indexFindings(source, projectFiles('drizzle', { 'schema.ts': drizzleSchema }));
}

const typeormEntities = `import { Column, Entity, Index, PrimaryGeneratedColumn, Repository, DataSource, In, MoreThan, Raw, IsNull, ILike } from 'typeorm';
export { Repository, DataSource, In, MoreThan, Raw, IsNull, ILike };
export abstract class TenantBaseEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;
  @Index()
  @Column('uuid', { name: 'school_id' })
  schoolId!: string;
}
@Entity('students')
@Index(['schoolId', 'nationalId'], { unique: true, where: '"deleted_at" IS NULL' })
@Index(['enrolledAt'], { where: '"deleted_at" IS NULL' })
export class Student extends TenantBaseEntity {
  @Column({ name: 'national_id' })
  nationalId!: string;
  @Column({ name: 'grade_level' })
  gradeLevel!: number;
  @Column({ name: 'guardian_phone' })
  guardianPhone!: string;
  @Column({ type: 'boolean' })
  active!: boolean;
  @Column({ name: 'enrolled_at' })
  enrolledAt!: Date;
}
`;

function typeormCase(body) {
  const source = `import { Student, Repository, DataSource, In, MoreThan, Raw, IsNull, ILike } from '${projects.typeorm}entities';
declare const dataSource: DataSource;
${body}`;
  return indexFindings(source, projectFiles('typeorm', { 'entities.ts': typeormEntities }));
}

const sequelizeModels = `import { Table, Column, Model, DataType, PrimaryKey, Index } from 'sequelize-typescript';
import { Op } from 'sequelize';
export { Op };
@Table({
  tableName: 'Sales',
  indexes: [{ name: 'sale_org_date', fields: ['organizationId', 'saleDate'] }],
})
export class Sale extends Model<Sale> {
  @PrimaryKey
  @Column(DataType.UUID)
  id!: string;
  @Column(DataType.UUID)
  organizationId!: string;
  @Column(DataType.DATE)
  saleDate!: Date;
  @Index
  @Column(DataType.STRING)
  invoiceNumber!: string;
  @Column(DataType.STRING)
  customerPhone!: string;
}
`;

const mongooseModels = `import mongoose, { Schema } from 'mongoose';
const invoiceSchema = new Schema(
  {
    tenantId: { type: Schema.Types.ObjectId, required: true, index: true },
    customerName: String,
    status: { type: String, enum: ['draft', 'paid'] },
    total: Number,
  },
  { timestamps: true },
);
invoiceSchema.index({ tenantId: 1, createdAt: -1 });
export const Invoice = mongoose.model('Invoice', invoiceSchema);
`;

function sequelize(source) {
  return indexFindings(source, projectFiles('sequelize', { 'models.ts': sequelizeModels }));
}

function mongoose(source) {
  return indexFindings(source, projectFiles('mongoose', { 'models.ts': mongooseModels }));
}

module.exports = { prisma, drizzle, typeormCase, sequelize, mongoose };
