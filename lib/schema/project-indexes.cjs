'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { findProjectRoot } = require('./context.cjs');

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
const roots = new Map();
const migrationCache = new Map();

// The project that owns a file; generated clients inside node_modules belong to the project around them.
function projectRootOf(filename) {
  const normalized = filename.replaceAll('\\', '/');
  const marker = normalized.indexOf('/node_modules/');
  const start = marker < 0 ? path.dirname(filename) : normalized.slice(0, marker);
  if (!roots.has(start)) roots.set(start, findProjectRoot(start));
  return roots.get(start);
}

function readManifest(root) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return undefined;
  }
}

// A project with exactly one family of SQL drivers; anything else is ambiguous.
function projectDialect(root) {
  const manifest = readManifest(root);
  const dependencies = { ...manifest?.dependencies, ...manifest?.devDependencies };
  const postgres = postgresDrivers.some((name) => Object.hasOwn(dependencies, name));
  const mysql = mysqlDrivers.some((name) => Object.hasOwn(dependencies, name));
  if (postgres !== mysql) return postgres ? 'postgres' : 'mysql';
}

function unquote(identifier) {
  return identifier.trim().replace(/^[`"[]|[`"\]]$/g, '');
}

function tableKey(name) {
  return unquote(name.split('.').at(-1)).toLowerCase();
}

function closingParenthesis(text, open) {
  let depth = 0;
  for (let index = open; index < text.length; index++) {
    if (text[index] === '(') depth++;
    else if (text[index] === ')' && --depth === 0) return index;
  }
  return -1;
}

function splitTopLevel(text) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < text.length; index++) {
    if (text[index] === '(') depth++;
    else if (text[index] === ')') depth--;
    else if (text[index] === ',' && depth === 0) {
      parts.push(text.slice(start, index).trim());
      start = index + 1;
    }
  }
  parts.push(text.slice(start).trim());
  return parts.filter(Boolean);
}

