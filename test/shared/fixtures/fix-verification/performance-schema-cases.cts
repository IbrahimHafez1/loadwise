// Performance fix samples whose fix edits schema.prisma or a SQL migration rather than TypeScript.
// The rescan of verifyFix reads the edited schema and migrations; `migrations: true` adds the
// `loadwise perf migrations` checks.
import type { FixVerificationCase } from '../../../types/fix-verification.cjs';

const prismaClient = {
  'node_modules/@prisma/client/index.d.ts': "export * from '.prisma/client';",
  'node_modules/.prisma/client/index.d.ts': `type Args = { where?: object; orderBy?: object; take?: number };
export interface OrderDelegate { findMany(args?: Args): Promise<unknown[]> }
export interface UserDelegate { findFirst(args?: Args): Promise<unknown> }
export declare class PrismaClient { order: OrderDelegate; user: UserDelegate }`,
};
const datasource = `datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}
`;
const shopSchema = `${datasource}
model User {
  id     String  @id
  email  String
  orders Order[]
}

model Order {
  id         String    @id
  customerId String
  customer   User      @relation(fields: [customerId], references: [id])
  couponCode String?
  totalEGP   Int
  paidAt     DateTime?

  @@index([customerId])
  @@map("orders")
}
`;

function prismaSample(ruleId: string, body: string, schema = shopSchema): FixVerificationCase {
  return {
    ruleId,
    files: {
      'package.json': '{}',
      'prisma/schema.prisma': schema,
      ...prismaClient,
      'src/queries.ts': `import { PrismaClient } from '@prisma/client';\ndeclare const prisma: PrismaClient;\n${body}`,
    },
  };
}

const lockTimeout = "SET lock_timeout = '5s';\n";
const manifests = {
  postgres: JSON.stringify({ dependencies: { pg: '^8.0.0' } }),
  mysql: JSON.stringify({ dependencies: { mysql2: '^3.0.0' } }),
};

function sqlMigration(ruleId: string, sql: string, dialect: keyof typeof manifests = 'postgres'): FixVerificationCase {
  return { ruleId, migrations: true, files: { 'package.json': manifests[dialect], 'migrations/001_change.sql': sql } };
}

const typeormMigrationFiles = {
  'package.json': JSON.stringify({ dependencies: { pg: '^8.0.0', typeorm: '^0.3.0' } }),
  'node_modules/typeorm/index.d.ts': `export interface QueryRunner { query(sql: string): Promise<unknown> }
export interface MigrationInterface { up(queryRunner: QueryRunner): Promise<void>; down(queryRunner: QueryRunner): Promise<void> }`,
};

function typeormMigration(ruleId: string, query: string): FixVerificationCase {
  return {
    ruleId,
    migrations: true,
    files: {
      ...typeormMigrationFiles,
      'src/migrations/1700000000000-AddOrderIndex.ts': `import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddOrderIndex1700000000000 implements MigrationInterface {
  name = 'AddOrderIndex1700000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(${query});
  }

  public async down(queryRunner: QueryRunner): Promise<void> {}
}
`,
    },
  };
}

const performanceSchemaCases: FixVerificationCase[] = [
  prismaSample(
    'index-missing-filter',
    'export function byTotal(total: number) {\n  return prisma.order.findMany({ where: { totalEGP: total } });\n}\n',
  ),
  prismaSample(
    'index-missing-order',
    "export function latestPaid() {\n  return prisma.order.findMany({ orderBy: { paidAt: 'desc' }, take: 5 });\n}\n",
  ),
  prismaSample(
    'index-unusable-pattern',
    'export function byCoupon(q: string) {\n  return prisma.order.findMany({ where: { couponCode: { contains: q } } });\n}\n',
  ),
  prismaSample(
    'index-unusable-expression',
    "export function byEmail(email: string) {\n  return prisma.user.findFirst({ where: { email: { equals: email, mode: 'insensitive' } } });\n}\n",
  ),
  prismaSample(
    'index-missing-foreign-key',
    'export const ready = true;\n',
    shopSchema.replace('  @@index([customerId])\n', ''),
  ),
  prismaSample(
    'index-redundant-prefix',
    'export const ready = true;\n',
    `${datasource}
model Member {
  tenantId String
  userId   String
  @@id([tenantId, userId])
  @@index([tenantId])
}
`,
  ),
  sqlMigration('migration-index-not-concurrent', lockTimeout + 'CREATE INDEX orders_store_idx ON orders (store_id);\n'),
  sqlMigration(
    'migration-not-null-without-default',
    lockTimeout + 'ALTER TABLE orders ADD COLUMN note text NOT NULL;\n',
  ),
  sqlMigration(
    'migration-volatile-default',
    lockTimeout + 'ALTER TABLE orders ADD COLUMN token uuid NOT NULL DEFAULT gen_random_uuid();\n',
  ),
  sqlMigration(
    'migration-column-type-rewrite',
    lockTimeout + 'ALTER TABLE orders ALTER COLUMN total TYPE bigint USING total::bigint;\n',
  ),
  sqlMigration('migration-set-not-null-scan', lockTimeout + 'ALTER TABLE orders ALTER COLUMN note SET NOT NULL;\n'),
  sqlMigration(
    'migration-constraint-not-valid',
    lockTimeout +
      'ALTER TABLE orders ADD CONSTRAINT orders_store_fk FOREIGN KEY (store_id) REFERENCES stores (id) ON DELETE CASCADE;\n',
  ),
  sqlMigration('migration-constraint-without-index', lockTimeout + 'ALTER TABLE users ADD UNIQUE (email);\n'),
  sqlMigration('migration-breaking-drop', 'ALTER TABLE users DROP COLUMN legacy;\n'),
  sqlMigration('migration-missing-lock-timeout', '-- AddColumn\nALTER TABLE orders ADD COLUMN note text;\n'),
  sqlMigration('migration-table-rewrite-command', 'REINDEX INDEX orders_store_idx;\n'),
  sqlMigration('migration-mysql-table-copy', 'ALTER TABLE orders ALGORITHM=COPY, ADD COLUMN note TEXT;\n', 'mysql'),
  sqlMigration('migration-mysql-lock-unspecified', 'ALTER TABLE orders ADD COLUMN note TEXT;\n', 'mysql'),
  typeormMigration(
    'migration-concurrent-in-transaction',
    '`CREATE INDEX CONCURRENTLY "orders_store_idx" ON "orders" ("store_id")`',
  ),
];

export { performanceSchemaCases };
