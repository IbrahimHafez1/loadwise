'use strict';

// Helpers shared by the injection rules: trace wording and tiering, global and locally created values.
const { syntax: ts } = require('../../performance/compiler.cjs');

const secondHopReason = 'Reached through two calls; confirm the intermediate functions do not validate the value.';
// Bounds the alias chains followed when a value is created by a library call in another statement.
const maxAliasDepth = 4;

// ` (`req.query.sort`)` for a message, or '' without a trace.
function sourceSuffix(trace) {
  return trace ? ` (\`${trace.label}\`)` : '';
}

// Two call boundaries leave room for validation the engine did not see (security design section 2.5).
function hopReason(trace) {
  return trace?.hops === 2 ? secondHopReason : undefined;
}

function reportTraced(context, node, ruleId, message, trace, contextualReason) {
  context.report(node, ruleId, message, contextualReason ?? hopReason(trace), trace && { taint: trace });
}

// The called property name, or undefined.
function methodName(call) {
  const callee = ts.skipOuterExpressions(call.expression);
  return ts.isPropertyAccessExpression(callee) ? callee.name.text : undefined;
}

// `eval`, `RegExp`, `setTimeout`: an identifier that is not declared anywhere in the project.
function isGlobalName(identifier, names, checker) {
  if (!ts.isIdentifier(identifier) || !names.has(identifier.text)) return false;
  const declarations = checker.getSymbolAtLocation(identifier)?.declarations ?? [];
  return declarations.every((declaration) => declaration.getSourceFile().isDeclarationFile);
}

// The export a library call stands for: 'render' for `ejs.render(...)`, `render(...)` and `ejs.default.render(...)`.
function calledExport(found) {
  if (!found) return;
  return found.method && found.exported !== found.method ? found.method : found.exported;
}

function valueDeclaration(identifier, checker) {
  let symbol = ts.isShorthandPropertyAssignment(identifier.parent)
    ? checker.getShorthandAssignmentValueSymbol(identifier.parent)
    : checker.getSymbolAtLocation(identifier);
  if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
  return symbol?.valueDeclaration ?? symbol?.declarations?.[0];
}

// The expression a `const` (or an imported `const`, default export or `module.exports =`) was initialised with.
function initializerOf(identifier, checker) {
  const declaration = valueDeclaration(identifier, checker);
  if (!declaration) return;
  if (ts.isVariableDeclaration(declaration) && declaration.parent.flags & ts.NodeFlags.Const)
    return declaration.initializer && ts.skipOuterExpressions(declaration.initializer);
  if (ts.isExportAssignment(declaration)) return ts.skipOuterExpressions(declaration.expression);
  if (ts.isBinaryExpression(declaration)) return ts.skipOuterExpressions(declaration.right);
}

// The value of `module.exports = value` or `export = value` in a project source file.
function moduleExportValue(sourceFile, checker) {
  if (sourceFile.isDeclarationFile) return;
  const exported = checker.getSymbolAtLocation(sourceFile)?.exports?.get('export=');
  const assignment = exported?.valueDeclaration ?? exported?.declarations?.[0];
  if (assignment && ts.isBinaryExpression(assignment)) return ts.skipOuterExpressions(assignment.right);
  if (assignment && ts.isExportAssignment(assignment)) return ts.skipOuterExpressions(assignment.expression);
}

// `require('./db')` becomes the value that module exports, or undefined; anything else is returned unchanged.
function requiredModule(expression, checker) {
  if (
    ts.isCallExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    expression.expression.text === 'require' &&
    expression.arguments.length === 1 &&
    ts.isStringLiteralLike(expression.arguments[0])
  ) {
    const symbol = checker.getSymbolAtLocation(expression.arguments[0]);
    const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
    return declaration && ts.isSourceFile(declaration) ? moduleExportValue(declaration, checker) : undefined;
  }
  return expression;
}

function isNamespaceImport(expression, checker) {
  const object = ts.skipOuterExpressions(expression);
  if (!ts.isIdentifier(object)) return false;
  return Boolean(checker.getSymbolAtLocation(object)?.declarations?.some(ts.isNamespaceImport));
}

// True when `expression` is a value created by a call or `new` that `isFactory(callOrNew)` accepts, followed through
// `const` aliases, imports, `require` and `a || b` / `a ?? b`: `const pool = mysql.createPool(...)`, then `pool`.
function createdBy(expression, isFactory, checker, depth = 0) {
  if (!expression || depth > maxAliasDepth) return false;
  const stripped = ts.skipOuterExpressions(expression);
  const value = requiredModule(stripped, checker);
  if (value !== stripped) return createdBy(value, isFactory, checker, depth + 1);
  if (ts.isIdentifier(value)) return createdBy(initializerOf(value, checker), isFactory, checker, depth + 1);
  // `db.reviews` after `import * as db from './db'`: the export's own name resolves to its declaration.
  if (ts.isPropertyAccessExpression(value) && isNamespaceImport(value.expression, checker))
    return createdBy(initializerOf(value.name, checker), isFactory, checker, depth + 1);
  if (ts.isCallExpression(value) || ts.isNewExpression(value)) return isFactory(value);
  if (
    ts.isBinaryExpression(value) &&
    [ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(value.operatorToken.kind)
  )
    return (
      createdBy(value.left, isFactory, checker, depth + 1) || createdBy(value.right, isFactory, checker, depth + 1)
    );
  return false;
}

module.exports = {
  sourceSuffix,
  hopReason,
  reportTraced,
  methodName,
  isGlobalName,
  calledExport,
  initializerOf,
  createdBy,
};
