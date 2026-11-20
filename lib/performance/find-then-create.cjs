'use strict';

const { syntax: ts } = require('./compiler.cjs');
const { prismaModelName } = require('./prisma.cjs');
const { awaitedResult, outsideWrappers } = require('./query-results.cjs');
const { prismaTableFor, repositoryEntity } = require('./schema/query-sites.cjs');
const { typeormTableOf } = require('./schema/typeorm-schema.cjs');
const { projectRootOf, migrationIndexes, tableKey } = require('./schema/project-indexes.cjs');
const { declaredInPackage, resolvedSymbol, propertyName } = require('./schema/ts-helpers.cjs');

const rule = 'find-then-create-race';
const prismaLookups = new Set(['findFirst', 'findUnique']);
const typeormLookups = new Set(['findOne', 'findOneBy']);
const typeormCreates = new Set(['save', 'insert']);
const logicalFilters = new Set(['AND', 'OR', 'NOT']);
// Text that shows the function already serializes the check or handles the duplicate: a serializable transaction,
// a row or advisory lock, or code that catches the unique violation (Prisma P2002, Postgres 23505, MySQL 1062).
const protectionPattern =
  /serializable|for\s+(?:update|share)|pessimistic_|pg_advisory|forUpdate|\bP2002\b|\b23505\b|ER_DUP_ENTRY|unique constraint/i;
const lookupsByFunction = new WeakMap();

function normalized(node) {
  return node.getText().replace(/\s+/g, '');
}

// `{ email, name: dto.name }` as name -> value text; undefined when a spread or method could hide the key.
function objectFields(literal, valueOf) {
  if (!literal || !ts.isObjectLiteralExpression(literal)) return;
  const fields = new Map();
  for (const property of literal.properties) {
    const name =
      ts.isShorthandPropertyAssignment(property) || ts.isPropertyAssignment(property)
        ? propertyName(property)
        : undefined;
    if (!name) return;
    const value = valueOf(property);
    if (value === undefined) return;
    fields.set(name, value);
  }
  return fields.size > 0 ? fields : undefined;
}

const plainValue = (property) =>
  ts.isShorthandPropertyAssignment(property) ? property.name.text : normalized(property.initializer);

// An equality filter: a plain value, or `{ equals: value }`. Operators and nested filters do not pin one row.
function equalityValue(property, checker) {
  if (ts.isShorthandPropertyAssignment(property)) return property.name.text;
  const value = ts.skipOuterExpressions(property.initializer);
  if (ts.isObjectLiteralExpression(value)) {
    const [only] = value.properties;
    const isEquals = value.properties.length === 1 && ts.isPropertyAssignment(only) && propertyName(only) === 'equals';
    return isEquals ? normalized(only.initializer) : undefined;
  }
  if (ts.isArrayLiteralExpression(value)) return;
  if (
    ts.isCallExpression(value) &&
    ts.isIdentifier(value.expression) &&
    declaredInPackage(value.expression, checker, ['typeorm'])
  )
    return;
  return normalized(value);
}

function whereFields(literal, checker) {
  const fields = objectFields(literal, (property) => equalityValue(property, checker));
  return fields && ![...fields.keys()].some((name) => logicalFilters.has(name)) ? fields : undefined;
}

function optionProperty(options, name) {
  const literal = options && ts.skipOuterExpressions(options);
  if (!literal || !ts.isObjectLiteralExpression(literal)) return;
  const found = literal.properties.find(
    (property) => ts.isPropertyAssignment(property) && propertyName(property) === name,
  );
  return found && ts.skipOuterExpressions(found.initializer);
}

// The entity and the arguments after it, for a Repository call or an EntityManager call that names the entity first.
function typeormTarget(call, checker) {
  const access = call.expression;
  if (!declaredInPackage(access, checker, ['typeorm'])) return;
  const owner = resolvedSymbol(access, checker)?.declarations?.[0]?.parent;
  const ownerName = owner && ts.isClassDeclaration(owner) ? owner.name?.text : undefined;
  if (ownerName === 'BaseEntity') return;
  const args = [...call.arguments];
  const entity = ownerName === 'EntityManager' ? args.shift() : repositoryEntity(access.expression, checker);
  if (!entity) return;
  const table = typeormTableOf(entity, checker);
  return { entity, args, table, model: 'typeorm:' + (table?.name ?? normalized(entity)) };
}

