// Fixes for query shapes that cost extra round trips or rows: cartesian includes, a counter and its
// expiry sent apart, redundant prefix indexes and retries without backoff.
import path from 'node:path';
import {
  ts,
  textOf,
  replaceNode,
  ancestor,
  calleeCall,
  enclosingStatement,
  addProperty,
  addOptionsArgument,
  indentationAt,
  lineStart,
} from './helpers.cjs';
import { formatComment } from '../../shared/fix-presentation.cjs';
import type {
  Block,
  CallExpression,
  CatchClause,
  ExpressionStatement,
  Expression,
  ForStatement,
  Identifier,
  Node,
  ObjectLiteralElementLike,
  ObjectLiteralExpression,
  PropertyDeclaration,
  SourceFile,
  Statement,
  TryStatement,
} from 'typescript';
import { isMethodCall } from './method-calls.cjs';
import type { MethodCall } from '../types/method-call.cjs';
import type { Finding, FixResult, SiteFixInput, TextEdit } from '../../shared/types.cjs';

/** A relation an include can name: a `hasMany(...)` call or a decorated property. */
interface Association {
  parent: string;
  model: string | undefined;
  kind: string;
  as: string | undefined;
}

/**
 * One `include` array entry: the model or alias it names and the literal that can take `separate:
 * true`.
 */
interface IncludeEntry {
  model: string | undefined;
  alias?: string | undefined;
  literal?: ObjectLiteralExpression;
  separate?: boolean | undefined;
}

/** The try around a retried call, with the loop counter its catch handler can back off on. */
interface RetryLoop {
  catchClause: CatchClause;
  counter: string;
}

/** The catch body that only logs, with the `continue` the wait goes in front of. */
interface WaitPosition {
  block: Block;
  before: Statement | undefined;
}

const typeormNote =
  "`relationLoadStrategy: 'query'` loads each relation in its own query instead of one joined result; check code that relies on the order of the related rows.";
const sequelizeNote =
  '`separate: true` loads each listed hasMany association in its own query; it needs the parent primary key and the foreign key in the selected attributes, and `limit`/`order` on the include then apply per query.';
const multiNote =
  'Both commands now run in one MULTI transaction and one round trip. Check how the caller handles a failed command, which `exec()` now reports.';
const assignedMultiNote = `${multiNote} With ioredis the counter comes from the \`[error, value]\` pair of the reply; the reply is \`null\` when a WATCH aborted the transaction.`;
const prismaIndexNote =
  'Removes the redundant index from the schema; create and apply a migration (`prisma migrate dev`) to drop it from the database.';
const drizzleIndexNote =
  'Removes the redundant index from the table definition; generate and apply a migration (`drizzle-kit generate`) to drop it from the database.';
const loopBackoffNote =
  'Waits with exponential backoff and jitter after each failed attempt, also after the last one; tune the base delay for this service.';
const axiosRetryNote = 'axios-retry now waits exponentially longer between attempts (with jitter) instead of 0 ms.';

const typeormFindMethods = new Set(['find', 'findOne', 'findOneOrFail', 'findAndCount']);
const sequelizeFindMethods = new Map([
  ['findAll', 0],
  ['findOne', 0],
  ['findAndCountAll', 0],
  ['findByPk', 1],
]);
const sequelizeAssociationKinds = new Set(['hasMany', 'hasOne', 'belongsTo', 'belongsToMany']);
const sequelizeAssociationDecorators = new Map([
  ['HasMany', 'hasMany'],
  ['HasOne', 'hasOne'],
  ['BelongsTo', 'belongsTo'],
  ['BelongsToMany', 'belongsToMany'],
]);
const moduleExtensions = ['.ts', '.tsx', '.js', '.mts', '.cts', '.mjs', '.cjs', '/index.ts', '/index.js'];
const counterCommands = new Set(['incr', 'incrby']);
const expireCommands = new Set(['expire', 'pexpire', 'expireat', 'pexpireat']);
const nodeRedisPackages = new Set(['redis', '@redis/client']);
const drizzleIndexBuilders = new Set(['index', 'uniqueIndex']);
const logCallee = /(^|\.)(console|logger|log)\.\w+$/i;

