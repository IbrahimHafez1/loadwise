'use strict';

// Fixes for query shapes that cost extra round trips or rows: cartesian includes, a counter and its expiry sent
// apart, redundant prefix indexes and retries without backoff.
const path = require('node:path');
const {
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
} = require('./helpers.cjs');

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

function propertyName(property) {
  const name = property.name;
  if (name && (ts.isIdentifier(name) || ts.isStringLiteral(name))) return name.text;
}

function propertyNamed(literal, name) {
  return literal.properties.find((property) => propertyName(property) === name);
}

function stringValue(node) {
  const value = node && ts.skipOuterExpressions(node);
  return value && ts.isStringLiteralLike(value) ? value.text : undefined;
}

function hasSpread(literal) {
  return literal.properties.some((property) => !ts.isPropertyAssignment(property));
}

function methodCall(node) {
  const call = calleeCall(node);
  return call && ts.isPropertyAccessExpression(call.expression) ? call : undefined;
}

function finished(edits, note) {
  return edits && { edits, note, requiresReview: true };
}

// --- orm-cartesian-include ---------------------------------------------------------------------------------------

// `repo.find({ relations: [...] })` or `manager.find(User, { relations })`: load each relation in its own query.
function typeormFix(call, text) {
  if (!typeormFindMethods.has(call.expression.name.text)) return;
  const options = call.arguments
    .map((argument) => ts.skipOuterExpressions(argument))
    .find((argument) => ts.isObjectLiteralExpression(argument) && propertyNamed(argument, 'relations'));
  if (!options || hasSpread(options) || propertyNamed(options, 'relationLoadStrategy')) return;
  return finished([addProperty(options, "relationLoadStrategy: 'query'", text)], typeormNote);
}

// Source files that may declare the associations: this file and the files it imports by relative path.
function associationFiles(sourceFile, load) {
  const files = [sourceFile];
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const specifier = statement.moduleSpecifier.text;
    if (!specifier.startsWith('.')) continue;
    const base = path.resolve(path.dirname(sourceFile.fileName), specifier.replace(/\.[cm]?js$/, ''));
    const loaded = moduleExtensions.map((extension) => load(base + extension)).find((entry) => entry?.sourceFile);
    if (loaded) files.push(loaded.sourceFile);
  }
  return files;
}

