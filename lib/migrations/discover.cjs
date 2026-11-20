'use strict';

const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const SKIPPED_DIRECTORIES = new Set(['node_modules', 'dist', 'build', 'coverage']);
const MIGRATION_EXTENSION = /\.(?:sql|[cm]?[jt]s)$/i;
const NON_MIGRATION_FILE = /\.d\.[cm]?ts$|[.-](?:spec|test)\.[cm]?[jt]s$/i;
const DRIZZLE_CONFIGS = ['drizzle.config.ts', 'drizzle.config.js', 'drizzle.config.mjs', 'drizzle.config.cjs'];
const KNEX_CONFIGS = ['knexfile.ts', 'knexfile.js', 'knexfile.mjs', 'knexfile.cjs'];
const POSTGRES_PACKAGES = ['pg', 'postgres', 'pg-promise', 'pg-native', '@neondatabase/serverless', '@vercel/postgres'];
const MYSQL_PACKAGES = ['mysql2', 'mysql', 'mariadb', '@planetscale/database'];
const DIALECT_NAMES = {
  postgresql: 'postgres',
  postgres: 'postgres',
  pg: 'postgres',
  cockroachdb: 'postgres',
  mysql: 'mysql',
  mariadb: 'mysql',
  singlestore: 'mysql',
};

function isDirectory(target) {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function isSkippedDirectory(name) {
  return name.startsWith('.') || SKIPPED_DIRECTORIES.has(name);
}

function isMigrationFile(name) {
  return MIGRATION_EXTENSION.test(name) && !NON_MIGRATION_FILE.test(name);
}

// Linked files are read (some projects link migrations in); linked directories are not followed, to avoid cycles.
function isSymlinkedFile(entry, target) {
  if (!entry.isSymbolicLink()) return false;
  try {
    return fs.statSync(target).isFile();
  } catch {
    return false;
  }
}

function listFilesRecursively(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!isSkippedDirectory(entry.name)) files.push(...listFilesRecursively(target));
    } else if (isMigrationFile(entry.name) && (entry.isFile() || isSymlinkedFile(entry, target))) files.push(target);
  }
  return files;
}

function findMigrationDirectories(root) {
  const found = [];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || isSkippedDirectory(entry.name)) continue;
      const target = path.join(directory, entry.name);
      if (entry.name.toLowerCase() === 'migrations') found.push(target);
      else walk(target);
    }
  };
  walk(root);
  return found;
}

// String-valued properties of object literals in a config module, read without executing it.
function readConfigStrings(file, propertyNames) {
  const text = readText(file);
  if (text === null) return {};
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const values = {};
  const visit = (node) => {
    if (ts.isPropertyAssignment(node)) {
      const name = ts.isIdentifier(node.name) || ts.isStringLiteral(node.name) ? node.name.text : null;
      if (name && propertyNames.includes(name)) {
        const strings = collectStrings(node.initializer);
        if (strings.length > 0) (values[name] ??= []).push(strings.join('/'));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return values;
}

// `'dir'` or `path.resolve(__dirname, 'db', 'migrations')`: the literal parts in order.
function collectStrings(node) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return [node.text];
  if (ts.isCallExpression(node)) return node.arguments.flatMap(collectStrings);
  return [];
}

function normalizeDialect(name) {
  return DIALECT_NAMES[String(name ?? '').toLowerCase()] ?? null;
}

function prismaProvider(migrationsDirectory) {
  const lock = readText(path.join(migrationsDirectory, 'migration_lock.toml'));
  const provider = lock && /^\s*provider\s*=\s*"([^"]+)"/m.exec(lock);
  return provider ? provider[1] : null;
}

function prismaGroups(root) {
  const packageJson = readJson(path.join(root, 'package.json'));
  const schemaPath = packageJson?.prisma?.schema;
  const candidates = [
    schemaPath ? path.resolve(root, path.dirname(schemaPath)) : null,
    path.join(root, 'prisma'),
    root,
  ].filter(Boolean);
  for (const directory of candidates) {
    const migrations = path.join(directory, 'migrations');
    if (!isDirectory(migrations) || !fs.existsSync(path.join(migrations, 'migration_lock.toml'))) continue;
    const provider = prismaProvider(migrations);
    const files = fs
      .readdirSync(migrations, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(migrations, entry.name, 'migration.sql'))
      .filter((file) => fs.existsSync(file));
    return [{ framework: 'prisma', directory: migrations, provider, dialect: normalizeDialect(provider), files }];
  }
  return [];
}

function drizzleGroups(root) {
  for (const name of DRIZZLE_CONFIGS) {
    const config = path.join(root, name);
    if (!fs.existsSync(config)) continue;
    const values = readConfigStrings(config, ['out', 'dialect', 'driver']);
    const dialectName = values.dialect?.[0] ?? values.driver?.[0] ?? null;
    const directory = path.resolve(root, values.out?.[0] ?? 'drizzle');
    const group = { framework: 'drizzle', directory, provider: dialectName, dialect: normalizeDialect(dialectName) };
    if (!isDirectory(directory)) return [{ ...group, files: [] }];
    const files = fs
      .readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.sql'))
      .map((entry) => path.join(directory, entry.name));
    return [{ ...group, files }];
  }
  return [];
}

function configuredDirectories(root) {
  const directories = [];
  for (const name of KNEX_CONFIGS) {
    const values = readConfigStrings(path.join(root, name), ['directory']);
    for (const directory of values.directory ?? []) directories.push(path.resolve(root, directory));
  }
  const sequelize = readConfigStrings(path.join(root, '.sequelizerc'), ['migrations-path']);
  for (const directory of sequelize['migrations-path'] ?? []) directories.push(path.resolve(root, directory));
  return directories.filter(isDirectory);
}