function propertyName(property: ObjectLiteralElementLike | PropertyDeclaration): string | undefined {
  const name = property.name;
  if (name && (ts.isIdentifier(name) || ts.isStringLiteral(name))) return name.text;
}

function propertyNamed(literal: ObjectLiteralExpression, name: string): ObjectLiteralElementLike | undefined {
  return literal.properties.find((property) => propertyName(property) === name);
}

function stringValue(node: Expression | undefined): string | undefined {
  const value = node && ts.skipOuterExpressions(node);
  return value && ts.isStringLiteralLike(value) ? value.text : undefined;
}

function hasSpread(literal: ObjectLiteralExpression): boolean {
  return literal.properties.some((property) => !ts.isPropertyAssignment(property));
}

function methodCall(node: Node): MethodCall | undefined {
  const call = calleeCall(node);
  return call && isMethodCall(call) ? call : undefined;
}

function finished(edits: TextEdit[], note: string): FixResult {
  return edits && { edits, note, requiresReview: true };
}

// --- orm-cartesian-include
// ---------------------------------------------------------------------------------------

// `repo.find({ relations: [...] })` or `manager.find(User, { relations })`: load each relation in
// its own query.
function typeormFix(call: MethodCall, text: string): FixResult | undefined {
  if (!typeormFindMethods.has(call.expression.name.text)) return;
  const options = call.arguments
    .map((argument: Expression) => ts.skipOuterExpressions(argument))
    .find(
      (argument: Expression): argument is ObjectLiteralExpression =>
        ts.isObjectLiteralExpression(argument) && !!propertyNamed(argument, 'relations'),
    );
  if (!options || hasSpread(options) || propertyNamed(options, 'relationLoadStrategy')) return;
  return finished([addProperty(options, "relationLoadStrategy: 'query'", text)], typeormNote);
}

// Source files that may declare the associations: this file and the files it imports by relative
// path.
function associationFiles(sourceFile: SourceFile, load: SiteFixInput['load']): SourceFile[] {
  const files = [sourceFile];
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const specifier = statement.moduleSpecifier.text;
    if (!specifier.startsWith('.')) continue;
    const base = path.resolve(path.dirname(sourceFile.fileName), specifier.replace(/\.[cm]?js$/, ''));
    const loaded = moduleExtensions.map((extension) => load(base + extension)).find((entry) => entry?.sourceFile);
    if (loaded?.sourceFile) files.push(loaded.sourceFile);
  }
  return files;
}

// `Parent.hasMany(Model, { as })` calls and `@HasMany(() => Model) name` properties as { parent,
// model, kind, as }.
function associationsIn(sourceFile: SourceFile): Association[] {
  const found: Association[] = [];
  (function visit(node: Node): void {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const kind = node.expression.name.text;
      const [model, options] = node.arguments;
      if (sequelizeAssociationKinds.has(kind) && ts.isIdentifier(node.expression.expression) && model) {
        const literal = options && ts.skipOuterExpressions(options);
        const alias = literal && ts.isObjectLiteralExpression(literal) ? propertyNamed(literal, 'as') : undefined;
        found.push({
          parent: node.expression.expression.text,
          model: ts.isIdentifier(model) ? model.text : undefined,
          kind,
          as: alias && ts.isPropertyAssignment(alias) ? stringValue(alias.initializer) : undefined,
        });
      }
    }
    if (ts.isPropertyDeclaration(node) && ts.isClassDeclaration(node.parent) && node.parent.name) {
      const association = decoratedAssociation(node);
      if (association) found.push({ parent: node.parent.name.text, ...association });
    }
    ts.forEachChild(node, visit);
  })(sourceFile);
  return found;
}

function decoratedAssociation(property: PropertyDeclaration): Omit<Association, 'parent'> | undefined {
  for (const modifier of property.modifiers ?? []) {
    if (!ts.isDecorator(modifier) || !ts.isCallExpression(modifier.expression)) continue;
    const decorator = modifier.expression;
    const kind = ts.isIdentifier(decorator.expression) && sequelizeAssociationDecorators.get(decorator.expression.text);
    if (!kind) continue;
    const factory = decorator.arguments[0];
    const target = factory && ts.isArrowFunction(factory) && !ts.isBlock(factory.body) ? factory.body : undefined;
    return { model: target && ts.isIdentifier(target) ? target.text : undefined, kind, as: propertyName(property) };
  }
}

