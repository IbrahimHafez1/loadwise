import fs from 'node:fs';
import type { Dirent } from 'node:fs';
import path from 'node:path';
import { loadSyntax } from './compiler.cjs';
import { noteUnreadable } from '../shared/coverage-notes.cjs';
import { prismaModelName } from './prisma.cjs';
import type {
  Block,
  CallExpression,
  ClassLikeDeclaration,
  Expression,
  MethodDeclaration,
  Node,
  PropertyAccessExpression,
  SourceFile,
} from 'typescript';
import type { PerformanceRuleContext, ProgramAdapter, SymbolAdapter } from '../shared/types.cjs';
const ts = loadSyntax();

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
  /@Use(?:Guards|Interceptors)\s*\(([^)]*)\)\s*(?:@[\w.]+(?:\s*\([^)]*\))?\s*)*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\b/g;

// A guard or interceptor is applied to every route ('global') or to the routes of one controller
// ('controller').
type RegistrationScope = 'global' | 'controller';
type Registrations = Record<RegistrationScope, Set<string>>;

// A method whose body exists: the only methods that can call the query.
type MethodWithBody = MethodDeclaration & { body: Block };

interface EntryCallSite {
  call: CallExpression;
  entry: MethodWithBody;
}

interface Heritage {
  implemented: Set<string>;
  extendsClass: boolean;
}

const REGISTRATION_SCOPES: readonly RegistrationScope[] = ['global', 'controller'];

const projectScans = new Map<string, Registrations>();
const fileScans = new WeakMap<SourceFile, Registrations>();

function emptyRegistrations(): Registrations {
  return { global: new Set(), controller: new Set() };
}

function addNames(registrations: Registrations, text: string, scope: RegistrationScope): void {
  for (const name of text.match(IDENTIFIER) ?? []) registrations[scope].add(name);
}

