import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { lint } from './helpers.js';
import type { Finding } from '../../lib/shared/types.js';
import { migrationIndexes } from '../../lib/performance/schema/project-indexes.js';
import type { FileMap } from '../types/project-files.js';

const virtualRoot = path.resolve(import.meta.dirname, 'virtual-project');

const prismaSchema = `datasource db {
  provider = "postgresql"
}

model Account {
  id         String @id
  uniqueKey  String
  tableKey   String
  alterKey   String
  inlineKey  String
  droppedKey String
  recreated  String
  bare       String
}
`;

const accountDelegate = `export interface AccountDelegate {
  findMany(args?: { where?: object; orderBy?: object; take?: number }): Promise<any>;
}
export declare class PrismaClient { account: AccountDelegate }`;

// Every column but `bare` and `droppedKey` gets an index through some migration spelling;
// `droppedKey` gets one that a later migration drops, and `recreated` gets it dropped and then
// created again.
const migrations = {
  '001_init/migration.sql': [
    'CREATE TABLE "Account" (',
    '  "id" text NOT NULL,',
    '  "uniqueKey" text,',
    '  "tableKey" text,',
    '  "alterKey" text,',
    '  "inlineKey" text UNIQUE,',
    '  "droppedKey" text,',
    '  "recreated" text,',
    '  "bare" text,',
    '  CONSTRAINT "Account_tableKey_key" UNIQUE ("tableKey"),',
    '  PRIMARY KEY ("id")',
    ');',
    'CREATE UNIQUE INDEX "Account_uniqueKey_key" ON "Account"("uniqueKey");',
    'CREATE INDEX "Account_droppedKey_idx" ON "Account"("droppedKey");',
    'CREATE INDEX "Account_recreated_idx" ON "Account"("recreated");',
  ].join('\n'),
  '002_constraint/migration.sql': 'ALTER TABLE "Account" ADD CONSTRAINT "Account_alterKey_key" UNIQUE ("alterKey");',
  '003_drop/migration.sql': 'DROP INDEX "Account_droppedKey_idx";\nDROP INDEX "Account_recreated_idx";',
  '004_recreate/migration.sql': 'CREATE INDEX "Account_recreated_idx" ON "Account"("recreated");',
};

// The fixture imports the project through a path relative to virtualRoot, which cannot cross drives. GitHub's Windows
// runners check out on D: with TEMP on C:, so the project then goes under the checkout's ignored .test-tmp. Not under
// node_modules: the schema lookup takes the project root from the first node_modules segment of the client's path.
function temporaryParent(): string {
  if (path.parse(os.tmpdir()).root === path.parse(virtualRoot).root) return os.tmpdir();
  const checkoutTemporaryDirectory = path.resolve(import.meta.dirname, '..', '..', '.test-tmp');
  fs.mkdirSync(checkoutTemporaryDirectory, { recursive: true });
  return checkoutTemporaryDirectory;
}

function createProject(context: TestContext) {
  const root = fs.mkdtempSync(path.join(temporaryParent(), 'index-coverage-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(root, 'package.json'),
    '{"name":"coverage-app","dependencies":{"@prisma/client":"6.0.0"}}',
  );
  fs.mkdirSync(path.join(root, 'prisma'));
  fs.writeFileSync(path.join(root, 'prisma', 'schema.prisma'), prismaSchema);
  for (const [name, contents] of Object.entries(migrations)) {
    const file = path.join(root, 'prisma', 'migrations', name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents);
  }
  return root;
}

function findingsFor(root: string, body: string) {
  const prefix = path.relative(virtualRoot, root).replaceAll('\\', '/') + '/';
  const source = `import { PrismaClient } from '${prefix}node_modules/.prisma/client';
declare const prisma: PrismaClient;
export async function run(value: string) {
${body}
}`;
  return lint(source, { [prefix + 'node_modules/.prisma/client/index.d.ts']: accountDelegate }).filter(
    (finding: Finding) => finding.ruleId.startsWith('index-'),
  );
}

test('migration UNIQUE constraints and indexes count as coverage, and the fix never names a dropped index', (context) => {
  const root = createProject(context);
  const findings = findingsFor(
    root,
    ['uniqueKey', 'tableKey', 'alterKey', 'inlineKey', 'droppedKey', 'recreated', 'bare']
      .map((column) => `  await prisma.account.findMany({ where: { ${column}: value } });`)
      .join('\n'),
  );
  assert.deepEqual(
    findings.map((finding: Finding) => /^`Account\.(\w+)`/.exec(finding.message)?.[1]),
    ['droppedKey', 'bare'],
  );
  for (const finding of findings) assert.doesNotMatch(finding.message, /bdropb/i);
});

test('a column filtered only behind a covered conjunct is not reported', (context) => {
  const root = createProject(context);
  const findings = findingsFor(
    root,
    '  await prisma.account.findMany({ where: { tableKey: value, bare: value } });\n' +
      '  await prisma.account.findMany({ where: { alterKey: value }, orderBy: { bare: "asc" }, take: 5 });',
  );
  assert.deepEqual(findings, []);
});

function projectWithMigrations(context: TestContext, files: FileMap) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'index-coverage-builders-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'package.json'), '{}');
  for (const [name, contents] of Object.entries(files)) {
    const file = path.join(root, 'migrations', name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents);
  }
  return root;
}

test('ADD COLUMN with UNIQUE or PRIMARY KEY is an index, and ADD UNIQUE is not mistaken for a column', (context) => {
  const root = projectWithMigrations(context, {
    '001.sql': [
      'ALTER TABLE users ADD COLUMN IF NOT EXISTS handle text UNIQUE, ADD COLUMN age int;',
      'ALTER TABLE users ADD UNIQUE (email);',
      'ALTER TABLE orders ADD code varchar(12) CONSTRAINT orders_code_key UNIQUE;',
    ].join('\n'),
  });
  const keysOf = (table: string) => {
    const entry = migrationIndexes(root).get(table);
    assert.ok(entry, `expected migration indexes for ${table}`);
    return entry.indexes.map((index) => index.keys.map((key) => key.column));
  };
  assert.deepEqual(keysOf('users'), [['handle'], ['email']]);
  assert.deepEqual(keysOf('orders'), [['code']]);
});

test('a table changed through an unread unique or index builder has an unknown index set', (context) => {
  const root = projectWithMigrations(context, {
    '001-knex.js': `exports.up = (knex) =>
  knex.schema.alterTable('members', (table) => {
    table.string('email').unique();
  });
exports.down = (knex) => knex.schema.alterTable('members', () => {});`,
    '002-typeorm.ts': `export class AddAccounts {
  async up(queryRunner) {
    await queryRunner.createTable(new Table({ name: 'accounts', columns: [{ name: 'ref', type: 'text', isUnique: true }] }));
    await queryRunner.createTable(new Table({ name: 'plain', columns: [{ name: 'id', type: 'int' }] }));
  }
  async down() {}
}`,
  });
  const tables = migrationIndexes(root);
  assert.equal(tables.get('members')?.opaque, true);
  assert.equal(tables.get('accounts')?.opaque, true);
  assert.equal(tables.get('plain')?.opaque ?? false, false);
});