// { model, alias, literal } for `Post` or `{ model: Post, as: 'posts' }`; undefined for shapes not
// rewritten.
function includeEntry(element: Expression): IncludeEntry | undefined {
  const value = ts.skipOuterExpressions(element);
  if (ts.isIdentifier(value)) return { model: value.text };
  if (!ts.isObjectLiteralExpression(value) || hasSpread(value)) return;
  if (propertyNamed(value, 'include')) return;
  const model = propertyNamed(value, 'model');
  const alias = propertyNamed(value, 'as') ?? propertyNamed(value, 'association');
  const modelValue = model && ts.isPropertyAssignment(model) ? model.initializer : undefined;
  if (model && !(modelValue && ts.isIdentifier(modelValue))) return;
  const separate = propertyNamed(value, 'separate');
  return {
    model: modelValue && ts.isIdentifier(modelValue) ? modelValue.text : undefined,
    alias: alias && ts.isPropertyAssignment(alias) ? stringValue(alias.initializer) : undefined,
    literal: value,
    separate: separate && ts.isPropertyAssignment(separate) && separate.initializer.kind === ts.SyntaxKind.TrueKeyword,
  };
}

// True when every association of `parent` that the include names is a hasMany, and at least one is.
function isHasMany(entry: IncludeEntry, parent: string, associations: readonly Association[]): boolean {
  if (!entry.model && !entry.alias) return false;
  const matching = associations.filter(
    (association) =>
      association.parent === parent &&
      (entry.alias ? association.as === entry.alias : association.model === entry.model) &&
      (!entry.model || !association.model || association.model === entry.model),
  );
  return matching.length > 0 && matching.every((association) => association.kind === 'hasMany');
}

// `Author.findAll({ include: [Post, { model: Tag }] })`: every hasMany include after the first gets
// `separate: true`.
function sequelizeFix(call: MethodCall, { sourceFile, text, load }: SiteFixInput): FixResult | undefined {
  if (!sourceFile || text === undefined) return;
  const optionsIndex = sequelizeFindMethods.get(call.expression.name.text);
  if (optionsIndex === undefined) return;
  const options = call.arguments[optionsIndex] && ts.skipOuterExpressions(call.arguments[optionsIndex]);
  const parent = ts.skipOuterExpressions(call.expression.expression);
  if (!options || !ts.isObjectLiteralExpression(options) || !ts.isIdentifier(parent)) return;
  if (hasSpread(options) || propertyNamed(options, 'attributes')) return;
  const include = propertyNamed(options, 'include');
  const list = include && ts.isPropertyAssignment(include) && ts.skipOuterExpressions(include.initializer);
  if (!list || !ts.isArrayLiteralExpression(list)) return;
  const entries: { element: Expression; entry: IncludeEntry }[] = [];
  for (const element of list.elements) {
    const entry = includeEntry(element);
    if (!entry) return;
    entries.push({ element, entry });
  }
  const associations = associationFiles(sourceFile, load).flatMap(associationsIn);
  const hasMany = entries.filter(({ entry }) => !entry.separate && isHasMany(entry, parent.text, associations));
  if (hasMany.length < 2) return;
  const edits = hasMany
    .slice(1)
    .map(({ element, entry }) =>
      entry.literal
        ? addProperty(entry.literal, 'separate: true', text)
        : replaceNode(element, `{ model: ${entry.model}, separate: true }`),
    );
  return finished(edits, sequelizeNote);
}

function cartesianIncludeFix(context: SiteFixInput): FixResult | undefined {
  if (!context.node || context.text === undefined) return;
  const call = methodCall(context.node);
  if (!call) return;
  if (context.finding.message.includes('separate: true')) {
    if (sequelizeFindMethods.has(call.expression.name.text)) return sequelizeFix(call, context);
    return;
  }
  return typeormFix(call, context.text);
}

// --- redis-incr-then-expire
// --------------------------------------------------------------------------------------

function importsPackage(sourceFile: SourceFile, packages: ReadonlySet<string>): boolean {
  return sourceFile.statements.some(
    (statement: Statement) =>
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      packages.has(statement.moduleSpecifier.text),
  );
}

