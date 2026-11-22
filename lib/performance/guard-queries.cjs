'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { syntax: ts } = require('./compiler.cjs');
const { noteUnreadable } = require('../shared/coverage-notes.cjs');
const { prismaModelName } = require('./prisma.cjs');

const RULE_ID = 'guard-query-per-request';
const ENTRY_INTERFACES = new Map([
  ['canActivate', 'CanActivate'],
  ['intercept', 'NestInterceptor'],
  ['use', 'NestMiddleware'],
]);
const CACHE_WRAPPER = /^(?:wrap|getOrSet|remember|cached|memoize|getOr[A-Z]\w*)$/;
const CACHE_RECEIVER = /cache|redis|lru|memo/i;
const CACHE_READS = new Set(['get', 'getAsync', 'getItem', 'getJson', 'peek']);
const PRISMA_OPERATIONS = new Set([
  'findUnique',
  'findUniqueOrThrow',
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'count',
  'aggregate',
  'groupBy',
]);
const ORM_READS = new Set([
  'find',
  'findBy',
  'findByIds',
  'findOne',
  'findOneBy',
  'findOneById',
  'findOneOrFail',
  'findOneByOrFail',
  'findAndCount',
  'findAndCountBy',
  'count',
  'countBy',
  'exists',
  'existsBy',
  'getOne',
  'getMany',
  'getOneOrFail',
  'getRawOne',
  'getRawMany',
  'getCount',
  'getManyAndCount',
  'query',
  'findAll',
  'findByPk',
  'findAndCountAll',
  'findById',
  'countDocuments',
]);
const DRIZZLE_ROOTS = new Set(['select', 'selectDistinct', 'findFirst', 'findMany']);
const ORM_PACKAGE = /\/node_modules\/(?:typeorm|sequelize|@sequelize\/core|mongoose)\//;
const DRIZZLE_PACKAGE = /\/node_modules\/drizzle-orm\//;
const PG_PACKAGES = ['pg', '@types/pg', 'pg-pool', '@types/pg-pool'];
const PG_RECEIVERS = ['Pool', 'Client', 'ClientBase', 'PoolClient'];
const QUERY_NAMES = new Set([...PRISMA_OPERATIONS, ...ORM_READS, ...DRIZZLE_ROOTS]);

