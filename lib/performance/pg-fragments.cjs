'use strict';

const { syntax: ts } = require('./compiler.cjs');
const { outsideWrappers } = require('./query-results.cjs');

// Bounds apply only to attempts to prove a fragment fixed. An inconclusive proof keeps the diagnostic.
const maxExpressionNodes = 160;
const maxFoldedCharacters = 4096;
const maxScopeNodes = 12000;
const scopeIdentifiers = new WeakMap();
const fixedWithoutText = Symbol('fixed fragment without exact string');

function identifiersIn(scope) {
  if (scopeIdentifiers.has(scope)) return scopeIdentifiers.get(scope);
  const byName = new Map();
  const pending = [scope];
  let visited = 0;
  while (pending.length && ++visited <= maxScopeNodes) {
    const node = pending.pop();
    if (ts.isIdentifier(node)) {
      if (!byName.has(node.text)) byName.set(node.text, []);
      byName.get(node.text).push(node);
    }
    ts.forEachChild(node, (child) => {
      pending.push(child);
    });
  }
  scopeIdentifiers.set(scope, pending.length ? undefined : byName);
  return scopeIdentifiers.get(scope);
}

function argumentsForPrivateParameter(parameter) {
  const fn = parameter.parent;
  // Only a block-local function has a closed set of callers without a module export analysis.
  if (
    !ts.isFunctionDeclaration(fn) ||
    !fn.name ||
    !ts.isBlock(fn.parent) ||
    !ts.findAncestor(fn.parent, ts.isFunctionLike) ||
    !ts.isIdentifier(parameter.name) ||
    parameter.dotDotDotToken ||
    !fn.body
  )
    return;
  const names = identifiersIn(fn.parent);
  if (!names || names.has('eval') || names.has('arguments')) return;
  // A later parameter's default can overwrite an earlier argument before the body starts.
  if (
    names
      .get(parameter.name.text)
      ?.some((use) => use.pos >= fn.pos && use.end <= fn.end && ts.isAssignmentTarget(outsideWrappers(use)))
  )
    return;
  const index = fn.parameters.indexOf(parameter);
  const values = [];
  for (const use of names.get(fn.name.text) || []) {
    if (use === fn.name) continue;
    const reference = outsideWrappers(use);
    const call = reference.parent;
    if (
      !ts.isCallExpression(call) ||
      call.expression !== reference ||
      !call.arguments[index] ||
      call.arguments.slice(0, index + 1).some(ts.isSpreadElement)
    )
      return;
    values.push(call.arguments[index]);
  }
  if (values.length) return values;
}

function fixedLiteral(node) {
  if (
    ts.isPrefixUnaryExpression(node) &&
    (node.operator === ts.SyntaxKind.MinusToken || node.operator === ts.SyntaxKind.PlusToken)
  ) {
    return ts.isNumericLiteral(node.operand) || node.operand.kind === ts.SyntaxKind.BigIntLiteral;
  }
  return (
    ts.isNumericLiteral(node) ||
    node.kind === ts.SyntaxKind.BigIntLiteral ||
    node.kind === ts.SyntaxKind.TrueKeyword ||
    node.kind === ts.SyntaxKind.FalseKeyword ||
    node.kind === ts.SyntaxKind.NullKeyword
  );
}

function valueDeclaration(identifier, checker) {
  const symbol = checker.getSymbolAtLocation(identifier);
  if (!symbol) return;
  return (symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol)?.valueDeclaration;
}

function constValue(binding) {
  if (
    binding &&
    ts.isVariableDeclaration(binding) &&
    binding.parent.flags & ts.NodeFlags.Const &&
    ts.isIdentifier(binding.name) &&
    binding.initializer &&
    !binding.getSourceFile().isDeclarationFile
  ) {
    return ts.skipOuterExpressions(binding.initializer);
  }
}

const scalarFlags = ts.TypeFlags.StringLike | ts.TypeFlags.NumberLike | ts.TypeFlags.BooleanLike;
const escapeChecks = new WeakMap();