// `await client.method(...)` as the call, or undefined.
function awaitedCall(expression: Expression | undefined): MethodCall | undefined {
  const awaited = expression && ts.skipOuterExpressions(expression);
  if (!awaited || !ts.isAwaitExpression(awaited)) return;
  const call = ts.skipOuterExpressions(awaited.expression);
  return ts.isCallExpression(call) && isMethodCall(call) ? call : undefined;
}

function nextStatement(statement: Statement): Statement | undefined {
  const parent = statement.parent;
  const siblings =
    ts.isBlock(parent) || ts.isSourceFile(parent) || ts.isModuleBlock(parent) || ts.isCaseOrDefaultClause(parent)
      ? parent.statements
      : undefined;
  return siblings?.[siblings.indexOf(statement) + 1];
}

// The `await client.expire(key, ttl)` statement right after the counter, on the same client and
// key.
function adjacentExpire(
  statement: Statement,
  counter: MethodCall,
): { statement: ExpressionStatement; call: MethodCall } | undefined {
  const next = nextStatement(statement);
  if (!next || !ts.isExpressionStatement(next)) return;
  const expire = awaitedCall(next.expression);
  if (!expire || !expireCommands.has(expire.expression.name.text.toLowerCase())) return;
  if (textOf(expire.expression.expression) !== textOf(counter.expression.expression)) return;
  if (!expire.arguments[0] || textOf(expire.arguments[0]) !== textOf(counter.arguments[0])) return;
  return { statement: next, call: expire };
}

function multiText(counter: MethodCall, expire: MethodCall): string {
  const command = (call: MethodCall) => `${call.expression.name.text}(${call.arguments.map(textOf).join(', ')})`;
  return `await ${textOf(counter.expression.expression)}.multi().${command(counter)}.${command(expire)}.exec();`;
}

function incrThenExpireFix({ node, sourceFile }: SiteFixInput): FixResult | undefined {
  if (!node || !sourceFile) return;
  const counter = methodCall(node);
  if (!counter || !counterCommands.has(counter.expression.name.text.toLowerCase()) || !counter.arguments[0]) return;
  const statement = enclosingStatement(counter);
  if (!statement) return;
  if (ts.isExpressionStatement(statement)) {
    if (awaitedCall(statement.expression) !== counter) return;
    const expire = adjacentExpire(statement, counter);
    if (!expire) return;
    const edit: TextEdit = {
      start: statement.getStart(),
      end: expire.statement.end,
      text: multiText(counter, expire.call),
    };
    return finished([edit], multiNote);
  }
  return assignedCounterFix(statement, counter, sourceFile);
}

// `const count = await redis.incr(key)` only with ioredis, whose exec() reply holds `[error,
// value]` pairs.
function assignedCounterFix(statement: Statement, counter: MethodCall, sourceFile: SourceFile): FixResult | undefined {
  if (!ts.isVariableStatement(statement) || statement.declarationList.declarations.length !== 1) return;
  if (!importsPackage(sourceFile, new Set(['ioredis'])) || importsPackage(sourceFile, nodeRedisPackages)) return;
  const [declaration] = statement.declarationList.declarations;
  if (!ts.isIdentifier(declaration.name) || declaration.type || awaitedCall(declaration.initializer) !== counter)
    return;
  const expire = adjacentExpire(statement, counter);
  if (!expire) return;
  const keyword = statement.declarationList.flags & ts.NodeFlags.Const ? 'const' : 'let';
  const edit: TextEdit = {
    start: statement.declarationList.getStart(),
    end: expire.statement.end,
    text: `${keyword} [[, ${declaration.name.text}]] = ${multiText(counter, expire.call)}`,
  };
  return finished([edit], assignedMultiNote);
}

// --- index-redundant-prefix
// --------------------------------------------------------------------------------------

function balanced(line: string): boolean {
  let depth = 0;
  for (const character of line) {
    if (character === '(' || character === '[') depth++;
    if (character === ')' || character === ']') depth--;
  }
  return depth === 0;
}