const SKIPPED_DIRECTORIES = new Set(['node_modules', 'dist', 'build', 'coverage', 'out']);
const SOURCE_FILE = /\.[cm]?[jt]s$/;
const MAX_SCANNED_FILES = 20000;
const IDENTIFIER = /[A-Za-z_$][\w$]*/g;
const REGISTRATION_HINT = /APP_(?:GUARD|INTERCEPTOR)|useGlobal|forRoutes|@Use(?:Guards|Interceptors)/;
const GLOBAL_PROVIDER_ORDERS = [
  /\bAPP_(?:GUARD|INTERCEPTOR)\b[^{}]{0,60}?\buse(?:Class|Existing)\s*:\s*([A-Za-z_$][\w$]*)/g,
  /\buse(?:Class|Existing)\s*:\s*([A-Za-z_$][\w$]*)[^{}]{0,60}?\bprovide\s*:\s*APP_(?:GUARD|INTERCEPTOR)\b/g,
];
const GLOBAL_USE_CALL = /\.useGlobal(?:Guards|Interceptors)\s*\(([^;]*)\)/g;
const MIDDLEWARE_ALL_ROUTES =
  /\.apply\s*\(([^)]*)\)\s*(?:\.exclude\s*\([^)]*\)\s*)?\.forRoutes\s*\(\s*(?:(['"`])(?:\/?\*|\(\.\*\)|\/?\*path)\2|\{\s*path\s*:\s*(['"`])(?:\/?\*|\(\.\*\))\3)/g;
const CONTROLLER_DECORATOR =
  /@Use(?:Guards|Interceptors)\s*\(([^)]*)\)\s*(?:@[\w.]+\s*(?:\([^)]*\))?\s*)*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\b/g;

const projectScans = new Map();
const fileScans = new WeakMap();

function emptyRegistrations() {
  return { global: new Set(), controller: new Set() };
}

function addNames(registrations, text, scope) {
  for (const name of text.match(IDENTIFIER) ?? []) registrations[scope].add(name);
}

function scanText(text) {
  const registrations = emptyRegistrations();
  if (!REGISTRATION_HINT.test(text)) return registrations;
  for (const pattern of GLOBAL_PROVIDER_ORDERS) {
    for (const match of text.matchAll(pattern)) registrations.global.add(match[1]);
  }
  for (const match of text.matchAll(GLOBAL_USE_CALL)) addNames(registrations, match[1], 'global');
  for (const match of text.matchAll(MIDDLEWARE_ALL_ROUTES)) addNames(registrations, match[1], 'global');
  for (const match of text.matchAll(CONTROLLER_DECORATOR)) addNames(registrations, match[1], 'controller');
  return registrations;
}

function scanSourceFile(sourceFile) {
  if (!fileScans.has(sourceFile)) fileScans.set(sourceFile, scanText(sourceFile.text));
  return fileScans.get(sourceFile);
}

function projectRoot(fileName) {
  let directory = path.dirname(fileName);
  while (!fs.existsSync(path.join(directory, 'package.json'))) {
    const parent = path.dirname(directory);
    if (parent === directory) return path.dirname(fileName);
    directory = parent;
  }
  return directory;
}

function mergeRegistrations(target, source) {
  for (const scope of Object.keys(target)) for (const name of source[scope]) target[scope].add(name);
}

// The checker exposes no program here, so registrations in other files come from the project directory on disk.
function scanProject(root) {
  const registrations = emptyRegistrations();
  const pending = [root];
  let scanned = 0;
  while (pending.length) {
    const directory = pending.pop();
    let entries;
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      noteUnreadable({ error, location: directory, consequence: 'guards registered there were not seen' });
      continue;
    }
    for (const entry of entries) {
      const isDirectory = entry.isDirectory();
      if (isDirectory && !SKIPPED_DIRECTORIES.has(entry.name) && !entry.name.startsWith('.')) {
        pending.push(path.join(directory, entry.name));
      }
      if (isDirectory || !SOURCE_FILE.test(entry.name) || entry.name.endsWith('.d.ts')) continue;
      try {
        mergeRegistrations(registrations, scanText(fs.readFileSync(path.join(directory, entry.name), 'utf8')));
      } catch (error) {
        noteUnreadable({
          error,
          location: path.join(directory, entry.name),
          consequence: 'guards registered there were not seen',
        });
      }
      if (++scanned === MAX_SCANNED_FILES) return registrations;
    }
  }
  return registrations;
}

// 'global', 'controller' or undefined. The analyzed file's own text comes from the compiler, so virtual sources count.
function registrationScope(className, sourceFile) {
  const root = projectRoot(sourceFile.fileName);
  if (!projectScans.has(root)) projectScans.set(root, scanProject(root));
  const own = scanSourceFile(sourceFile);
  const project = projectScans.get(root);
  if (own.global.has(className) || project.global.has(className)) return 'global';
  if (own.controller.has(className) || project.controller.has(className)) return 'controller';
}

function declaredFiles(symbol) {
  return symbol?.declarations?.map((declaration) => declaration.getSourceFile().fileName.replaceAll('\\', '/'));
}

function isDatabaseQuery(call, context) {
  const access = call.expression;
  const name = access.name;
  if (PRISMA_OPERATIONS.has(name.text) && prismaModelName(name, context.checker)) return true;
  const files = declaredFiles(context.checker.getSymbolAtLocation(name));
  if (ORM_READS.has(name.text) && files?.length && files.every((file) => ORM_PACKAGE.test(file))) return true;
  if (name.text === 'query' && context.isPackageType(access.expression, PG_PACKAGES, PG_RECEIVERS)) return true;
  return DRIZZLE_ROOTS.has(name.text) && Boolean(files?.some((file) => DRIZZLE_PACKAGE.test(file)));
}

function heritageNames(classNode) {
  const heritage = { implemented: new Set(), extendsClass: false };
  for (const clause of classNode.heritageClauses ?? []) {
    if (clause.token === ts.SyntaxKind.ExtendsKeyword) {
      heritage.extendsClass = true;
      continue;
    }
    // Native syntax nodes differ in shape, so read the written name rather than the node's fields.
    for (const type of clause.types) heritage.implemented.add(type.getText().split('<')[0].split('.').at(-1).trim());
  }
  return heritage;
}

function isEntryMethod(method, classNode) {
  const interfaceName = ENTRY_INTERFACES.get(method.name.getText());
  if (!interfaceName) return false;
  const heritage = heritageNames(classNode);
  return heritage.implemented.has(interfaceName) || (heritage.extendsClass && interfaceName === 'CanActivate');
}

function insideCacheWrapper(call) {
  for (let node = call.parent; node && !ts.isMethodDeclaration(node); node = node.parent) {
    if (
      ts.isFunctionLike(node) &&
      ts.isCallExpression(node.parent) &&
      node.parent.arguments.includes(node) &&
      ts.isPropertyAccessExpression(node.parent.expression) &&
      CACHE_WRAPPER.test(node.parent.expression.name.text)
    )
      return true;
  }
  return false;
}

function containsCacheRead(node) {
  let found = false;
  (function visit(child) {
    if (found) return;
    if (
      ts.isCallExpression(child) &&
      ts.isPropertyAccessExpression(child.expression) &&
      CACHE_READS.has(child.expression.name.text) &&
      CACHE_RECEIVER.test(child.expression.expression.getText())
    )
      found = true;
    else ts.forEachChild(child, visit);
  })(node);
  return found;
}

function cacheResultNames(body, beforePosition) {
  const names = new Set();
  (function visit(node) {
    if (node.pos >= beforePosition) return;
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      containsCacheRead(node.initializer)
    )
      names.add(node.name.text);
    ts.forEachChild(node, visit);
  })(body);
  return names;
}