function prismaTarget(call, checker) {
  const access = call.expression;
  const modelName = prismaModelName(access.name, checker);
  if (!modelName) return;
  return { table: prismaTableFor(access, checker), model: 'prisma:' + modelName };
}

function lookupOf(call, checker) {
  const access = call.expression;
  if (!ts.isPropertyAccessExpression(access)) return;
  const method = access.name.text;
  if (prismaLookups.has(method)) {
    const target = prismaTarget(call, checker);
    const fields = target && whereFields(optionProperty(call.arguments[0], 'where'), checker);
    return fields && { ...target, call, method, fields };
  }
  if (!typeormLookups.has(method)) return;
  const target = typeormTarget(call, checker);
  if (!target) return;
  const [first] = target.args;
  if (method === 'findOne' && optionProperty(first, 'lock')) return;
  const where = method === 'findOneBy' ? first && ts.skipOuterExpressions(first) : optionProperty(first, 'where');
  const fields = whereFields(where, checker);
  return fields && { ...target, call, method, fields };
}

// `repo.create({...})` builds the entity in memory, so `save(repo.create({...}))` writes what the literal holds.
function entityLiteral(argument) {
  const value = argument && ts.skipOuterExpressions(argument);
  if (
    value &&
    ts.isCallExpression(value) &&
    ts.isPropertyAccessExpression(value.expression) &&
    value.expression.name.text === 'create'
  )
    return value.arguments[0] && ts.skipOuterExpressions(value.arguments[0]);
  return value;
}

function creationOf(call, checker) {
  const access = call.expression;
  if (!ts.isPropertyAccessExpression(access)) return;
  const method = access.name.text;
  if (method === 'create') {
    const target = prismaTarget(call, checker);
    const fields = target && objectFields(optionProperty(call.arguments[0], 'data'), plainValue);
    return fields && { ...target, fields, node: access.name, method };
  }
  if (!typeormCreates.has(method)) return;
  const target = typeormTarget(call, checker);
  const fields = target && objectFields(entityLiteral(target.args[0]), plainValue);
  return fields && { ...target, fields, node: access.name, method };
}

function lookupsIn(owner, checker) {
  if (!lookupsByFunction.has(owner)) {
    const lookups = [];
    (function visit(node) {
      if (node !== owner && ts.isFunctionLike(node)) return;
      const lookup = ts.isCallExpression(node) && lookupOf(node, checker);
      if (lookup) lookups.push(lookup);
      ts.forEachChild(node, visit);
    })(owner.body);
    lookupsByFunction.set(owner, lookups);
  }
  return lookupsByFunction.get(owner);
}

function boundNames(call) {
  const awaited = awaitedResult(call);
  const parent = outsideWrappers(awaited ?? call).parent;
  return ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name) ? new Set([parent.name.text]) : new Set();
}

function mentions(root, names, call) {
  let found = false;
  (function visit(node) {
    if (found) return;
    if (node === call || (ts.isIdentifier(node) && names.has(node.text))) found = true;
    else ts.forEachChild(node, visit);
  })(root);
  return found;
}

function exitsEarly(statement) {
  const last = ts.isBlock(statement) ? statement.statements.at(-1) : statement;
  return Boolean(last) && (ts.isReturnStatement(last) || ts.isThrowStatement(last));
}

// The creation only happens because of what the lookup returned: it sits inside an `if` on the result, or follows
// an `if` on the result that returns or throws.
function dependsOnLookup(lookup, creation, owner) {
  const names = boundNames(lookup.call);
  let gated = false;
  (function visit(node) {
    if (gated || (node !== owner && ts.isFunctionLike(node))) return;
    if (ts.isIfStatement(node) && mentions(node.expression, names, lookup.call)) {
      const contains = node.pos <= creation.node.pos && creation.node.end <= node.end;
      const guardsRest = !node.elseStatement && node.end <= creation.node.pos && exitsEarly(node.thenStatement);
      gated = contains || guardsRest;
    }
    ts.forEachChild(node, visit);
  })(owner.body);
  return gated;
}