// Removes the lines from `start` (a line start) to `end` (just past a line break, or the end of the
// text). Fixes are shown and applied line by line, where deleting a line's text alone would leave
// it behind empty, so the removal also takes the line break before the first line.
function wholeLinesRemoval(text: string, start: number, end: number): TextEdit {
  if (start === 0) return { start, end, text: '' };
  // The offset of the line break that ends just before `offset`.
  const lineBreakBefore = (offset: number) => (text[offset - 2] === '\r' ? offset - 2 : offset - 1);
  const lastLineEnd = text[end - 1] === '\n' ? lineBreakBefore(end) : end;
  return { start: lineBreakBefore(start), end: lastLineEnd, text: '' };
}

// The comment that takes a removed index's place: which index was removed and which one replaces
// it, since the rule's general why would leave the reader looking for an index that is gone.
function removedIndexComment(finding: Finding): string | undefined {
  const { redundantIndex, coveringIndex } = finding;
  if (typeof redundantIndex !== 'string' || !redundantIndex) return;
  if (typeof coveringIndex !== 'string' || !coveringIndex) return;
  const replacement = coveringIndex[0].toUpperCase() + coveringIndex.slice(1);
  return formatComment(
    finding.ruleId,
    `Removed ${redundantIndex}. ${replacement} replaces it, since it starts with the same columns.`,
  );
}

// Replaces whole lines with `comment`, indented like the first of them. The edit spans the same
// text as wholeLinesRemoval, so dropping the comment lines (--no-comments) leaves exactly that
// removal. Needs a line before.
function commentedLinesRemoval(text: string, start: number, end: number, comment: string): TextEdit {
  const [indentation] = /^[ \t]*/.exec(text.slice(start)) ?? [''];
  const lines = comment.split('\n').map((line) => '\n' + indentation + line);
  return { ...wholeLinesRemoval(text, start, end), text: lines.join('') };
}

// Removes lines `start` to `end`, or puts the removed-index comment in their place when comments
// are on.
function indexLinesFix(
  { finding, text, comments }: SiteFixInput,
  start: number,
  end: number,
  note: string,
): FixResult | undefined {
  if (text === undefined) return;
  const comment = comments && start > 0 && removedIndexComment(finding);
  if (!comment) return finished([wholeLinesRemoval(text, start, end)], note);
  return { ...finished([commentedLinesRemoval(text, start, end, comment)], note), comment };
}

// The flagged `@@index([...])` line of a Prisma schema, removed whole when the attribute fits on
// it.
function prismaIndexFix(context: SiteFixInput): FixResult | undefined {
  const { finding, text } = context;
  if (text === undefined || finding.line === undefined) return;
  const start = lineStartOfLine(text, finding.line);
  if (start === undefined) return;
  const newline = text.indexOf('\n', start);
  const end = newline === -1 ? text.length : newline + 1;
  const line = text.slice(start, end);
  if (!/^\s*@@index\(/.test(line) || !balanced(line.replace(/\/\/.*$/, ''))) return;
  return indexLinesFix(context, start, end, prismaIndexNote);
}

function lineStartOfLine(text: string, line: number): number | undefined {
  let offset = 0;
  for (let current = 1; current < line; current++) {
    offset = text.indexOf('\n', offset) + 1;
    if (offset === 0) return;
  }
  return offset;
}

function isTableCall(call: CallExpression): boolean {
  const callee = call.expression;
  const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) && callee.name.text;
  return !!name && /^(\w*Table|table)$/.test(name);
}

// The array or object the third `pgTable(...)` argument returns, as written by the extra-config
// callback.
function isExtraConfigList(list: Node): boolean {
  let returned: Node = list;
  while (ts.isParenthesizedExpression(returned.parent)) returned = returned.parent;
  const owner = ts.isReturnStatement(returned.parent)
    ? ancestor(returned.parent, (current) => ts.isFunctionLike(current))
    : returned.parent;
  if (!owner || !(ts.isArrowFunction(owner) || ts.isFunctionExpression(owner))) return false;
  if (ts.isArrowFunction(owner) && !ts.isBlock(owner.body) && owner.body !== returned) return false;
  const call = owner.parent;
  return ts.isCallExpression(call) && call.arguments[2] === owner && isTableCall(call);
}