function mentionsCache(expression, names) {
  if (containsCacheRead(expression)) return true;
  let mentioned = false;
  (function visit(node) {
    if (mentioned) return;
    if (ts.isIdentifier(node) && names.has(node.text)) mentioned = true;
    else ts.forEachChild(node, visit);
  })(expression);
  return mentioned;
}

function containsReturn(node) {
  let found = false;
  (function visit(child) {
    if (found) return;
    if (ts.isReturnStatement(child)) found = true;
    else if (!ts.isFunctionLike(child)) ts.forEachChild(child, visit);
  })(node);
  return found;
}

// A cache read in the same method skips or short-circuits the lookup, so most requests never reach the query.
function guardedByCacheRead(node, method) {
  const names = cacheResultNames(method.body, node.pos);
  let child = node;
  for (let parent = node.parent; parent && parent !== method; child = parent, parent = parent.parent) {
    if (ts.isIfStatement(parent) && child !== parent.expression && mentionsCache(parent.expression, names)) return true;
    if (
      ts.isBinaryExpression(parent) &&
      parent.right === child &&
      [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken].includes(parent.operatorToken.kind) &&
      mentionsCache(parent.left, names)
    )
      return true;
    if (ts.isConditionalExpression(parent) && child !== parent.condition && mentionsCache(parent.condition, names))
      return true;
    if (!ts.isBlock(parent)) continue;
    const earlier = parent.statements.slice(0, parent.statements.indexOf(child));
    if (
      earlier.some(
        (statement) =>
          ts.isIfStatement(statement) &&
          mentionsCache(statement.expression, names) &&
          containsReturn(statement.thenStatement),
      )
    )
      return true;
  }
  return false;
}

function entryCallSites(classNode, helperName) {
  const sites = [];
  for (const member of classNode.members) {
    if (!ts.isMethodDeclaration(member) || !member.body || !isEntryMethod(member, classNode)) continue;
    (function visit(node) {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.expression.kind === ts.SyntaxKind.ThisKeyword &&
        node.expression.name.text === helperName
      )
        sites.push({ call: node, entry: member });
      ts.forEachChild(node, visit);
    })(member.body);
  }
  return sites;
}

// The entry method that runs this query on an uncached path, or undefined.
function uncachedEntry(call, method, classNode) {
  if (guardedByCacheRead(call, method)) return;
  if (isEntryMethod(method, classNode)) return method;
  if (!ts.isIdentifier(method.name)) return;
  const site = entryCallSites(classNode, method.name.text).find(
    (candidate) => !insideCacheWrapper(candidate.call) && !guardedByCacheRead(candidate.call, candidate.entry),
  );
  return site?.entry;
}

function check(call, context) {
  const access = call.expression;
  if (!ts.isPropertyAccessExpression(access) || !QUERY_NAMES.has(access.name.text)) return;
  const method = ts.findAncestor(call.parent, (node) => ts.isMethodDeclaration(node) || ts.isClassLike(node));
  if (!method || !ts.isMethodDeclaration(method) || !method.body || !ts.isClassLike(method.parent)) return;
  const classNode = method.parent;
  if (
    !classNode.name ||
    !classNode.members.some((member) => ts.isMethodDeclaration(member) && ENTRY_INTERFACES.has(member.name.getText()))
  )
    return;
  if (insideCacheWrapper(call)) return;
  const entry = uncachedEntry(call, method, classNode);
  if (!entry) return;
  const className = classNode.name.text;
  const scope = registrationScope(className, call.getSourceFile());
  if (!scope || !isDatabaseQuery(call, context)) return;
  const registration =
    scope === 'global' ? 'is registered globally' : 'is applied to a controller class through a decorator';
  context.report(
    access.name,
    RULE_ID,
    `This query runs in \`${className}.${entry.name.getText()}()\` before every handler, and \`${className}\` ${registration}, so each request pays a database round trip and row hydration. Cache the lookup (in-memory LRU or Redis) keyed by id with a short TTL and explicit invalidation on change (for example a tokenVersion bump), or carry the needed claims in the token; without invalidation, revocation waits for the TTL.`,
  );
}

module.exports = { check };
