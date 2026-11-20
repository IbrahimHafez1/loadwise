'use strict';

const fs = require('node:fs');
// Configuration is loaded before the CLI picks its TypeScript backend.
let ts;

const READS = new Set([
  'findMany',
  'findUnique',
  'findUniqueOrThrow',
  'findFirst',
  'findFirstOrThrow',
  'count',
  'aggregate',
  'groupBy',
  'delete',
  'deleteMany',
]);
const UPDATES = new Set(['update', 'updateMany', 'updateManyAndReturn']);
const CREATES = new Set(['create', 'createMany', 'createManyAndReturn']);
const KNOWN = new Set([...READS, ...UPDATES, ...CREATES, 'upsert', 'findRaw', 'aggregateRaw']);
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MODULE_NAME = /^(?:#|@(?:[\w-][\w.-]*)?\/)?[\w-][\w.-]*(?:\/[\w-][\w.-]*)*$/;

function stableModuleName(value) {
  return typeof value === 'string' && MODULE_NAME.test(value);
}

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function rejectDuplicateKeys(contents) {
  // JSON.parse already checked syntax. Walk only strings and object boundaries
  // because it otherwise silently discards the first declaration of a scope.
  const objects = [];
  for (const token of contents.matchAll(/("(?:\\.|[^"\\])*")\s*(:)?|[{}]/g)) {
    if (token[0] === '{') objects.push(new Set());
    else if (token[0] === '}') objects.pop();
    else if (token[2]) {
      const names = objects.at(-1);
      const key = JSON.parse(token[1]);
      if (names.has(key)) throw new TypeError('Duplicate query policy key at character ' + (token.index + 1) + '.');
      names.add(key);
    }
  }
}

function loadQueryPolicy(filename) {
  const contents = fs.readFileSync(filename, 'utf8').replace(/^\uFEFF/, '');
  let policy;
  try {
    policy = JSON.parse(contents);
  } catch {
    throw new TypeError('Query policy file contains invalid JSON.');
  }
  rejectDuplicateKeys(contents);
  return validateQueryPolicy(policy);
}

// Also validates the "performance" section of loadwise.config.json, which holds the same policy.
function validateQueryPolicy(policy) {
  if (
    !record(policy) ||
    !Object.keys(policy).length ||
    Object.keys(policy).some((key) => !['prismaScopes', 'drizzleScopes', 'parallelReads'].includes(key))
  ) {
    throw new TypeError('Expected a query policy containing prismaScopes, drizzleScopes or parallelReads.');
  }
  for (const section of ['prismaScopes', 'drizzleScopes']) {
    if (!(section in policy)) continue;
    const scopes = policy[section];
    if (!record(scopes) || !Object.keys(scopes).length)
      throw new TypeError('Expected a nonempty ' + section + ' policy.');
    const drizzle = section === 'drizzleScopes';
    for (const [name, scope] of Object.entries(scopes)) {
      if (
        !NAME.test(name) ||
        !record(scope) ||
        Object.keys(scope).sort().join(',') !== (drizzle ? 'export,field,from,tableFrom' : 'export,field,from') ||
        typeof scope.field !== 'string' ||
        !scope.field.length ||
        scope.field === '__proto__' ||
        (!drizzle && !NAME.test(scope.field)) ||
        typeof scope.export !== 'string' ||
        !NAME.test(scope.export) ||
        !stableModuleName(scope.from) ||
        (drizzle && !stableModuleName(scope.tableFrom))
      ) {
        throw new TypeError('Invalid ' + section + ' entry. Supply literal names and stable module specifiers.');
      }
      if (!drizzle && ['AND', 'OR', 'NOT'].includes(scope.field)) {
        throw new TypeError(
          'Prisma exposes AND, OR and NOT as logical filters. Choose a distinct Prisma scalar field name and use @map to preserve the database column name.',
        );
      }
    }
  }
  if ('parallelReads' in policy)
    policy.parallelReads = require('./parallel-reads.cjs').validateParallelReads(policy.parallelReads);
  return policy;
}

function plain(node) {
  while (node && (ts.isParenthesizedExpression(node) || ts.isSatisfiesExpression(node))) node = node.expression;
  return node;
}

function fields(expression) {
  const node = plain(expression);
  if (!node || !ts.isObjectLiteralExpression(node)) return;
  const values = new Map();
  for (const property of node.properties) {
    if (
      !(ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) ||
      !(ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) ||
      values.has(property.name.text) ||
      property.name.text === '__proto__'
    )
      return;
    values.set(property.name.text, property.initializer ?? property.name);
  }
  return values;
}

function scalar(type, nullable) {
  if (type.isUnion()) return type.types.length > 0 && type.types.every((member) => scalar(member, nullable));
  // A branded primitive is still its underlying scalar at runtime.
  if (type.flags & ts.TypeFlags.Intersection) return type.types.some((member) => scalar(member, nullable));
  const flags = ts.TypeFlags;
  return Boolean(
    type.flags &
    (flags.StringLike |
      flags.NumberLike |
      flags.BigIntLike |
      flags.BooleanLike |
      (nullable ? flags.Null | flags.Undefined : 0)),
  );
}

function importedMember(target, checker) {
  target = plain(target);
  const qualified = ts.isPropertyAccessExpression(target);
  if (qualified && ts.isOptionalChain(target)) return;
  const identifier = qualified ? target.expression : target;
  if (!ts.isIdentifier(identifier)) return;
  const binding = checker.getSymbolAtLocation(identifier)?.declarations?.[0];
  if (!binding) return;
  const statement = ts.findAncestor(binding, ts.isImportDeclaration);
  if (
    !statement ||
    statement.importClause?.isTypeOnly ||
    !ts.isStringLiteral(statement.moduleSpecifier) ||
    binding.isTypeOnly
  )
    return;
  let exported;
  if (qualified && ts.isNamespaceImport(binding)) exported = target.name.text;
  if (!qualified && ts.isImportClause(binding)) exported = 'default';
  if (!qualified && ts.isImportSpecifier(binding)) exported = (binding.propertyName ?? binding.name).text;
  if (exported) return { from: statement.moduleSpecifier.text, exported };
}

function trustedValue(expression, scope, checker) {
  let node = plain(expression);
  const visited = new Set();
  while (node) {
    if (!scalar(checker.getTypeAtLocation(node), false)) return false;
    if (ts.isIdentifier(node)) {
      const symbol = ts.isShorthandPropertyAssignment(node.parent)
        ? checker.getShorthandAssignmentValueSymbol(node.parent)
        : checker.getSymbolAtLocation(node);
      const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
      if (
        !declaration ||
        !ts.isVariableDeclaration(declaration) ||
        visited.has(declaration) ||
        !(declaration.parent.flags & ts.NodeFlags.Const)
      )
        return false;
      visited.add(declaration);
      node = plain(declaration.initializer);
      continue;
    }
    if (ts.isAwaitExpression(node)) node = plain(node.expression);
    if (!ts.isCallExpression(node) || ts.isOptionalChain(node)) return false;
    const imported = importedMember(node.expression, checker);
    return imported?.from === scope.from && imported.exported === scope.export;
  }
  return false;
}

function scopedWhere(expression, scope, checker) {
  const condition = fields(expression);
  if (!condition) return false;
  const direct = condition.get(scope.field);
  if (direct) {
    const equality = fields(direct);
    if (
      trustedValue(direct, scope, checker) ||
      (equality?.size === 1 && equality.has('equals') && trustedValue(equality.get('equals'), scope, checker))
    )
      return true;
  }
  // Any verified conjunct narrows every result. Every alternative of a disjunction must narrow it.
  const conjunction = plain(condition.get('AND'));
  if (
    conjunction &&
    (ts.isArrayLiteralExpression(conjunction)
      ? conjunction.elements.some((element) => scopedWhere(element, scope, checker))
      : scopedWhere(conjunction, scope, checker))
  )
    return true;
  const alternatives = plain(condition.get('OR'));
  return Boolean(
    alternatives &&
    ts.isArrayLiteralExpression(alternatives) &&
    alternatives.elements.length &&
    alternatives.elements.every((element) => scopedWhere(element, scope, checker)),
  );
}

function scopedData(expression, scope, checker, creating, allowPrismaSet = true) {
  const data = fields(expression);
  if (!data || (creating && !data.has(scope.field))) return false;
  for (const [field, value] of data) {
    const node = plain(value);
    if (field === scope.field) {
      const assignment = fields(value);
      if (
        !trustedValue(value, scope, checker) &&
        !(
          !creating &&
          allowPrismaSet &&
          assignment?.size === 1 &&
          assignment.has('set') &&
          trustedValue(assignment.get('set'), scope, checker)
        )
      )
        return false;
    } else if (
      ts.isObjectLiteralExpression(node) ||
      ts.isArrayLiteralExpression(node) ||
      ts.isAsExpression(node) ||
      node.kind === ts.SyntaxKind.TypeAssertionExpression ||
      !scalar(checker.getTypeAtLocation(value), true)
    ) {
      // A nested Prisma relation write can change ownership through another model.
      return false;
    }
  }
  return true;
}

function booleanSelection(type) {
  if (!type) return false;
  if (type.isUnion()) return type.types.every(booleanSelection);
  return Boolean(type.flags & (ts.TypeFlags.BooleanLike | ts.TypeFlags.Undefined));
}

function scalarProjection(options, scope, checker) {
  if (options.has('include')) return false;
  if (!options.has('select')) return true;
  const selection = fields(options.get('select'));
  return (
    selection &&
    [...selection].every(
      ([key, value]) =>
        value.kind === ts.SyntaxKind.FalseKeyword ||
        (value.kind === ts.SyntaxKind.TrueKeyword &&
          (key === scope.field || booleanSelection(checker.getContextualType(value)))),
    )
  );
}

function missingEvidence(call, operation, scope, context) {
  if (!context.strictNullChecks) return 'Enable strictNullChecks to verify the scope value.';
  let result = call;
  while (ts.isParenthesizedExpression(result.parent)) result = result.parent;
  const chained = result.parent;
  if (
    (ts.isPropertyAccessExpression(chained) || ts.isElementAccessExpression(chained)) &&
    chained.expression === result &&
    ts.isCallExpression(chained.parent) &&
    chained.parent.expression === chained
  ) {
    const name = ts.isPropertyAccessExpression(chained) ? chained.name : chained.argumentExpression;
    if (!['then', 'catch', 'finally'].includes(name.text))
      return 'A chained relation lookup needs a separate scope review.';
  }
  const options = fields(call.arguments[0]);
  if (call.arguments.length !== 1 || !options) return 'Use explicit query options so the scope can be checked.';
  const checker = context.checker;
  if (!scalarProjection(options, scope, checker))
    return 'The projection may return related records. Verify their scope separately.';
  if (!(READS.has(operation) || UPDATES.has(operation) || CREATES.has(operation) || operation === 'upsert')) {
    return 'This delegate operation needs a separate scope review.';
  }
  if (!CREATES.has(operation) && !scopedWhere(options.get('where'), scope, checker)) {
    return 'Constrain where.' + scope.field + ' to the scalar returned by the configured authorization function.';
  }
  if (CREATES.has(operation)) {
    const data = plain(options.get('data'));
    const rows = data && operation !== 'create' && ts.isArrayLiteralExpression(data) ? data.elements : [data];
    if (!rows.length || !rows.every((row) => scopedData(row, scope, checker, true))) {
      return 'Each created row needs a proven scope and verifiable scalar write data.';
    }
  }
  if (UPDATES.has(operation) && !scopedData(options.get('data'), scope, checker, false)) {
    return 'Verify the update preserves the authorized scope, including any nested relation writes.';
  }
  if (
    operation === 'upsert' &&
    !(
      scopedData(options.get('create'), scope, checker, true) &&
      scopedData(options.get('update'), scope, checker, false)
    )
  ) {
    return 'Verify the scope of both the create and update branches.';
  }
}

function checkQueryPolicy(call, context, policy) {
  const scopes = policy?.prismaScopes;
  if (!scopes) return;
  ts ??= require('./compiler.cjs').syntax;
  const access = call.expression;
  const dot = ts.isPropertyAccessExpression(access);
  if (!dot && !ts.isElementAccessExpression(access)) return;
  const key = dot ? access.name : access.argumentExpression;
  const operation = dot || ts.isStringLiteralLike(key) ? key.text : '';
  const receiver = access.expression;
  const spelling = ts.isPropertyAccessExpression(receiver)
    ? receiver.name.text
    : ts.isIdentifier(receiver)
      ? receiver.text
      : '';
  const configuredName =
    spelling &&
    (Object.hasOwn(scopes, spelling) || Object.hasOwn(scopes, spelling[0].toUpperCase() + spelling.slice(1)));
  const dynamicKey = !dot && !ts.isStringLiteralLike(key);
  if (!KNOWN.has(operation) && !configuredName && !dynamicKey) return;
  const { prismaModelName, prismaModelNameFromReceiver } = require('./prisma.cjs');
  const model = operation && prismaModelName(key, context.checker);
  const verifiedModel =
    model || ((configuredName || dynamicKey) && prismaModelNameFromReceiver(receiver, context.checker));
  if (!verifiedModel || !Object.hasOwn(scopes, verifiedModel)) return;
  const detail =
    model || (!dot && KNOWN.has(operation))
      ? missingEvidence(call, operation, scopes[verifiedModel], context)
      : 'This delegate operation needs a separate scope review.';
  if (detail) context.report(key, 'prisma-scope-unverified', verifiedModel + ' scope policy: ' + detail);
}

function scopeEvidence() {
  ts ??= require('./compiler.cjs').syntax;
  return { fields, importedMember, plain, scalar, scopedData, trustedValue };
}

module.exports = {
  loadQueryPolicy,
  rejectDuplicateKeys,
  validateQueryPolicy,
  checkQueryPolicy,
  scopeEvidence,
  stableModuleName,
};