// `index('a_idx').on(...)`, optionally chained further (`.where(...)`), as the root builder name.
function indexBuilderName(expression: Expression): string | undefined {
  let current = ts.skipOuterExpressions(expression);
  while (ts.isCallExpression(current) && ts.isPropertyAccessExpression(current.expression)) {
    current = ts.skipOuterExpressions(current.expression.expression);
  }
  return ts.isCallExpression(current) && ts.isIdentifier(current.expression) ? current.expression.text : undefined;
}

// The end of a list entry including its comma.
function entryEnd(entry: Node, text: string): number {
  const comma = /^\s*,/.exec(text.slice(entry.end));
  return comma ? entry.end + comma[0].length : entry.end;
}

// The whole lines a list entry fills, through its comma and line break, when it stands alone on
// them.
function ownLines(entry: Node, text: string): { start: number; end: number } | undefined {
  const start = entry.getStart();
  const afterEntry = entryEnd(entry, text);
  const restOfLine = /^[ \t]*(\r?\n)/.exec(text.slice(afterEntry));
  const ownLine = text.slice(lineStart(text, start), start).trim() === '';
  if (ownLine && restOfLine) return { start: lineStart(text, start), end: afterEntry + restOfLine[0].length };
}

// Removes a list entry that shares its line with others: the entry and one separator.
function removeInlineEntry(entry: Node, entries: readonly Node[], text: string): TextEdit {
  const start = entry.getStart();
  const position = entries.indexOf(entry);
  if (position < entries.length - 1) return { start, end: entries[position + 1].getStart(), text: '' };
  if (position > 0) return { start: entries[position - 1].end, end: entry.end, text: '' };
  return { start, end: entryEnd(entry, text), text: '' };
}

function drizzleIndexFix(context: SiteFixInput): FixResult | undefined {
  const { node, text } = context;
  if (!node || text === undefined) return;
  const entry = ancestor(
    node,
    (current) =>
      (ts.isArrayLiteralExpression(current.parent) && current.parent.elements.some((element) => element === current)) ||
      (ts.isPropertyAssignment(current) && ts.isObjectLiteralExpression(current.parent)),
  );
  if (!entry || !isExtraConfigList(entry.parent)) return;
  const expression = ts.isPropertyAssignment(entry) ? entry.initializer : entry;
  if (!ts.isExpression(expression)) return;
  const builderName = indexBuilderName(expression);
  if (!builderName || !drizzleIndexBuilders.has(builderName)) return;
  const container = entry.parent;
  const entries: readonly Node[] = ts.isArrayLiteralExpression(container)
    ? container.elements
    : ts.isObjectLiteralExpression(container)
      ? container.properties
      : [];
  const lines = ownLines(entry, text);
  if (lines) return indexLinesFix(context, lines.start, lines.end, drizzleIndexNote);
  return finished([removeInlineEntry(entry, [...entries], text)], drizzleIndexNote);
}

function redundantPrefixFix(context: SiteFixInput): FixResult | undefined {
  if (typeof context.finding.file === 'string' && context.finding.file.endsWith('.prisma')) {
    return prismaIndexFix(context);
  }
  if (context.node) return drizzleIndexFix(context);
}

// --- retry-without-backoff
// ---------------------------------------------------------------------------------------

function isAsyncFunction(node: Node): boolean {
  return (
    ts.canHaveModifiers(node) &&
    !!ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)
  );
}

// The try around `node` and the `for (let attempt = ...)` loop that retries it, inside one async
// function.
function retryLoop(node: Node): RetryLoop | undefined {
  let tryStatement: TryStatement | undefined;
  let child: Node = node;
  for (let parent = node.parent; parent; child = parent, parent = parent.parent) {
    if (ts.isFunctionLike(parent)) return;
    if (!tryStatement && ts.isTryStatement(parent) && parent.tryBlock === child) tryStatement = parent;
    if (!tryStatement || !(ts.isForStatement(parent) || ts.isWhileStatement(parent) || ts.isDoStatement(parent)))
      continue;
    const counter = ts.isForStatement(parent) && loopCounter(parent);
    const owner = ancestor(parent, (current) => ts.isFunctionLike(current));
    if (!counter || !tryStatement.catchClause || !owner || !isAsyncFunction(owner)) return;
    return { catchClause: tryStatement.catchClause, counter };
  }
}

