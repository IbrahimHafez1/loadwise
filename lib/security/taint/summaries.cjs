'use strict';

// One call hop in each direction (design section 2.5), over project-local code only: return summaries of local
// helpers, and the call sites that pass arguments into a function's parameters.
const { calleeName } = require('../../performance/call-syntax.cjs');
const { syntax: ts } = require('../../performance/compiler.cjs');
const { stripExpression } = require('../bindings.cjs');

// Longer helpers are rarely pure transformations; summarising them costs time and invites invented flows.
const maxSummaryStatements = 40;
// Re-exports and aliases followed from `new Dao(db)` back to the constructor function's declaration.
const maxConstructorLinks = 6;

function isProjectSource(sourceFile) {
  return !sourceFile.isDeclarationFile && !/[/\\]node_modules[/\\]/.test(sourceFile.fileName);
}

// The project-local function a call resolves to, or undefined (external, unresolved, or an overload set).
function localCallee(call, checker) {
  const declaration = checker.getResolvedSignature(call)?.declaration ?? constructorMethod(call, checker);
  if (!declaration || !ts.isFunctionLike(declaration) || !declaration.body) return;
  return isProjectSource(declaration.getSourceFile()) ? declaration : undefined;
}

// TypeScript 7 no longer types JavaScript constructor functions, so `dao.find(id)` after `const dao = new Dao(db)`
// resolves to no signature there. The syntax still shows the method: `this.find = (id) => ...` in `Dao`'s body.
function constructorMethod(call, checker) {
  const callee = stripExpression(call.expression);
  if (!ts.isPropertyAccessExpression(callee)) return;
  const receiver = stripExpression(callee.expression);
  if (!ts.isIdentifier(receiver)) return;
  const variable = checker.getSymbolAtLocation(receiver)?.declarations?.[0];
  if (!variable || !ts.isVariableDeclaration(variable)) return;
  const created = stripExpression(variable.initializer);
  if (!created || !ts.isNewExpression(created)) return;
  const constructor = functionOf(created.expression, checker, maxConstructorLinks);
  return constructor && thisMethod(constructor, callee.name.text);
}

// The function an expression names, through `const Dao = function`, `module.exports.Dao = Dao`,
// `module.exports = { Dao }` and the require or import bindings that read them.
function functionOf(expression, checker, links) {
  const node = stripExpression(expression);
  if (!node || links <= 0) return;
  if (ts.isFunctionExpression(node)) return node;
  const name = ts.isPropertyAccessExpression(node) ? node.name : ts.isIdentifier(node) ? node : undefined;
  let symbol = name && checker.getSymbolAtLocation(name);
  if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
  const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
  if (!declaration) return;
  if (ts.isFunctionDeclaration(declaration)) return declaration;
  if (ts.isVariableDeclaration(declaration) || ts.isPropertyAssignment(declaration))
    return functionOf(declaration.initializer, checker, links - 1);
  if (ts.isShorthandPropertyAssignment(declaration)) {
    const value = checker.getShorthandAssignmentValueSymbol(declaration)?.declarations?.[0];
    if (value && ts.isFunctionDeclaration(value)) return value;
    return value && ts.isVariableDeclaration(value) ? functionOf(value.initializer, checker, links - 1) : undefined;
  }
  if (ts.isBinaryExpression(declaration)) return functionOf(declaration.right, checker, links - 1);
}

// `this.name = function` or an arrow in the constructor's own body; a nested function has its own `this`.
function thisMethod(constructor, name) {
  let method;
  (function visit(node) {
    if (method || (node !== constructor.body && ts.isFunctionLike(node) && !ts.isArrowFunction(node))) return;
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(node.left) &&
      node.left.expression.kind === ts.SyntaxKind.ThisKeyword &&
      node.left.name.text === name
    ) {
      const value = stripExpression(node.right);
      if (ts.isFunctionExpression(value) || ts.isArrowFunction(value)) method = value;
    }
    ts.forEachChild(node, visit);
  })(constructor.body);
  return method;
}