// The object is only read through property accesses that yield scalars (or aliases that are themselves such), so no
// other code can pass it to a function that rewrites its properties or assign into it.
function isOnlyReadByProperty(declaration, checker, depth = 0) {
  if (escapeChecks.has(declaration)) return escapeChecks.get(declaration);
  escapeChecks.set(declaration, false);
  if (depth > 4) return false;
  let safe = true;
  (function scan(node) {
    if (!safe) return;
    if (ts.isIdentifier(node) && node !== declaration.name && node.text === declaration.name.text) {
      if (valueDeclaration(node, checker) === declaration) safe = isSafeReference(node, checker, depth);
    }
    ts.forEachChild(node, scan);
  })(declaration.getSourceFile());
  escapeChecks.set(declaration, safe);
  return safe;
}

function isSafeReference(identifier, checker, depth) {
  let access = identifier;
  while (
    (ts.isPropertyAccessExpression(access.parent) || ts.isElementAccessExpression(access.parent)) &&
    access.parent.expression === access
  )
    access = access.parent;
  if (access === identifier) return false;
  const use = access.parent;
  if (ts.isVariableDeclaration(use) && use.initializer === access && ts.isIdentifier(use.name))
    return isOnlyReadByProperty(use, checker, depth + 1);
  if (ts.isBinaryExpression(use) && use.left === access && use.operatorToken.kind >= ts.SyntaxKind.FirstAssignment)
    return false;
  if (ts.isDeleteExpression(use) || ts.isPrefixUnaryExpression(use) || ts.isPostfixUnaryExpression(use)) return false;
  // Storing a read in an object literal (a report field) hands out no mutable handle to a function.
  return ts.isPropertyAssignment(use) || !!(checker.getTypeAtLocation(access).flags & scalarFlags);
}

// Properties of a const object literal are code-owned: `const SIZES = { S: { users: 20 } }; SIZES.S.users`.
function constantObject(expression, checker, depth = 0) {
  if (depth > 6) return;
  const value = ts.skipOuterExpressions(expression);
  if (ts.isObjectLiteralExpression(value)) return value;
  if (ts.isIdentifier(value)) {
    const declaration = valueDeclaration(value, checker);
    const initializer = constValue(declaration);
    // References in other files cannot be checked for writes.
    if (!initializer || declaration.getSourceFile() !== value.getSourceFile()) return;
    return isOnlyReadByProperty(declaration, checker) ? constantObject(initializer, checker, depth + 1) : undefined;
  }
  if (ts.isPropertyAccessExpression(value) || ts.isElementAccessExpression(value)) {
    const property = constantProperty(value, checker, depth + 1);
    return property && constantObject(property, checker, depth + 1);
  }
}

function constantProperty(node, checker, depth = 0) {
  const object = constantObject(node.expression, checker, depth);
  if (!object) return;
  const name = ts.isPropertyAccessExpression(node)
    ? node.name.text
    : ts.isStringLiteralLike(node.argumentExpression) || ts.isNumericLiteral(node.argumentExpression)
      ? node.argumentExpression.text
      : undefined;
  if (name === undefined) return;
  let found;
  for (const property of object.properties) {
    // A spread or computed key can override the property with an unknown value.
    if (!property.name || ts.isComputedPropertyName(property.name)) return;
    if (property.name.text === name) found = ts.isPropertyAssignment(property) ? property.initializer : undefined;
  }
  return found;
}

const cryptoModules = new Set(['crypto', 'node:crypto']);

function importedFromCrypto(identifier, checker) {
  const declaration = checker.getSymbolAtLocation(identifier)?.declarations?.[0];
  return (
    !!declaration &&
    ts.isImportSpecifier(declaration) &&
    cryptoModules.has(declaration.parent.parent.parent.moduleSpecifier.text)
  );
}

