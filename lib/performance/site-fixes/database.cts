// Site fixes for live-database findings. They name a table, not a source line, so the fix is a new
// migration file in the project's own convention (Prisma, TypeORM, Knex, Sequelize, migrate-mongo,
// plain SQL folders) holding the DDL the finding already states. db-seq-scan-heavy-table and
// mongo-collection-scan-observed name no columns, so there is no DDL to write and they have no
// builder.
import fs from 'node:fs';
import path from 'node:path';
import { detectFramework } from '../migrations/extract-code.cjs';
import { readConfigStrings } from '../migrations/discover.cjs';
import { requireReview } from './helpers.cjs';
import type { FileTarget, Finding, FixResult, SiteFixInput } from '../../shared/types.cjs';

const PG_NAME = String.raw`"(?:[^"]|"")+"`;
const PG_CREATE_INDEX = new RegExp(
  String.raw`^CREATE INDEX CONCURRENTLY (${PG_NAME}) ON ((?:${PG_NAME}\.)?${PG_NAME}) \(.+\);$`,
);
const PG_DROP_INDEX = new RegExp(String.raw`^DROP INDEX CONCURRENTLY ((?:${PG_NAME}\.)?(${PG_NAME}));$`);
const MYSQL_DROP_INDEX = /^ALTER TABLE `(?:[^`]|``)+` DROP INDEX `((?:[^`]|``)+)`, ALGORITHM=INPLACE, LOCK=NONE;$/;
const MONGO_DROP_INDEX = /^db\.getCollection\(("(?:[^"\\]|\\.)*")\)\.dropIndex\(("(?:[^"\\]|\\.)*")\)$/;
const MONGO_INDEX_KEY = /^Index `[^`]+` `(\{.*?\})`/;
const CODE_MIGRATION_DIRECTORIES = [
  'src/migrations',
  'src/migration',
  'migrations',
  'migration',
  'src/database/migrations',
  'src/db/migrations',
  'db/migrations',
  'database/migrations',
];
const SQL_MIGRATION_DIRECTORIES = [
  'migrations',
  'db/migrations',
  'sql/migrations',
  'src/migrations',
  'database/migrations',
];
const KNEX_CONFIGS = ['knexfile.ts', 'knexfile.js', 'knexfile.mjs', 'knexfile.cjs'];
const DRIZZLE_CONFIGS = ['drizzle.config.ts', 'drizzle.config.js', 'drizzle.config.mjs', 'drizzle.config.cjs'];
const MONGO_CONFIGS = ['migrate-mongo-config.js', 'migrate-mongo-config.cjs'];
const CODE_EXTENSION = /\.(?:[cm]?[jt]s)$/;
const MAX_NAME_LENGTH = 60;

// What the finding asks to change in a relational database: its DDL, and how to undo it.
interface SqlIndexChange {
  engine: 'postgres' | 'mysql';
  action: 'add' | 'drop';
  indexName: string;
  up: string;
  down?: string;
  downHint?: string;
}

interface MongoIndexChange {
  engine: 'mongo';
  action: 'drop';
  indexName: string;
  collection: string;
  /** The key the dropped index had, when the finding names it. */
  key?: unknown;
}

type IndexChange = SqlIndexChange | MongoIndexChange;

// How the project writes migrations; `directory` is relative to the project root.
interface PrismaLayout {
  tool: 'prisma';
  directory: string;
}

interface TypeormLayout {
  tool: 'typeorm';
  directory: string;
  extension?: string;
  commonJs: boolean;
}

interface KnexLayout {
  tool: 'knex';
  directory: string;
  extension?: string;
  commonJs: boolean;
}

interface SequelizeLayout {
  tool: 'sequelize';
  directory: string;
}

interface FlywayLayout {
  tool: 'flyway';
  directory: string;
  next: number;
}

interface GolangMigrateLayout {
  tool: 'golang-migrate';
  directory: string;
  next: string;
}

interface PlainSqlLayout {
  tool: 'sql';
  directory: string;
  /** Why the folder is the default one: Drizzle keeps its own journal, or no tool was detected. */
  reason?: 'drizzle' | 'none';
}

interface MongoLayout {
  tool: 'migrate-mongo' | 'mongosh';
  directory: string;
}

type SqlFolderLayout = PrismaLayout | FlywayLayout | GolangMigrateLayout | PlainSqlLayout;
type MigrationLayout = SqlFolderLayout | TypeormLayout | KnexLayout | SequelizeLayout | MongoLayout;

// A migration file to create, named relative to the layout's directory.
interface MigrationFile {
  name: string;
  text: string;
}

// The migration folder a config file names, and that config's file name.
interface ConfiguredDirectory {
  config: string;
  directory: string;
}

interface CodeMigrationStyle {
  framework: string;
  extension: string | undefined;
  commonJs: boolean;
}

// What a database builder reads besides the flagged finding: the project root and the clock.
interface MigrationInput extends SiteFixInput {
  root?: string;
  now?: Date;
}

const INVALID_INDEX_NOTE =
  'If the concurrent build fails it leaves an INVALID index: drop it with `DROP INDEX CONCURRENTLY` and rerun.';
const TYPEORM_TRANSACTION_NOTE =
  "The migration sets `transaction = false` because CONCURRENTLY cannot run in a transaction; TypeORM honours it only with `migrationsTransactionMode: 'each'` (CLI `--transaction each`).";

// --- What the finding asks for
// -------------------------------------------------------------------------------------

function unquotePg(name: string): string {
  return name.slice(1, -1).replaceAll('""', '"');
}

// { engine, action, indexName, up, down?, downHint? } from the DDL in the finding's suggestion.
function requestedChange(finding: Finding): IndexChange | undefined {
  const suggestion = typeof finding.suggestion === 'string' ? finding.suggestion : '';
  const create = PG_CREATE_INDEX.exec(suggestion);
  if (create) {
    const schema = create[2].includes('"."') ? create[2].slice(0, create[2].indexOf('"."') + 1) + '.' : '';
    return {
      engine: 'postgres',
      action: 'add',
      indexName: unquotePg(create[1]),
      up: suggestion,
      down: `DROP INDEX CONCURRENTLY IF EXISTS ${schema}${create[1]};`,
    };
  }
  const drop = PG_DROP_INDEX.exec(suggestion);
  if (drop) {
    const regclass = drop[1].replaceAll("'", "''");
    return {
      engine: 'postgres',
      action: 'drop',
      indexName: unquotePg(drop[2]),
      up: suggestion,
      downHint: `Recreate the index from its definition, saved before this migration ran with: SELECT pg_get_indexdef('${regclass}'::regclass);`,
    };
  }
  const mysqlDrop = MYSQL_DROP_INDEX.exec(suggestion);
  if (mysqlDrop) {
    return {
      engine: 'mysql',
      action: 'drop',
      indexName: mysqlDrop[1].replaceAll('``', '`'),
      up: suggestion,
      downHint: 'Recreate the index from its definition in SHOW CREATE TABLE, saved before this migration ran.',
    };
  }
  const mongoDrop = MONGO_DROP_INDEX.exec(suggestion);
  if (mongoDrop) {
    const key = MONGO_INDEX_KEY.exec(finding.message ?? '')?.[1];
    return {
      engine: 'mongo',
      action: 'drop',
      indexName: String(JSON.parse(mongoDrop[2])),
      collection: String(JSON.parse(mongoDrop[1])),
      key: key ? JSON.parse(key) : undefined,
    };
  }
}