function returnedExpressions(fn) {
  if (!ts.isBlock(fn.body)) return [fn.body];
  if (fn.body.statements.length > maxSummaryStatements) return;
  const returned = [];
  (function visit(node) {
    if (node !== fn && ts.isFunctionLike(node)) return;
    if (ts.isReturnStatement(node) && node.expression) returned.push(node.expression);
    ts.forEachChild(node, visit);
  })(fn.body);
  return returned;
}

function createSummaries(program) {
  const checker = program.getTypeChecker();
  const summaries = new WeakMap();
  const callSitesByDeclaration = new WeakMap();
  let callsByName;

  // Parameter indexes whose value can flow to a return of `fn` for a sink kind. `flows(expression, parameterIndex)`
  // resolves an expression inside `fn` with only that parameter treated as tainted.
  function returnSummary(fn, sinkKind, flows) {
    let byKind = summaries.get(fn);
    if (!byKind) summaries.set(fn, (byKind = new Map()));
    if (byKind.has(sinkKind)) return byKind.get(sinkKind);
    // Recursion re-enters here; an empty summary ends it.
    byKind.set(sinkKind, []);
    const returned = returnedExpressions(fn) ?? [];
    const indexes = fn.parameters
      .map((parameter, index) => index)
      .filter((index) => returned.some((expression) => flows(expression, index)));
    byKind.set(sinkKind, indexes);
    return indexes;
  }

  // Every project call whose resolved declaration is `fn`, found through a syntax index by callee name.
  function callSites(fn) {
    const cached = callSitesByDeclaration.get(fn);
    if (cached) return cached;
    const name = fn.name && ts.isIdentifier(fn.name) ? fn.name.text : variableName(fn);
    if (!name) return [];
    if (!callsByName) {
      callsByName = new Map();
      for (const sourceFile of program.getSourceFiles?.() ?? program.getToolingSourceFiles?.() ?? []) {
        if (!isProjectSource(sourceFile)) continue;
        (function visit(node) {
          if (ts.isCallExpression(node)) {
            const calledName = calleeName(node);
            if (calledName) {
              const calls = callsByName.get(calledName);
              if (calls) calls.push(node);
              else callsByName.set(calledName, [node]);
            }
          }
          ts.forEachChild(node, visit);
        })(sourceFile);
      }
    }
    const calls = (callsByName.get(name) ?? []).filter(
      (call) => (checker.getResolvedSignature(call)?.declaration ?? constructorMethod(call, checker)) === fn,
    );
    callSitesByDeclaration.set(fn, calls);
    return calls;
  }

  return { returnSummary, callSites, localCallee: (call) => localCallee(call, checker) };
}

// What the project function a call resolves to validates in its arguments: [{ argument, kind, mode }]. The summary
// module reuses this folder's guards, so it is required on first use.
function argumentValidations(call, program) {
  const { functionSummaries } = require('../../shared/function-summaries.cjs');
  const validates = functionSummaries(program).summaryOfCall(call)?.validates ?? [];
  return validates
    .map((validation) => ({ ...validation, argument: call.arguments[validation.parameterIndex] }))
    .filter((validation) => validation.argument);
}

// `const helper = (value) => ...` is called by the variable's name; `this.find = (value) => ...` in an old-style
// constructor and `{ find: (value) => ... }` by the property's name.
function variableName(fn) {
  const declaration = fn.parent;
  if (ts.isVariableDeclaration(declaration) || ts.isPropertyAssignment(declaration))
    return ts.isIdentifier(declaration.name) ? declaration.name.text : undefined;
  if (
    ts.isBinaryExpression(declaration) &&
    declaration.right === fn &&
    declaration.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    ts.isPropertyAccessExpression(declaration.left)
  )
    return declaration.left.name.text;
}

module.exports = { createSummaries, isProjectSource, returnedExpressions, argumentValidations };
