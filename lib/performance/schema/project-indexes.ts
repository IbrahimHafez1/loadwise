import fs from 'node:fs';
import path from 'node:path';
import { findProjectRoot } from './context.js';
import { migrationEvents, tableKey, tableSpelling } from './project-indexes-events.js';
import type { MigrationEvent } from './project-indexes-events.js';
import type { Dirent } from 'node:fs';
import type { IndexCreation, LiveIndex, MigrationDeclarations, MigrationTableEntry } from '../types/project-indexes.js';

interface MigrationScan {
  directories: string[];
  stamp: string;
  tables: Map<string, MigrationTableEntry>;
  live: LiveIndex[];
  opaqueTables: Set<string>;
}

interface CachedScan {
  result: MigrationScan;
  checkedAt: number;
}

interface PackageManifest {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

const postgresDrivers = ['pg', 'postgres', 'pg-promise', '@neondatabase/serverless', '@vercel/postgres'];
const mysqlDrivers = ['mysql', 'mysql2', 'mariadb'];
const skippedDirectories = new Set(['node_modules', 'dist', 'build', 'coverage', 'out']);
const migrationDirectory = /^migrations?$/i;
const migrationFile = /\.(?:sql|[cm]?[jt]s)$/;
// Migration folders sit near the project root; deeper trees are vendored code or build output.
const maxSearchDepth = 6;
// A generated dump this large is not a hand-written migration and would slow every scan.
const maxMigrationBytes = 2 * 1024 * 1024;
const revalidateAfterMilliseconds = 2000;
const roots = new Map<string, string>();
const migrationCache = new Map<string, CachedScan>();

// The project that owns a file; generated clients inside node_modules belong to the project around
// them.
function projectRootOf(filename: string): string {
  const normalized = filename.replaceAll('\\', '/');
  const marker = normalized.indexOf('/node_modules/');
  const start = marker < 0 ? path.dirname(filename) : normalized.slice(0, marker);
  const known = roots.get(start);
  if (known !== undefined) return known;
  const root = findProjectRoot(start);
  roots.set(start, root);
  return root;
}

function readManifest(root: string): PackageManifest | undefined {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return undefined;
  }
}

// A project with exactly one family of SQL drivers; anything else is ambiguous.
function projectDialect(root: string): 'postgres' | 'mysql' | undefined {
  const manifest = readManifest(root);
  const dependencies = { ...manifest?.dependencies, ...manifest?.devDependencies };
  const postgres = postgresDrivers.some((name) => Object.hasOwn(dependencies, name));
  const mysql = mysqlDrivers.some((name) => Object.hasOwn(dependencies, name));
  if (postgres !== mysql) return postgres ? 'postgres' : 'mysql';
}

function entryFor(tables: Map<string, MigrationTableEntry>, name: string): MigrationTableEntry {
  const key = tableKey(name);
  const existing = tables.get(key);
  if (existing) return existing;
  const created: MigrationTableEntry = {
    opaque: false,
    indexes: [],
    others: [],
    mentioned: new Set(),
    expressionColumns: new Set(),
    patternColumns: new Set(),
  };
  tables.set(key, created);
  return created;
}

// A plain btree over columns counts as coverage; partial and other methods only silence rules,
// through
// `mentioned` (any plain column they touch) and `others` (their key lists). Columns inside
// expression keys go to
// `expressionColumns` instead, because a plain filter on the column cannot use such an index.
function recordIndex(
  tables: Map<string, MigrationTableEntry>,
  { table, keys, unique, method = 'btree', partial }: IndexCreation,
): void {
  const entry = entryFor(tables, table);
  for (const key of keys) {
    if (key.column && /_trgm_ops$|_pattern_ops$/.test(key.opclass ?? '')) entry.patternColumns.add(key.column);
  }
  if (method.toLowerCase() === 'btree' && !partial && keys.every((key) => key.column && !key.opclass)) {
    entry.indexes.push({ keys: keys.map((key) => ({ column: key.column })), unique, primary: false, method: 'btree' });
    return;
  }
  entry.others.push({ keys: keys.map((key) => ({ column: key.column, columns: key.columns })), method, partial });
  for (const key of keys) {
    if (key.column) entry.mentioned.add(key.column);
    for (const column of key.columns ?? []) entry.expressionColumns.add(column);
  }
}

function migrationDirectories(root: string): string[] {
  const found: string[] = [];
  function visit(directory: string, depth: number): void {
    let entries: Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || skippedDirectories.has(entry.name)) continue;
      const child = path.join(directory, entry.name);
      if (migrationDirectory.test(entry.name)) found.push(child);
      else if (depth < maxSearchDepth) visit(child, depth + 1);
    }
  }
  visit(root, 0);
  return found;
}

// A folder can disappear between discovery and reading (another process cleaning up); it then has
// no files.
function entriesOf(directory: string): Dirent[] {
  try {
    return fs.readdirSync(directory, { withFileTypes: true, recursive: true });
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return [];
    throw error;
  }
}

// A `baseline` folder holds the schema the dated migrations start from, so it replays first. Node
// before 20.12 names a directory entry's folder `path`, which the current typings no longer
// declare.
function direntFolder(entry: Dirent): string {
  if (entry.parentPath !== undefined) return entry.parentPath;
  return 'path' in entry && typeof entry.path === 'string' ? entry.path : '';
}