// randomUUID() and randomBytes(n).toString('hex') produce only [0-9a-f-], so they cannot change the SQL grammar.
function isRandomIdentifierText(node, checker) {
  if (!ts.isCallExpression(node)) return false;
  const callee = ts.skipOuterExpressions(node.expression);
  if (ts.isIdentifier(callee)) return callee.text === 'randomUUID' && importedFromCrypto(callee, checker);
  if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== 'toString') return false;
  const [encoding] = node.arguments;
  const source = ts.skipOuterExpressions(callee.expression);
  return (
    encoding &&
    ts.isStringLiteralLike(encoding) &&
    encoding.text === 'hex' &&
    ts.isCallExpression(source) &&
    ts.isIdentifier(source.expression) &&
    source.expression.text === 'randomBytes' &&
    importedFromCrypto(source.expression, checker)
  );
}

function concatenate(left, right) {
  if (left === undefined || right === undefined) return;
  return typeof left === 'string' && typeof right === 'string' && left.length + right.length <= maxFoldedCharacters
    ? left + right
    : fixedWithoutText;
}

function alternatives(left, right) {
  if (left === undefined || right === undefined) return;
  return left === right ? left : fixedWithoutText;
}

// Return exact text when possible, a marker for other code-owned values, or undefined for an unknown source.
function analyzeFragment(expression, checker) {
  let remaining = maxExpressionNodes;
  function fixed(node, bound) {
    if (--remaining < 0) return;
    node = ts.skipOuterExpressions(node);
    if (ts.isStringLiteralLike(node)) return node.text.length <= maxFoldedCharacters ? node.text : fixedWithoutText;
    if (fixedLiteral(node)) return fixedWithoutText;
    if (ts.isTemplateExpression(node)) {
      let text = node.head.text;
      for (const span of node.templateSpans) {
        text = concatenate(concatenate(text, fixed(span.expression, bound)), span.literal.text);
        if (text === undefined) return;
      }
      return text;
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const left = fixed(node.left, bound);
      return left === undefined ? undefined : concatenate(left, fixed(node.right, bound));
    }
    if (ts.isConditionalExpression(node)) {
      // A formatter condition can overwrite its parameter before the selected arm uses it.
      if (bound.size && fixed(node.condition, bound) === undefined) return;
      return alternatives(fixed(node.whenTrue, bound), fixed(node.whenFalse, bound));
    }
    if (ts.isIdentifier(node)) {
      const binding = valueDeclaration(node, checker);
      if (binding && ts.isParameter(binding)) {
        if (bound.has(binding)) return bound.get(binding);
        const values = argumentsForPrivateParameter(binding);
        if (!values) return;
        let text = fixed(values[0], bound);
        for (let i = 1; i < values.length && text !== undefined; i++)
          text = alternatives(text, fixed(values[i], bound));
        return text;
      }
      const value = constValue(binding);
      return value && fixed(value, bound);
    }
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const property = constantProperty(node, checker);
      return property && fixed(property, bound);
    }
    if (isRandomIdentifierText(node, checker)) return fixedWithoutText;
    if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression)) return;
    const fn = constValue(valueDeclaration(node.expression, checker));
    if (
      !fn ||
      !ts.isArrowFunction(fn) ||
      ts.isBlock(fn.body) ||
      fn.modifiers?.some((item) => item.kind === ts.SyntaxKind.AsyncKeyword) ||
      fn.parameters.length !== node.arguments.length ||
      fn.parameters.some((param) => !ts.isIdentifier(param.name) || param.dotDotDotToken || param.initializer)
    )
      return;
    const argumentsByParameter = new Map(bound);
    for (let i = 0; i < node.arguments.length; i++) {
      const value = fixed(node.arguments[i], bound);
      if (value === undefined) return;
      argumentsByParameter.set(fn.parameters[i], value);
    }
    return fixed(fn.body, argumentsByParameter);
  }
  return fixed(expression, new Map());
}

module.exports = { analyzeFragment };