// `"col" text_pattern_ops DESC` -> { column, opclass }; anything with parentheses is an expression.
function readKey(item) {
  if (item.includes('(')) {
    const columns = [...item.matchAll(/[`"]?([A-Za-z_]\w*)[`"]?/g)].map((match) => match[1].toLowerCase());
    return { expression: item, columns };
  }
  const [name, ...rest] = item.split(/\s+/);
  const opclass = rest.find((word) => !/^(?:asc|desc|nulls|first|last|collate)$/i.test(word));
  return { column: unquote(name).toLowerCase(), opclass: opclass?.toLowerCase() };
}

function entryFor(tables, name) {
  const key = tableKey(name);
  if (!tables.has(key)) tables.set(key, { indexes: [], mentioned: new Set(), patternColumns: new Set() });
  return tables.get(key);
}

// A plain btree over columns counts as coverage; partial, expression and other methods only silence rules.
function recordIndex(tables, { table, keys, unique, method = 'btree', partial }) {
  const entry = entryFor(tables, table);
  for (const key of keys) {
    if (key.column && /_trgm_ops$|_pattern_ops$/.test(key.opclass ?? '')) entry.patternColumns.add(key.column);
  }
  if (method.toLowerCase() === 'btree' && !partial && keys.every((key) => key.column && !key.opclass)) {
    entry.indexes.push({ keys: keys.map((key) => ({ column: key.column })), unique, primary: false, method: 'btree' });
    return;
  }
  for (const key of keys) {
    for (const column of key.columns ?? [key.column]) entry.mentioned.add(column);
  }
}

const createIndexPattern =
  /CREATE\s+(UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?(?:[`"\w.]+\s+)?ON\s+(?:ONLY\s+)?([`"\w.]+)\s*(?:USING\s+(\w+)\s*)?\(/gi;
const alterConstraintPattern =
  /ALTER\s+TABLE\s+(?:ONLY\s+)?(?:IF\s+EXISTS\s+)?([`"\w.]+)\s+ADD\s+(?:CONSTRAINT\s+[`"\w]+\s+)?(UNIQUE(?:\s+(?:KEY|INDEX))?|PRIMARY\s+KEY|INDEX|KEY)\s*(?:[`"\w]+\s*)?\(/gi;
const addIndexPattern = /addIndex\(\s*['"`]([\w.]+)['"`]\s*,/g;

function readCreateIndexes(text, tables) {
  for (const match of text.matchAll(createIndexPattern)) {
    const open = match.index + match[0].length - 1;
    const close = closingParenthesis(text, open);
    if (close < 0) continue;
    const keys = splitTopLevel(text.slice(open + 1, close)).map(readKey);
    const tail = text.slice(close + 1, close + 200);
    const partial = /^\s*(?:INCLUDE\s*\([^)]*\)\s*)?(?:WITH\s*\([^)]*\)\s*)?WHERE\b/i.test(tail);
    recordIndex(tables, { table: match[2], keys, unique: Boolean(match[1]), method: match[3], partial });
  }
  for (const match of text.matchAll(alterConstraintPattern)) {
    const open = match.index + match[0].length - 1;
    const close = closingParenthesis(text, open);
    if (close < 0) continue;
    const keys = splitTopLevel(text.slice(open + 1, close)).map(readKey);
    recordIndex(tables, { table: match[1], keys, unique: /UNIQUE|PRIMARY/i.test(match[2]) });
  }
}

// Sequelize `queryInterface.addIndex('Table', ['a', 'b'], { ... })` or `addIndex('Table', { fields: [...] })`.
function readAddIndexes(text, tables) {
  for (const match of text.matchAll(addIndexPattern)) {
    const open = match.index + match[0].indexOf('(');
    const close = closingParenthesis(text, open);
    if (close < 0) continue;
    const call = text.slice(open + 1, close);
    const list = /\[([^\]]*)\]/.exec(call.slice(call.indexOf(',') + 1));
    if (!list) continue;
    const columns = [...list[1].matchAll(/['"`](\w+)['"`]/g)].map((item) => item[1].toLowerCase());
    if (!columns.length) continue;
    const keys = columns.map((column) => ({ column }));
    const special = /\bwhere\b|\busing\b|\boperator\b|fulltext/i.test(call);
    recordIndex(tables, { table: match[1], keys, unique: /unique\s*:\s*true/.test(call), partial: special });
  }
}

function migrationDirectories(root) {
  const found = [];
  function visit(directory, depth) {
    let entries;
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

function migrationFiles(directories) {
  return directories.flatMap((directory) =>
    fs
      .readdirSync(directory, { withFileTypes: true, recursive: true })
      .filter((entry) => entry.isFile() && migrationFile.test(entry.name) && !entry.name.endsWith('.d.ts'))
      .map((entry) => path.join(entry.parentPath ?? entry.path, entry.name))
      .sort(),
  );
}

function stamp(directories) {
  return directories
    .map((directory) => directory + ':' + (fs.statSync(directory, { throwIfNoEntry: false })?.mtimeMs ?? -1))
    .join('|');
}

function scanMigrations(root) {
  const directories = migrationDirectories(root);
  const tables = new Map();
  for (const filename of migrationFiles(directories)) {
    const size = fs.statSync(filename, { throwIfNoEntry: false })?.size ?? 0;
    if (size > maxMigrationBytes) continue;
    const text = fs.readFileSync(filename, 'utf8');
    readCreateIndexes(text, tables);
    readAddIndexes(text, tables);
  }
  return { directories, stamp: stamp(directories), tables };
}

// Indexes that migrations create, keyed by lower-case table name. Entities in TypeORM-style projects often
// omit indexes that a hand-written migration adds, so these silence the rules rather than being trusted blindly.
function migrationIndexes(root) {
  const cached = migrationCache.get(root);
  const now = Date.now();
  if (cached && now - cached.checkedAt < revalidateAfterMilliseconds) return cached.result.tables;
  if (cached && stamp(cached.result.directories) === cached.result.stamp) {
    cached.checkedAt = now;
    return cached.result.tables;
  }
  const result = scanMigrations(root);
  migrationCache.set(root, { result, checkedAt: now });
  return result.tables;
}

module.exports = { projectRootOf, projectDialect, migrationIndexes, tableKey };