function scanText(text: string): Registrations {
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

function scanSourceFile(sourceFile: SourceFile): Registrations {
  const known = fileScans.get(sourceFile);
  if (known) return known;
  const scanned = scanText(sourceFile.text);
  fileScans.set(sourceFile, scanned);
  return scanned;
}

function projectRoot(fileName: string): string {
  let directory = path.dirname(fileName);
  while (!fs.existsSync(path.join(directory, 'package.json'))) {
    const parent = path.dirname(directory);
    if (parent === directory) return path.dirname(fileName);
    directory = parent;
  }
  return directory;
}

function mergeRegistrations(target: Registrations, source: Registrations): void {
  for (const scope of REGISTRATION_SCOPES) for (const name of source[scope]) target[scope].add(name);
}

// The files the program already parsed, by absolute path, so a scan does not read them from disk a
// second time.
function programTexts(program: ProgramAdapter): Map<string, string> {
  const texts = new Map<string, string>();
  for (const file of program?.getSourceFiles?.() ?? []) texts.set(path.resolve(file.fileName), file.text);
  return texts;
}

// Registrations in other files come from the project directory; files outside the program are read
// from disk.
function scanProject(root: string, program: ProgramAdapter): Registrations {
  const knownTexts = programTexts(program);
  const registrations = emptyRegistrations();
  const pending = [root];
  let scanned = 0;
  for (let directory = pending.pop(); directory !== undefined; directory = pending.pop()) {
    let entries: Dirent[];
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
        const filename = path.join(directory, entry.name);
        mergeRegistrations(registrations, scanText(knownTexts.get(filename) ?? fs.readFileSync(filename, 'utf8')));
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

// 'global', 'controller' or undefined. The analyzed file's own text comes from the compiler, so
// virtual sources count.
function registrationScope(
  className: string,
  sourceFile: SourceFile,
  program: ProgramAdapter,
): RegistrationScope | undefined {
  const root = projectRoot(sourceFile.fileName);
  const project = projectScans.get(root) ?? scanProject(root, program);
  projectScans.set(root, project);
  const own = scanSourceFile(sourceFile);
  if (own.global.has(className) || project.global.has(className)) return 'global';
  if (own.controller.has(className) || project.controller.has(className)) return 'controller';
}

function declaredFiles(symbol: SymbolAdapter | undefined): string[] | undefined {
  return symbol?.declarations?.map((declaration: Node) => declaration.getSourceFile().fileName.replaceAll('\\', '/'));
}

function isDatabaseQuery(access: PropertyAccessExpression, context: PerformanceRuleContext): boolean {
  const name = access.name;
  if (PRISMA_OPERATIONS.has(name.text) && prismaModelName(name, context.checker)) return true;
  const files = declaredFiles(context.checker.getSymbolAtLocation(name));
  if (ORM_READS.has(name.text) && files?.length && files.every((file) => ORM_PACKAGE.test(file))) return true;
  if (name.text === 'query' && context.isPackageType(access.expression, PG_PACKAGES, PG_RECEIVERS)) return true;
  return DRIZZLE_ROOTS.has(name.text) && Boolean(files?.some((file) => DRIZZLE_PACKAGE.test(file)));
}

function heritageNames(classNode: ClassLikeDeclaration): Heritage {
  const heritage: Heritage = { implemented: new Set(), extendsClass: false };
  for (const clause of classNode.heritageClauses ?? []) {
    if (clause.token === ts.SyntaxKind.ExtendsKeyword) {
      heritage.extendsClass = true;
      continue;
    }
    // Native syntax nodes differ in shape, so read the written name rather than the node's fields.
    for (const type of clause.types) {
      const writtenName = type.getText().split('<')[0].split('.').at(-1)?.trim();
      if (writtenName !== undefined) heritage.implemented.add(writtenName);
    }
  }
  return heritage;
}

function isEntryMethod(method: MethodDeclaration, classNode: ClassLikeDeclaration): boolean {
  const interfaceName = ENTRY_INTERFACES.get(method.name.getText());
  if (!interfaceName) return false;
  const heritage = heritageNames(classNode);
  return heritage.implemented.has(interfaceName) || (heritage.extendsClass && interfaceName === 'CanActivate');
}

function insideCacheWrapper(call: CallExpression): boolean {
  for (let node: Node | undefined = call.parent; node && !ts.isMethodDeclaration(node); node = node.parent) {
    if (
      ts.isFunctionLike(node) &&
      ts.isCallExpression(node.parent) &&
      node.parent.arguments.some((argument) => argument === node) &&
      ts.isPropertyAccessExpression(node.parent.expression) &&
      CACHE_WRAPPER.test(node.parent.expression.name.text)
    )
      return true;
  }
  return false;
}

function containsCacheRead(node: Node): boolean {
  let found = false;
  (function visit(child: Node): void {
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

function cacheResultNames(body: Node, beforePosition: number): Set<string> {
  const names = new Set<string>();
  (function visit(node: Node): void {
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

function mentionsCache(expression: Expression, names: ReadonlySet<string>): boolean {
  if (containsCacheRead(expression)) return true;
  let mentioned = false;
  (function visit(node: Node): void {
    if (mentioned) return;
    if (ts.isIdentifier(node) && names.has(node.text)) mentioned = true;
    else ts.forEachChild(node, visit);
  })(expression);
  return mentioned;
}

function containsReturn(node: Node): boolean {
  let found = false;
  (function visit(child: Node): void {
    if (found) return;
    if (ts.isReturnStatement(child)) found = true;
    else if (!ts.isFunctionLike(child)) ts.forEachChild(child, visit);
  })(node);
  return found;
}

// A cache read in the same method skips or short-circuits the lookup, so most requests never reach
// the query.
function guardedByCacheRead(node: Node, method: MethodWithBody): boolean {
  const names = cacheResultNames(method.body, node.pos);
  let child = node;
  for (
    let parent: Node | undefined = node.parent;
    parent && parent !== method;
    child = parent, parent = parent.parent
  ) {
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
    const earlier = parent.statements.slice(
      0,
      parent.statements.findIndex((statement) => statement === child),
    );
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

function hasBody(method: MethodDeclaration): method is MethodWithBody {
  return Boolean(method.body);
}

function entryCallSites(classNode: ClassLikeDeclaration, helperName: string): EntryCallSite[] {
  const sites: EntryCallSite[] = [];
  for (const member of classNode.members) {
    if (!ts.isMethodDeclaration(member) || !hasBody(member) || !isEntryMethod(member, classNode)) continue;
    (function visit(node: Node): void {
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
function uncachedEntry(
  call: CallExpression,
  method: MethodWithBody,
  classNode: ClassLikeDeclaration,
): MethodWithBody | undefined {
  if (guardedByCacheRead(call, method)) return;
  if (isEntryMethod(method, classNode)) return method;
  if (!ts.isIdentifier(method.name)) return;
  const site = entryCallSites(classNode, method.name.text).find(
    (candidate) => !insideCacheWrapper(candidate.call) && !guardedByCacheRead(candidate.call, candidate.entry),
  );
  return site?.entry;
}

function check(call: CallExpression, context: PerformanceRuleContext): void {
  const access = call.expression;
  if (!ts.isPropertyAccessExpression(access) || !QUERY_NAMES.has(access.name.text)) return;
  const method = ts.findAncestor(call.parent, (node: Node) => ts.isMethodDeclaration(node) || ts.isClassLike(node));
  if (!method || !ts.isMethodDeclaration(method) || !hasBody(method) || !ts.isClassLike(method.parent)) return;
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
  const scope = registrationScope(className, call.getSourceFile(), context.program);
  if (!scope || !isDatabaseQuery(access, context)) return;
  const registration =
    scope === 'global' ? 'is registered globally' : 'is applied to a controller class through a decorator';
  context.report(
    access.name,
    RULE_ID,
    `This query runs in \`${className}.${entry.name.getText()}()\` before every handler, and \`${className}\` ${registration}, so each request pays a database round trip and row hydration. Cache the lookup (in-memory LRU or Redis) keyed by id with a short TTL and explicit invalidation on change (for example a tokenVersion bump), or carry the needed claims in the token; without invalidation, revocation waits for the TTL.`,
  );
}

export { check };