function outermostFunction(node) {
  let outer;
  for (
    let current = ts.findAncestor(node, ts.isFunctionLike);
    current;
    current = ts.findAncestor(current.parent, ts.isFunctionLike)
  )
    outer = current;
  return outer;
}

// True when a unique index or primary key of the table is made only of looked-up fields: two rows with the same
// key cannot exist, so the second insert fails instead of duplicating.
function enforcesUnique(table, fieldNames) {
  const fieldMatches = (column) =>
    column !== undefined && fieldNames.some((field) => field === column || table.columns.get(field)?.dbName === column);
  return table.indexes.some(
    (index) =>
      (index.unique || index.primary) && index.keys.length > 0 && index.keys.every((key) => fieldMatches(key.column)),
  );
}

// TypeORM entities often omit indexes that a hand-written migration adds; a migration that touches the column silences the rule.
function migrationEnforcesUnique(table, fieldNames) {
  const root = table.file && projectRootOf(table.file);
  const indexes = root && migrationIndexes(root);
  const entry =
    indexes && [tableKey(table.dbName), table.name.toLowerCase()].map((key) => indexes.get(key)).find(Boolean);
  if (!entry) return false;
  const columns = new Set(
    fieldNames
      .flatMap((field) => [field, table.columns.get(field)?.dbName])
      .filter(Boolean)
      .map((name) => name.toLowerCase()),
  );
  const covers = (index) => index.keys.every((key) => columns.has(key.column?.toLowerCase()));
  const touches = (index) => index.keys.some((key) => columns.has(key.column?.toLowerCase()));
  return entry.indexes.some((index) => index.unique && covers(index)) || entry.others.some(touches);
}

function uniquenessVerdict(table, fieldNames) {
  if (!table)
    return {
      reason: 'The schema is not available here, so whether this key already has a unique constraint is unknown.',
    };
  if (enforcesUnique(table, fieldNames) || (table.orm === 'typeorm' && migrationEnforcesUnique(table, fieldNames)))
    return { enforced: true };
  if (table.complete === false)
    return { reason: 'Some entity indexes could not be read, so a unique constraint may exist on this key.' };
  return {};
}

function keyLabel(fieldNames) {
  return fieldNames.map((name) => `\`${name}\``).join(' and ');
}

function check(call, context) {
  const creation = creationOf(call, context.checker);
  if (!creation) return;
  const owner = ts.findAncestor(call, ts.isFunctionLike);
  if (!owner?.body || protectionPattern.test(outermostFunction(call).getText())) return;
  const lookup = lookupsIn(owner, context.checker).find(
    (candidate) =>
      candidate.model === creation.model &&
      candidate.call.end <= call.pos &&
      [...candidate.fields].every(([name, value]) => creation.fields.get(name) === value) &&
      dependsOnLookup(candidate, creation, owner),
  );
  if (!lookup) return;
  const fieldNames = [...lookup.fields.keys()];
  const verdict = uniquenessVerdict(lookup.table ?? creation.table, fieldNames);
  if (verdict.enforced) return;
  context.report(
    creation.node,
    rule,
    `\`${lookup.method}\` looks for ${keyLabel(fieldNames)} and \`${creation.method}\` inserts when nothing is found, but two requests can both find nothing and both insert, leaving a duplicate. ` +
      `Add a unique constraint on ${keyLabel(fieldNames)} and let the insert fail (catch Prisma P2002 or Postgres 23505) or use \`upsert\` / \`INSERT ... ON CONFLICT DO NOTHING\`. ` +
      'Skip it only when a serializable transaction or a lock already guards the pair.',
    verdict.reason,
  );
}

module.exports = { check };
