'use strict';

// One call hop in each direction (design section 2.5), over project-local code only: return summaries of local
// helpers, and the call sites that pass arguments into a function's parameters.
const { calleeName } = require('../../performance/call-syntax.cjs');
const { syntax: ts } = require('../../performance/compiler.cjs');

// Longer helpers are rarely pure transformations; summarising them costs time and invites invented flows.
const maxSummaryStatements = 40;

function isProjectSource(sourceFile) {
  return !sourceFile.isDeclarationFile && !/[/\\]node_modules[/\\]/.test(sourceFile.fileName);
}

// The project-local function a call resolves to, or undefined (external, unresolved, or an overload set).
function localCallee(call, checker) {
  const declaration = checker.getResolvedSignature(call)?.declaration;
  if (!declaration || !ts.isFunctionLike(declaration) || !declaration.body) return;
  return isProjectSource(declaration.getSourceFile()) ? declaration : undefined;
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
      for (const sourceFile of program.getSourceFiles()) {
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
      (call) => checker.getResolvedSignature(call)?.declaration === fn,
    );
    callSitesByDeclaration.set(fn, calls);
    return calls;
  }

  return { returnSummary, callSites, localCallee: (call) => localCallee(call, checker) };
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

module.exports = { createSummaries, isProjectSource, returnedExpressions };