function isBaseline(filename: string) {
  return filename.split(/[\\/]/).includes('baseline');
}

function compareReplayOrder(left: string, right: string): number {
  const baselineOrder = Number(isBaseline(right)) - Number(isBaseline(left));
  if (baselineOrder) return baselineOrder;
  return left < right ? -1 : left > right ? 1 : 0;
}

function migrationFiles(directories: string[]): string[] {
  return directories.flatMap((directory: string) =>
    entriesOf(directory)
      .filter((entry) => entry.isFile() && migrationFile.test(entry.name) && !entry.name.endsWith('.d.ts'))
      .map((entry) => path.join(direntFolder(entry), entry.name))
      .sort(compareReplayOrder),
  );
}

function stamp(directories: string[]): string {
  return directories
    .map((directory: string) => directory + ':' + (fs.statSync(directory, { throwIfNoEntry: false })?.mtimeMs ?? -1))
    .join('|');
}

// The innermost migrations folder holding a file; tables with the same name in different folders
// are unrelated.
function owningDirectory(directories: string[], filename: string): string | undefined {
  return directories
    .filter((directory: string) => filename.startsWith(directory))
    .sort((a, b) => b.length - a.length)[0];
}

function indexIncludesColumn(index: LiveIndex, columns: string[]): boolean {
  return index.keys.some(
    (key) =>
      (key.column !== undefined && columns.includes(key.column)) ||
      key.columns?.some((column) => columns.includes(column)),
  );
}

// The indexes live after one migration step. Returns a new list for a create or drop and mutates
// `opaqueTables` for steps that hide a table's indexes.
function applyMigrationEvent(
  live: LiveIndex[],
  event: MigrationEvent,
  { filename, directory }: { filename: string; directory: string | undefined },
  opaqueTables: Set<string>,
): LiveIndex[] {
  // A dropped or renamed table is the one created in the same migrations folder.
  const onTable = (index: LiveIndex, table: string) => index.directory === directory && tableKey(index.table) === table;
  const { create, dropTables, drop } = event;
  if (event.opaque) {
    opaqueTables.add(tableKey(event.opaque));
    return live;
  }
  if (create) {
    // An index of the same name on the table is replaced, not added next to itself.
    const kept = create.name
      ? live.filter(
          (index) =>
            index.name !== create.name ||
            index.directory !== directory ||
            tableKey(index.table) !== tableKey(create.table),
        )
      : live;
    kept.push({ ...create, file: filename, at: event.at, directory });
    return kept;
  }
  if (dropTables) return live.filter((index) => !dropTables.some((table) => onTable(index, table)));
  if (event.dropColumns) {
    const { table, columns } = event.dropColumns;
    return live.filter((index) => !onTable(index, table) || !indexIncludesColumn(index, columns));
  }
  if (event.rename) {
    for (const index of live) if (onTable(index, event.rename.from)) index.table = event.rename.to;
    return live;
  }
  return live.filter((index) => !index.name || !(drop ?? []).includes(index.name));
}

function scanMigrations(root: string): MigrationScan {
  const directories = migrationDirectories(root);
  // Indexes in creation order; a later drop removes those with its name.
  let live: LiveIndex[] = [];
  const opaqueTables = new Set<string>();
  for (const filename of migrationFiles(directories)) {
    const size = fs.statSync(filename, { throwIfNoEntry: false })?.size ?? 0;
    if (size > maxMigrationBytes) continue;
    const directory = owningDirectory(directories, filename);
    for (const event of migrationEvents(fs.readFileSync(filename, 'utf8'), filename)) {
      live = applyMigrationEvent(live, event, { filename, directory }, opaqueTables);
    }
  }
  const tables = new Map<string, MigrationTableEntry>();
  for (const index of live) recordIndex(tables, index);
  for (const table of opaqueTables) entryFor(tables, table).opaque = true;
  return { directories, stamp: stamp(directories), tables, live, opaqueTables };
}

function migrationScan(root: string): MigrationScan {
  const cached = migrationCache.get(root);
  const now = Date.now();
  if (cached && now - cached.checkedAt < revalidateAfterMilliseconds) return cached.result;
  if (cached && stamp(cached.result.directories) === cached.result.stamp) {
    cached.checkedAt = now;
    return cached.result;
  }
  const result = scanMigrations(root);
  migrationCache.set(root, { result, checkedAt: now });
  return result;
}

// Indexes that migrations create, keyed by lower-case table name. Entities in TypeORM-style
// projects often omit indexes that a hand-written migration adds, so these silence the rules rather
// than being trusted blindly.
function migrationIndexes(root: string): Map<string, MigrationTableEntry> {
  return migrationScan(root).tables;
}

// The indexes still live after every migration, each with its file and character offset, for rules
// that report at the declaration. `opaqueTables` lists tables whose index set is not fully read.
function migrationDeclarations(root: string): MigrationDeclarations {
  const { live, opaqueTables } = migrationScan(root);
  return { indexes: live, opaqueTables };
}

export {
  direntFolder,
  projectRootOf,
  projectDialect,
  migrationIndexes,
  migrationDeclarations,
  tableKey,
  tableSpelling,
};
