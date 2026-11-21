'use strict';

const fs = require('node:fs');
// Configuration is loaded before the CLI picks its TypeScript backend.
let ts;

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MODULE_NAME = /^(?:#|@(?:[\w-][\w.-]*)?\/)?[\w-][\w.-]*(?:\/[\w-][\w.-]*)*$/;

function stableModuleName(value) {
  return typeof value === 'string' && MODULE_NAME.test(value);
}

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function rejectDuplicateKeys(contents, label = 'query policy key') {
  // JSON.parse already checked syntax. Walk only strings and object boundaries
  // because it otherwise silently discards the first declaration of a scope.
  const objects = [];
  for (const token of contents.matchAll(/("(?:\\.|[^"\\])*")\s*(:)?|[{}]/g)) {
    if (token[0] === '{') objects.push(new Set());
    else if (token[0] === '}') objects.pop();
    else if (token[2]) {
      const names = objects.at(-1);
      const key = JSON.parse(token[1]);
      if (names.has(key)) throw new TypeError(`Duplicate ${label} at character ${token.index + 1}.`);
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
    Object.keys(policy).some(
      (key) => !['prismaScopes', 'drizzleScopes', 'parallelReads', 'fireAndForget'].includes(key),
    )
  ) {
    throw new TypeError(
      'Expected a query policy containing prismaScopes, drizzleScopes, parallelReads or fireAndForget.',
    );
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
  if ('fireAndForget' in policy) {
    const names = policy.fireAndForget;
    if (!Array.isArray(names) || !names.length || !names.every((name) => typeof name === 'string' && NAME.test(name)))
      throw new TypeError('fireAndForget requires a nonempty array of function or method names.');
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

// A generated filter must read the trusted binding visible at this exact query, after initialization.
function scopeFixEvidence(site, scope, checker) {
  const symbol = checker.resolveName(scope.field, site, ts.SymbolFlags.Value, true);
  const declaration = symbol?.valueDeclaration;
  if (!declaration || !ts.isVariableDeclaration(declaration) || !ts.isIdentifier(declaration.name)) return;
  const statement = declaration.parent.parent;
  if (!ts.isVariableStatement(statement) || statement.end > site.getStart()) return;
  const enclosing = ts.findAncestor(site, (node) => node === statement.parent || ts.isFunctionLike(node));
  if (enclosing !== statement.parent || !trustedValue(declaration.name, scope, checker)) return;
  return { verifiedScopeField: scope.field };
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

function scopeEvidence() {
  ts ??= require('./compiler.cjs').syntax;
  return { fields, importedMember, plain, scalar, scopedData, scopeFixEvidence, trustedValue };
}

module.exports = {
  loadQueryPolicy,
  rejectDuplicateKeys,
  validateQueryPolicy,
  scopeEvidence,
  stableModuleName,
};