function readJson(file) {
  const text = readText(file);
  if (text === null) return null;
  try {
    return JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

// Dialects declared by the nearest package.json that names a database driver.
function packageDialects(startDirectory) {
  for (let directory = path.resolve(startDirectory); ; directory = path.dirname(directory)) {
    const packageJson = readJson(path.join(directory, 'package.json'));
    if (packageJson) {
      const dependencies = { ...packageJson.dependencies, ...packageJson.devDependencies };
      const dialects = new Set();
      if (POSTGRES_PACKAGES.some((name) => name in dependencies)) dialects.add('postgres');
      if (MYSQL_PACKAGES.some((name) => name in dependencies)) dialects.add('mysql');
      if (dialects.size > 0) return [...dialects];
    }
    if (path.dirname(directory) === directory) return [];
  }
}

function resolveProjectDialect(root, groups) {
  const fromConfigs = new Set(groups.map((group) => group.dialect).filter(Boolean));
  const fromPackages = packageDialects(root);
  const candidates = fromPackages.length > 0 ? new Set(fromPackages) : fromConfigs;
  if (candidates.size === 1) return [...candidates][0];
  if (candidates.size > 1) {
    throw new Error('This project uses both Postgres and MySQL drivers. Pass --dialect postgres or --dialect mysql.');
  }
  throw new Error('Cannot tell the database dialect of these migrations. Pass --dialect postgres or --dialect mysql.');
}

function sortedUnique(files) {
  return [...new Set(files.map((file) => path.resolve(file)))].sort((left, right) =>
    left.localeCompare(right, 'en', { numeric: true }),
  );
}

// Prisma and Drizzle folders are recognized by their files, so explicit paths get the same framework.
function frameworkForSqlFile(file, drizzleDirectories) {
  const directory = path.dirname(file);
  if (path.basename(file) === 'migration.sql' && fs.existsSync(path.join(directory, '..', 'migration_lock.toml'))) {
    return 'prisma';
  }
  if (drizzleDirectories.has(directory) || fs.existsSync(path.join(directory, 'meta', '_journal.json'))) {
    return 'drizzle';
  }
  return 'sql';
}

function groupFiles(root, groups, explicitDialect, hintGroups = groups) {
  const drizzleDirectories = new Set(
    groups.filter((group) => group.framework === 'drizzle').map((group) => group.directory),
  );
  let projectDialect = null;
  const dialectFor = (group) => {
    if (explicitDialect) return explicitDialect;
    if (group.dialect) return group.dialect;
    projectDialect ??= resolveProjectDialect(root, hintGroups);
    return projectDialect;
  };
  const files = new Map();
  for (const group of groups) {
    for (const file of sortedUnique(group.files)) {
      if (files.has(file)) continue;
      const framework = file.toLowerCase().endsWith('.sql') ? frameworkForSqlFile(file, drizzleDirectories) : 'code';
      const prismaDialect =
        framework === 'prisma' ? normalizeDialect(prismaProvider(path.dirname(path.dirname(file)))) : null;
      files.set(file, { path: file, framework, dialect: explicitDialect ?? prismaDialect ?? dialectFor(group) });
    }
  }
  return [...files.values()].sort((left, right) => left.path.localeCompare(right.path, 'en', { numeric: true }));
}

function discoverGroups(root) {
  const groups = [...prismaGroups(root), ...drizzleGroups(root)];
  const claimed = new Set(groups.map((group) => group.directory));
  const directories = [...configuredDirectories(root), ...findMigrationDirectories(root)];
  for (const directory of directories) {
    if (claimed.has(directory)) continue;
    claimed.add(directory);
    groups.push({ framework: 'directory', directory, dialect: null, files: listFilesRecursively(directory) });
  }
  return groups;
}

function unsupportedProviders(groups) {
  return groups
    .filter((group) => group.provider && !group.dialect && group.files.length > 0)
    .map((group) => `${group.framework} ${group.provider}`);
}

// Returns the ordered migration files with their framework and dialect.
function discoverMigrations(root, { dialect } = {}) {
  const allGroups = discoverGroups(root);
  const groups = allGroups.filter((group) => group.files.length > 0);
  const skipped = dialect ? [] : unsupportedProviders(groups);
  const supported = groups.filter((group) => dialect || !group.provider || group.dialect);
  return { files: groupFiles(root, supported, dialect, allGroups), skipped };
}

// Explicit file and directory arguments; a directory is discovered as a project or read as a migration folder.
function collectPaths(paths, { dialect, cwd = process.cwd() } = {}) {
  const files = [];
  const skipped = [];
  for (const input of paths) {
    const target = path.resolve(cwd, input);
    if (!fs.existsSync(target)) throw new Error('Migration path does not exist: ' + input);
    if (isDirectory(target)) {
      const discovered = discoverMigrations(target, { dialect });
      skipped.push(...discovered.skipped);
      if (discovered.files.length > 0) files.push(...discovered.files);
      else {
        const group = { framework: 'directory', directory: target, dialect: null, files: listFilesRecursively(target) };
        files.push(...groupFiles(target, [group], dialect));
      }
    } else {
      const group = { framework: 'directory', directory: path.dirname(target), dialect: null, files: [target] };
      files.push(...groupFiles(path.dirname(target), [group], dialect));
    }
  }
  const unique = new Map(files.map((file) => [file.path, file]));
  return { files: [...unique.values()], skipped };
}

module.exports = { discoverMigrations, collectPaths, packageDialects, readConfigStrings };