function loopCounter(loop: ForStatement): string | undefined {
  const initializer = loop.initializer;
  if (!initializer || !ts.isVariableDeclarationList(initializer) || initializer.declarations.length !== 1) return;
  const [declaration] = initializer.declarations;
  return ts.isIdentifier(declaration.name) && loop.incrementor ? declaration.name.text : undefined;
}

function isLogStatement(statement: Statement): boolean {
  if (!ts.isExpressionStatement(statement)) return false;
  const call = ts.skipOuterExpressions(statement.expression);
  return ts.isCallExpression(call) && logCallee.test(textOf(call.expression));
}

// The catch body when it only logs, optionally ending in `continue`, as { block, before } where the
// wait goes in front of `before` (or at the end of the block when undefined).
function waitPosition(block: Block): WaitPosition | undefined {
  const statements = [...block.statements];
  const last = statements[statements.length - 1];
  const before = last && ts.isContinueStatement(last) && !last.label ? last : undefined;
  if (before) statements.pop();
  return statements.every(isLogStatement) ? { block, before } : undefined;
}

function insertWait({ block, before }: WaitPosition, line: string, text: string): TextEdit {
  if (before) {
    const indentation = indentationAt(text, before.getStart());
    const multiline = text.slice(lineStart(text, before.getStart()), before.getStart()).trim() === '';
    return {
      start: before.getStart(),
      end: before.getStart(),
      text: multiline ? `${line}\n${indentation}` : `${line} `,
    };
  }
  const closing = block.end - 1;
  const last = block.statements[block.statements.length - 1];
  if (last && text.slice(last.end, closing).includes('\n')) {
    return { start: last.end, end: last.end, text: `\n${indentationAt(text, last.getStart())}${line}` };
  }
  if (!last && text.slice(block.getStart(), closing).includes('\n')) {
    const indentation = indentationAt(text, closing);
    return { start: block.getStart() + 1, end: closing, text: `\n${indentation}  ${line}\n${indentation}` };
  }
  return { start: last ? last.end : block.getStart() + 1, end: closing, text: ` ${line} ` };
}

function loopBackoffFix(call: CallExpression, text: string): FixResult | undefined {
  const found = retryLoop(call);
  if (!found) return;
  const position = waitPosition(found.catchClause.block);
  if (!position) return;
  const { counter } = found;
  const line = `await new Promise((resolve) => setTimeout(resolve, 2 ** ${counter} * 100 + Math.random() * 100));`;
  return finished([insertWait(position, line, text)], loopBackoffNote);
}

function isAxiosRetryDefaultImport(identifier: Identifier, sourceFile: SourceFile): boolean {
  return sourceFile.statements.some(
    (statement: Statement) =>
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text === 'axios-retry' &&
      statement.importClause?.name?.text === identifier.text,
  );
}

function axiosRetryFix(call: CallExpression, callee: Identifier, text: string): TextEdit | undefined {
  const property = `retryDelay: ${callee.text}.exponentialDelay`;
  const options = call.arguments[1] && ts.skipOuterExpressions(call.arguments[1]);
  if (!options) return call.arguments.length === 1 ? addOptionsArgument(call, property, text) : undefined;
  if (!ts.isObjectLiteralExpression(options) || hasSpread(options) || propertyNamed(options, 'retryDelay')) return;
  return addProperty(options, property, text);
}

function retryBackoffFix(context: SiteFixInput): FixResult | undefined {
  const { node, sourceFile, text } = context;
  if (!node || !sourceFile || text === undefined) return;
  const call = ts.findAncestor(node, ts.isCallExpression);
  if (!call) return;
  const callee = ts.skipOuterExpressions(call.expression);
  if (ts.isIdentifier(callee) && isAxiosRetryDefaultImport(callee, sourceFile)) {
    const edit = axiosRetryFix(call, callee, text);
    return edit && finished([edit], axiosRetryNote);
  }
  return loopBackoffFix(call, text);
}

export default {
  'orm-cartesian-include': cartesianIncludeFix,
  'redis-incr-then-expire': incrThenExpireFix,
  'index-redundant-prefix': redundantPrefixFix,
  'retry-without-backoff': retryBackoffFix,
};