// `Parent.hasMany(Model, { as })` calls and `@HasMany(() => Model) name` properties as { parent, model, kind, as }.
function associationsIn(sourceFile) {
  const found = [];
  (function visit(node) {
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

function decoratedAssociation(property) {
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

// { model, alias, literal } for `Post` or `{ model: Post, as: 'posts' }`; undefined for shapes not rewritten.
function includeEntry(element) {
  const value = ts.skipOuterExpressions(element);
  if (ts.isIdentifier(value)) return { model: value.text };
  if (!ts.isObjectLiteralExpression(value) || hasSpread(value)) return;
  if (propertyNamed(value, 'include')) return;
  const model = propertyNamed(value, 'model');
  const alias = propertyNamed(value, 'as') ?? propertyNamed(value, 'association');
  if (model && !ts.isIdentifier(model.initializer)) return;
  const separate = propertyNamed(value, 'separate');
  return {
    model: model?.initializer.text,
    alias: alias && stringValue(alias.initializer),
    literal: value,
    separate: separate && separate.initializer.kind === ts.SyntaxKind.TrueKeyword,
  };
}

// True when every association of `parent` that the include names is a hasMany, and at least one is.
function isHasMany(entry, parent, associations) {
  if (!entry.model && !entry.alias) return false;
  const matching = associations.filter(
    (association) =>
      association.parent === parent &&
      (entry.alias ? association.as === entry.alias : association.model === entry.model) &&
      (!entry.model || !association.model || association.model === entry.model),
  );
  return matching.length > 0 && matching.every((association) => association.kind === 'hasMany');
}

// `Author.findAll({ include: [Post, { model: Tag }] })`: every hasMany include after the first gets `separate: true`.
function sequelizeFix(call, { sourceFile, text, load }) {
  const optionsIndex = sequelizeFindMethods.get(call.expression.name.text);
  const options = call.arguments[optionsIndex] && ts.skipOuterExpressions(call.arguments[optionsIndex]);
  const parent = ts.skipOuterExpressions(call.expression.expression);
  if (!options || !ts.isObjectLiteralExpression(options) || !ts.isIdentifier(parent)) return;
  if (hasSpread(options) || propertyNamed(options, 'attributes')) return;
  const include = propertyNamed(options, 'include');
  const list = include && ts.skipOuterExpressions(include.initializer);
  if (!list || !ts.isArrayLiteralExpression(list)) return;
  const entries = list.elements.map((element) => ({ element, entry: includeEntry(element) }));
  if (entries.some(({ entry }) => !entry)) return;
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

function cartesianIncludeFix(context) {
  const call = methodCall(context.node);
  if (!call) return;
  if (context.finding.message.includes('separate: true')) {
    if (sequelizeFindMethods.has(call.expression.name.text)) return sequelizeFix(call, context);
    return;
  }
  return typeormFix(call, context.text);
}

// --- redis-incr-then-expire --------------------------------------------------------------------------------------

function importsPackage(sourceFile, packages) {
  return sourceFile.statements.some(
    (statement) =>
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      packages.has(statement.moduleSpecifier.text),
  );
}

// `await client.method(...)` as the call, or undefined.
function awaitedCall(expression) {
  const awaited = expression && ts.skipOuterExpressions(expression);
  if (!awaited || !ts.isAwaitExpression(awaited)) return;
  const call = ts.skipOuterExpressions(awaited.expression);
  return ts.isCallExpression(call) && ts.isPropertyAccessExpression(call.expression) ? call : undefined;
}

function nextStatement(statement) {
  const siblings = statement.parent.statements;
  return siblings?.[siblings.indexOf(statement) + 1];
}

// The `await client.expire(key, ttl)` statement right after the counter, on the same client and key.
function adjacentExpire(statement, counter) {
  const next = nextStatement(statement);
  if (!next || !ts.isExpressionStatement(next)) return;
  const expire = awaitedCall(next.expression);
  if (!expire || !expireCommands.has(expire.expression.name.text.toLowerCase())) return;
  if (textOf(expire.expression.expression) !== textOf(counter.expression.expression)) return;
  if (!expire.arguments[0] || textOf(expire.arguments[0]) !== textOf(counter.arguments[0])) return;
  return { statement: next, call: expire };
}

function multiText(counter, expire) {
  const command = (call) => `${call.expression.name.text}(${call.arguments.map(textOf).join(', ')})`;
  return `await ${textOf(counter.expression.expression)}.multi().${command(counter)}.${command(expire)}.exec();`;
}

function incrThenExpireFix({ node, sourceFile }) {
  const counter = methodCall(node);
  if (!counter || !counterCommands.has(counter.expression.name.text.toLowerCase()) || !counter.arguments[0]) return;
  const statement = enclosingStatement(counter);
  if (!statement) return;
  if (ts.isExpressionStatement(statement)) {
    if (awaitedCall(statement.expression) !== counter) return;
    const expire = adjacentExpire(statement, counter);
    if (!expire) return;
    const edit = { start: statement.getStart(), end: expire.statement.end, text: multiText(counter, expire.call) };
    return finished([edit], multiNote);
  }
  return assignedCounterFix(statement, counter, sourceFile);
}

// `const count = await redis.incr(key)` only with ioredis, whose exec() reply holds `[error, value]` pairs.
function assignedCounterFix(statement, counter, sourceFile) {
  if (!ts.isVariableStatement(statement) || statement.declarationList.declarations.length !== 1) return;
  if (!importsPackage(sourceFile, new Set(['ioredis'])) || importsPackage(sourceFile, nodeRedisPackages)) return;
  const [declaration] = statement.declarationList.declarations;
  if (!ts.isIdentifier(declaration.name) || declaration.type || awaitedCall(declaration.initializer) !== counter)
    return;
  const expire = adjacentExpire(statement, counter);
  if (!expire) return;
  const keyword = statement.declarationList.flags & ts.NodeFlags.Const ? 'const' : 'let';
  const edit = {
    start: statement.declarationList.getStart(),
    end: expire.statement.end,
    text: `${keyword} [[, ${declaration.name.text}]] = ${multiText(counter, expire.call)}`,
  };
  return finished([edit], assignedMultiNote);
}

// --- index-redundant-prefix --------------------------------------------------------------------------------------

function balanced(line) {
  let depth = 0;
  for (const character of line) {
    if (character === '(' || character === '[') depth++;
    if (character === ')' || character === ']') depth--;
  }
  return depth === 0;
}

// Removes the lines from `start` (a line start) to `end` (just past a line break, or the end of the text). Fixes are
// shown and applied line by line, where deleting a line's text alone would leave it behind empty, so the removal
// also takes the line break before the first line.
function wholeLinesRemoval(text, start, end) {
  if (start === 0) return { start, end, text: '' };
  // The offset of the line break that ends just before `offset`.
  const lineBreakBefore = (offset) => (text[offset - 2] === '\r' ? offset - 2 : offset - 1);
  const lastLineEnd = text[end - 1] === '\n' ? lineBreakBefore(end) : end;
  return { start: lineBreakBefore(start), end: lastLineEnd, text: '' };
}

// The flagged `@@index([...])` line of a Prisma schema, removed whole when the attribute fits on it.
function prismaIndexFix({ finding, text }) {
  const start = lineStartOfLine(text, finding.line);
  if (start === undefined) return;
  const newline = text.indexOf('\n', start);
  const end = newline === -1 ? text.length : newline + 1;
  const line = text.slice(start, end);
  if (!/^\s*@@index\(/.test(line) || !balanced(line.replace(/\/\/.*$/, ''))) return;
  return finished([wholeLinesRemoval(text, start, end)], prismaIndexNote);
}

function lineStartOfLine(text, line) {
  let offset = 0;
  for (let current = 1; current < line; current++) {
    offset = text.indexOf('\n', offset) + 1;
    if (offset === 0) return;
  }
  return offset;
}

function isTableCall(call) {
  const callee = call.expression;
  const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) && callee.name.text;
  return !!name && /^(\w*Table|table)$/.test(name);
}

// The array or object the third `pgTable(...)` argument returns, as written by the extra-config callback.
function isExtraConfigList(list) {
  let returned = list;
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
function indexBuilderName(expression) {
  let current = ts.skipOuterExpressions(expression);
  while (ts.isCallExpression(current) && ts.isPropertyAccessExpression(current.expression)) {
    current = ts.skipOuterExpressions(current.expression.expression);
  }
  return ts.isCallExpression(current) && ts.isIdentifier(current.expression) ? current.expression.text : undefined;
}

// Removes one entry from a list: its whole line when it stands alone, otherwise the entry and one separator.
function removeListEntry(entry, entries, text) {
  const start = entry.getStart();
  const position = entries.indexOf(entry);
  const comma = /^\s*,/.exec(text.slice(entry.end));
  const afterEntry = comma ? entry.end + comma[0].length : entry.end;
  const restOfLine = /^[ \t]*(\r?\n)/.exec(text.slice(afterEntry));
  const ownLine = text.slice(lineStart(text, start), start).trim() === '';
  if (ownLine && restOfLine) return wholeLinesRemoval(text, lineStart(text, start), afterEntry + restOfLine[0].length);
  if (position < entries.length - 1) return { start, end: entries[position + 1].getStart(), text: '' };
  if (position > 0) return { start: entries[position - 1].end, end: entry.end, text: '' };
  return { start, end: afterEntry, text: '' };
}

function drizzleIndexFix({ node, text }) {
  const entry = ancestor(
    node,
    (current) =>
      (ts.isArrayLiteralExpression(current.parent) && current.parent.elements.includes(current)) ||
      (ts.isPropertyAssignment(current) && ts.isObjectLiteralExpression(current.parent)),
  );
  if (!entry || !isExtraConfigList(entry.parent)) return;
  const expression = ts.isPropertyAssignment(entry) ? entry.initializer : entry;
  if (!drizzleIndexBuilders.has(indexBuilderName(expression))) return;
  const entries = ts.isArrayLiteralExpression(entry.parent) ? entry.parent.elements : entry.parent.properties;
  return finished([removeListEntry(entry, [...entries], text)], drizzleIndexNote);
}

function redundantPrefixFix(context) {
  if (typeof context.finding.file === 'string' && context.finding.file.endsWith('.prisma')) {
    return prismaIndexFix(context);
  }
  if (context.node) return drizzleIndexFix(context);
}

// --- retry-without-backoff ---------------------------------------------------------------------------------------

function isAsyncFunction(node) {
  return !!node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword);
}

// The try around `node` and the `for (let attempt = ...)` loop that retries it, inside one async function.
function retryLoop(node) {
  let tryStatement;
  let child = node;
  for (let parent = node.parent; parent; child = parent, parent = parent.parent) {
    if (ts.isFunctionLike(parent)) return;
    if (!tryStatement && ts.isTryStatement(parent) && parent.tryBlock === child) tryStatement = parent;
    if (!tryStatement || !(ts.isForStatement(parent) || ts.isWhileStatement(parent) || ts.isDoStatement(parent)))
      continue;
    const counter = ts.isForStatement(parent) && loopCounter(parent);
    const owner = ancestor(parent, (current) => ts.isFunctionLike(current));
    if (!counter || !tryStatement.catchClause || !owner || !isAsyncFunction(owner)) return;
    return { tryStatement, counter };
  }
}

function loopCounter(loop) {
  const initializer = loop.initializer;
  if (!initializer || !ts.isVariableDeclarationList(initializer) || initializer.declarations.length !== 1) return;
  const [declaration] = initializer.declarations;
  return ts.isIdentifier(declaration.name) && loop.incrementor ? declaration.name.text : undefined;
}

function isLogStatement(statement) {
  if (!ts.isExpressionStatement(statement)) return false;
  const call = ts.skipOuterExpressions(statement.expression);
  return ts.isCallExpression(call) && logCallee.test(textOf(call.expression));
}

// The catch body when it only logs, optionally ending in `continue`, as { block, before } where the wait goes in
// front of `before` (or at the end of the block when undefined).
function waitPosition(block) {
  const statements = [...block.statements];
  const last = statements[statements.length - 1];
  const before = last && ts.isContinueStatement(last) && !last.label ? last : undefined;
  if (before) statements.pop();
  return statements.every(isLogStatement) ? { block, before } : undefined;
}

function insertWait({ block, before }, line, text) {
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

function loopBackoffFix(call, text) {
  const found = retryLoop(call);
  const position = found && waitPosition(found.tryStatement.catchClause.block);
  if (!position) return;
  const { counter } = found;
  const line = `await new Promise((resolve) => setTimeout(resolve, 2 ** ${counter} * 100 + Math.random() * 100));`;
  return finished([insertWait(position, line, text)], loopBackoffNote);
}

function isAxiosRetryDefaultImport(identifier, sourceFile) {
  return sourceFile.statements.some(
    (statement) =>
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text === 'axios-retry' &&
      statement.importClause?.name?.text === identifier.text,
  );
}

function axiosRetryFix(call, text) {
  const property = `retryDelay: ${call.expression.text}.exponentialDelay`;
  const options = call.arguments[1] && ts.skipOuterExpressions(call.arguments[1]);
  if (!options) return call.arguments.length === 1 ? addOptionsArgument(call, property, text) : undefined;
  if (!ts.isObjectLiteralExpression(options) || hasSpread(options) || propertyNamed(options, 'retryDelay')) return;
  return addProperty(options, property, text);
}

function retryBackoffFix(context) {
  const call = ancestor(context.node, ts.isCallExpression);
  if (!call) return;
  const callee = ts.skipOuterExpressions(call.expression);
  if (ts.isIdentifier(callee) && isAxiosRetryDefaultImport(callee, context.sourceFile)) {
    const edit = axiosRetryFix(call, context.text);
    return edit && finished([edit], axiosRetryNote);
  }
  return loopBackoffFix(call, context.text);
}

module.exports = {
  'orm-cartesian-include': cartesianIncludeFix,
  'redis-incr-then-expire': incrThenExpireFix,
  'index-redundant-prefix': redundantPrefixFix,
  'retry-without-backoff': retryBackoffFix,
};