// --- The project's migration convention
// ----------------------------------------------------------------------------

function exists(target: string): boolean {
  return fs.existsSync(target);
}

function listFiles(directory: string): string[] {
  try {
    return fs
      .readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

function readText(file: string): string {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

function prismaDirectory(root: string): string | undefined {
  const packageJson = readText(path.join(root, 'package.json'));
  let schema: unknown;
  try {
    schema = JSON.parse(packageJson || '{}').prisma?.schema;
  } catch {
    schema = undefined;
  }
  const candidates = [path.join('prisma', 'migrations')];
  if (typeof schema === 'string') candidates.unshift(path.join(path.dirname(schema), 'migrations'));
  return candidates.find((directory) => exists(path.join(root, directory, 'migration_lock.toml')));
}

function configuredDirectory(
  root: string,
  configs: readonly string[],
  property: string,
): ConfiguredDirectory | undefined {
  for (const config of configs) {
    const file = path.join(root, config);
    if (!exists(file)) continue;
    const value = readConfigStrings(file, [property])[property]?.[0];
    return { config, directory: value ? path.relative(root, path.resolve(root, value)) : 'migrations' };
  }
}

function codeMigrationStyle(root: string, directory: string): CodeMigrationStyle {
  const files = listFiles(path.join(root, directory)).filter(
    (name) => CODE_EXTENSION.test(name) && !name.endsWith('.d.ts'),
  );
  const sample = files.map((name) => readText(path.join(root, directory, name))).find(Boolean) ?? '';
  const lastFile = files.at(-1);
  const extension = lastFile ? path.extname(lastFile).slice(1) : undefined;
  return { framework: detectFramework(sample), extension, commonJs: /\bmodule\.exports\b|\bexports\.\w+/.test(sample) };
}

function sqlFolderStyle(
  root: string,
  directory: string,
): FlywayLayout | GolangMigrateLayout | PlainSqlLayout | undefined {
  const files = listFiles(path.join(root, directory)).filter((name) => name.endsWith('.sql'));
  if (!files.length) return;
  const flyway = files.flatMap((name) => /^V(\d+)__/.exec(name)?.[1] ?? []);
  if (flyway.length) return { tool: 'flyway', directory, next: Math.max(...flyway.map(Number)) + 1 };
  const golang = files.flatMap((name) => /^(\d+)_.+\.up\.sql$/.exec(name)?.[1] ?? []);
  if (golang.length) {
    const next = String(Math.max(...golang.map(Number)) + 1).padStart(golang[0].length, '0');
    return { tool: 'golang-migrate', directory, next };
  }
  return { tool: 'sql', directory };
}

function sqlLayout(root: string): FlywayLayout | GolangMigrateLayout | PlainSqlLayout {
  if (DRIZZLE_CONFIGS.some((config) => exists(path.join(root, config)))) {
    return { tool: 'sql', directory: 'migrations', reason: 'drizzle' };
  }
  for (const directory of SQL_MIGRATION_DIRECTORIES) {
    const style = sqlFolderStyle(root, directory);
    if (style) return style;
  }
  return { tool: 'sql', directory: 'migrations', reason: 'none' };
}

function relationalLayout(root: string): MigrationLayout {
  const prisma = prismaDirectory(root);
  if (prisma) return { tool: 'prisma', directory: prisma };
  const knex = configuredDirectory(root, KNEX_CONFIGS, 'directory');
  if (knex) {
    const style = codeMigrationStyle(root, knex.directory);
    const extension = style.extension ?? path.extname(knex.config).slice(1);
    return { tool: 'knex', directory: knex.directory, extension, commonJs: style.commonJs || extension === 'cjs' };
  }
  const sequelize = configuredDirectory(root, ['.sequelizerc'], 'migrations-path');
  if (sequelize) return { tool: 'sequelize', directory: sequelize.directory };
  for (const directory of CODE_MIGRATION_DIRECTORIES) {
    const style = codeMigrationStyle(root, directory);
    if (style.framework === 'typeorm') return { tool: 'typeorm', directory, ...style };
    if (style.framework === 'sequelize') return { tool: 'sequelize', directory };
    if (style.framework === 'knex') return { tool: 'knex', directory, ...style };
  }
  return sqlLayout(root);
}

function mongoLayout(root: string): MongoLayout {
  const migrateMongo = configuredDirectory(root, MONGO_CONFIGS, 'migrationsDir');
  return migrateMongo
    ? { tool: 'migrate-mongo', directory: migrateMongo.directory }
    : { tool: 'mongosh', directory: 'migrations' };
}

// --- File contents
// -------------------------------------------------------------------------------------------------

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function compactTimestamp(now: Date): string {
  const date = [now.getUTCFullYear(), pad(now.getUTCMonth() + 1), pad(now.getUTCDate())].join('');
  return date + [pad(now.getUTCHours()), pad(now.getUTCMinutes()), pad(now.getUTCSeconds())].join('');
}

function snakeName(change: IndexChange): string {
  const words = `${change.action}_${change.indexName}`.toLowerCase().replaceAll(/[^a-z0-9]+/g, '_');
  return words.replaceAll(/^_+|_+$/g, '').slice(0, MAX_NAME_LENGTH);
}

function pascalName(change: IndexChange): string {
  return snakeName(change)
    .split('_')
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join('');
}

// A JS string holding the SQL: a template literal when nothing in it needs escaping there.
function jsString(sql: string): string {
  return /[`\\]|\$\{/.test(sql) ? JSON.stringify(sql) : '`' + sql + '`';
}

function needsNoTransaction(change: IndexChange): boolean {
  return change.engine === 'postgres' && change.up.includes('CONCURRENTLY');
}

function downBody(change: SqlIndexChange, call: string, indentation: string): string {
  if (change.down) return `${indentation}await ${call}(${jsString(change.down.replace(/;$/, ''))});`;
  return `${indentation}// ${change.downHint}`;
}

function sqlFile(change: SqlIndexChange, ruleId: string): string {
  return `-- ${ruleId}: generated by loadwise perf\n${change.up}\n`;
}

function typeormFile(change: SqlIndexChange, layout: TypeormLayout, now: Date): MigrationFile {
  const className = pascalName(change) + now.getTime();
  const extension = layout.extension ?? 'ts';
  const typed = extension === 'ts';
  const runner = typed ? 'queryRunner: QueryRunner' : 'queryRunner';
  const returns = typed ? ': Promise<void>' : '';
  const visibility = typed ? 'public ' : '';
  const header = typed
    ? `import { MigrationInterface, QueryRunner } from 'typeorm';\n\nexport class ${className} implements MigrationInterface {`
    : layout.commonJs
      ? `module.exports = class ${className} {`
      : `export class ${className} {`;
  const lines = [
    header,
    `  name = '${className}';`,
    ...(needsNoTransaction(change) ? ['  transaction = false;'] : []),
    '',
    `  ${visibility}async up(${runner})${returns} {`,
    `    await queryRunner.query(${jsString(change.up.replace(/;$/, ''))});`,
    '  }',
    '',
    `  ${visibility}async down(${runner})${returns} {`,
    downBody(change, 'queryRunner.query', '    '),
    '  }',
    layout.commonJs && !typed ? '};' : '}',
  ];
  return { name: `${now.getTime()}-${pascalName(change)}.${extension}`, text: lines.join('\n') + '\n' };
}

function knexFile(change: SqlIndexChange, layout: KnexLayout, now: Date): MigrationFile {
  const extension = layout.extension ?? 'js';
  const typed = extension === 'ts';
  const commonJs = !typed && layout.commonJs !== false && extension !== 'mjs';
  const parameter = typed ? 'knex: Knex' : 'knex';
  const returns = typed ? ': Promise<void>' : '';
  const exported = (name: string): string =>
    commonJs
      ? `exports.${name} = async function (${parameter}) {`
      : `export async function ${name}(${parameter})${returns} {`;
  const close = commonJs ? '};' : '}';
  const lines = [
    ...(typed ? ["import type { Knex } from 'knex';", ''] : []),
    ...(needsNoTransaction(change)
      ? [commonJs ? 'exports.config = { transaction: false };' : 'export const config = { transaction: false };', '']
      : []),
    exported('up'),
    `  await knex.raw(${jsString(change.up.replace(/;$/, ''))});`,
    close,
    '',
    exported('down'),
    downBody(change, 'knex.raw', '  '),
    close,
  ];
  return { name: `${compactTimestamp(now)}_${snakeName(change)}.${extension}`, text: lines.join('\n') + '\n' };
}

function sequelizeFile(change: SqlIndexChange, now: Date): MigrationFile {
  const lines = [
    "'use strict';",
    '',
    'module.exports = {',
    '  async up(queryInterface) {',
    `    await queryInterface.sequelize.query(${jsString(change.up.replace(/;$/, ''))});`,
    '  },',
    '',
    '  async down(queryInterface) {',
    downBody(change, 'queryInterface.sequelize.query', '    '),
    '  },',
    '};',
  ];
  return {
    name: `${compactTimestamp(now)}-${snakeName(change).replaceAll('_', '-')}.js`,
    text: lines.join('\n') + '\n',
  };
}

function mongoFiles(change: MongoIndexChange, layout: MigrationLayout, now: Date): MigrationFile[] {
  const collection = JSON.stringify(change.collection);
  const index = JSON.stringify(change.indexName);
  const name = `${compactTimestamp(now)}-${snakeName(change).replaceAll('_', '-')}`;
  if (layout.tool === 'mongosh') {
    return [{ name: `${name}.mongosh.js`, text: `db.getCollection(${collection}).dropIndex(${index});\n` }];
  }
  const down = change.key
    ? `    await db.collection(${collection}).createIndex(${JSON.stringify(change.key)}, { name: ${index} });`
    : '    // Recreate the index from its getIndexes() entry, saved before this migration ran.';
  const lines = [
    'module.exports = {',
    '  async up(db) {',
    `    await db.collection(${collection}).dropIndex(${index});`,
    '  },',
    '',
    '  async down(db) {',
    down,
    '  },',
    '};',
  ];
  return [{ name: `${name}.js`, text: lines.join('\n') + '\n' }];
}

function sqlFolderFiles(
  change: SqlIndexChange,
  layout: SqlFolderLayout | MongoLayout,
  ruleId: string,
  now: Date,
): MigrationFile[] {
  if (layout.tool === 'prisma') {
    return [{ name: `${compactTimestamp(now)}_${snakeName(change)}/migration.sql`, text: sqlFile(change, ruleId) }];
  }
  if (layout.tool === 'flyway')
    return [{ name: `V${layout.next}__${snakeName(change)}.sql`, text: sqlFile(change, ruleId) }];
  if (layout.tool === 'golang-migrate') {
    const base = `${layout.next}_${snakeName(change)}`;
    const files = [{ name: `${base}.up.sql`, text: change.up + '\n' }];
    if (change.down) files.push({ name: `${base}.down.sql`, text: change.down + '\n' });
    return files;
  }
  return [{ name: `${compactTimestamp(now)}_${snakeName(change)}.sql`, text: sqlFile(change, ruleId) }];
}

function migrationFiles(change: IndexChange, layout: MigrationLayout, ruleId: string, now: Date): MigrationFile[] {
  if (change.engine === 'mongo') return mongoFiles(change, layout, now);
  if (layout.tool === 'typeorm') return [typeormFile(change, layout, now)];
  if (layout.tool === 'knex') return [knexFile(change, layout, now)];
  if (layout.tool === 'sequelize') return [sequelizeFile(change, now)];
  return sqlFolderFiles(change, layout, ruleId, now);
}

// --- Notes
// ---------------------------------------------------------------------------------------------------------

function layoutNote(change: IndexChange, layout: MigrationLayout): string | undefined {
  const concurrent = needsNoTransaction(change);
  if (layout.tool === 'prisma') {
    return change.action === 'add'
      ? `Also declare it in schema.prisma (\`@@index([...], map: "${change.indexName}")\`), or the next \`prisma migrate dev\` sees drift and drops it.`
      : 'Also remove the matching `@@index` from schema.prisma, or the next `prisma migrate dev` recreates it.';
  }
  if (layout.tool === 'typeorm' && concurrent) return TYPEORM_TRANSACTION_NOTE;
  if (layout.tool === 'mongosh')
    return 'No migrate-mongo config was found: run the script with `mongosh <connection-uri> <file>`.';
  if (layout.tool === 'sql' && layout.reason === 'drizzle') {
    return concurrent
      ? "Drizzle's migrator runs every migration in a transaction, where CONCURRENTLY fails: run this file with psql, outside the migrator."
      : 'Run this file with your SQL client; it is not part of the Drizzle journal.';
  }
  if (layout.tool === 'sql' && layout.reason === 'none') {
    return `No migration tool was detected: run this file with your SQL client${concurrent ? ', outside a transaction' : ''}.`;
  }
}

function actionNote(finding: Finding, change: IndexChange): string {
  if (change.action === 'drop') {
    return 'Check the index is unused on every replica too, and save its definition before dropping it so it can be restored.';
  }
  const unvalidated =
    finding.ruleId === 'db-slow-query-plan' &&
    'Unvalidated: confirm the planner switches to this index with HypoPG or `db --measure` on staging before shipping it.';
  return [unvalidated, INVALID_INDEX_NOTE].filter(Boolean).join(' ');
}

// --- Builder
// -------------------------------------------------------------------------------------------------------

function toPosix(file: string): string {
  return file.split(path.sep).join('/');
}

function newMigration({ finding, root, now = new Date() }: MigrationInput): FixResult | undefined {
  // A plan whose hypothetical index did not help names no index worth adding; a MySQL scan names no
  // columns.
  if (/did not change the plan/.test(finding.message ?? '')) return;
  const change = requestedChange(finding);
  if (!change) return;
  const projectRoot = root ?? process.cwd();
  const layout = change.engine === 'mongo' ? mongoLayout(projectRoot) : relationalLayout(projectRoot);
  const targets = migrationFiles(change, layout, finding.ruleId, now).map(({ name, text }): FileTarget => {
    const relative = toPosix(path.join(layout.directory, name));
    return { file: root ? path.join(root, relative) : relative, create: true, text };
  });
  const note = [layoutNote(change, layout), actionNote(finding, change)].filter(Boolean).join(' ');
  return { targets, note };
}

// A schema change the project's schema files may not declare, which locks tables while it runs, and
// which can drop an index.
const reviewedMigration = requireReview(
  'Adds a schema migration (index or drop) that locks tables and may not match the schema files.',
  newMigration,
);

export default {
  'db-unindexed-foreign-key': reviewedMigration,
  'db-missing-index': reviewedMigration,
  'db-slow-query-plan': reviewedMigration,
  'db-unused-index': reviewedMigration,
  'db-duplicate-index': reviewedMigration,
};
