// One call hop in each direction (design section 2.5), over project-local code only: return
// summaries of local helpers, and the call sites that pass arguments into a function's parameters.
import { calleeName } from '../../performance/call-syntax.js';
import { ts } from '../../performance/compiler.js';
import { stripExpression } from '../bindings.js';
import { functionSummaries } from '../../shared/function-summaries.js';
import type {
  ArrowFunction,
  CallExpression,
  Expression,
  FunctionDeclaration,
  FunctionExpression,
  Node,
  SignatureDeclaration,
  SourceFile,
} from 'typescript';
import type {
  ArgumentValidation,
  CheckerAdapter,
  ProgramAdapter,
  SinkKind,
  TaintSummaries,
} from '../../shared/types.js';

interface ValidatedArgument extends ArgumentValidation {
  argument: Expression;
}

// Longer helpers are rarely pure transformations; summarising them costs time and invites invented
// flows.
const maxSummaryStatements = 40;
// Re-exports and aliases followed from `new Dao(db)` back to the constructor function's
// declaration.
const maxConstructorLinks = 6;

function isProjectSource(sourceFile: SourceFile) {
  return !sourceFile.isDeclarationFile && !/[/\\]node_modules[/\\]/.test(sourceFile.fileName);
}

// The project-local function a call resolves to, or undefined (external, unresolved, or an overload
// set).
function localCallee(call: CallExpression, checker: CheckerAdapter): SignatureDeclaration | undefined {
  const declaration = checker.getResolvedSignature(call)?.declaration ?? constructorMethod(call, checker);
  if (!declaration || !ts.isFunctionLike(declaration) || !('body' in declaration && declaration.body)) return;
  return isProjectSource(declaration.getSourceFile()) ? declaration : undefined;
}

// TypeScript 7 no longer types JavaScript constructor functions, so `dao.find(id)` after `const dao
// = new Dao(db)` resolves to no signature there. The syntax still shows the method: `this.find =
// (id) => ...` in `Dao`'s body.
function constructorMethod(
  call: CallExpression,
  checker: CheckerAdapter,
): FunctionExpression | ArrowFunction | undefined {
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
function functionOf(
  expression: Expression | undefined,
  checker: CheckerAdapter,
  links: number,
): FunctionExpression | FunctionDeclaration | undefined {
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

// `this.name = function` or an arrow in the constructor's own body; a nested function has its own
// `this`.
function thisMethod(
  constructor: FunctionExpression | FunctionDeclaration,
  name: string,
): FunctionExpression | ArrowFunction | undefined {
  if (!constructor.body) return;
  let method: FunctionExpression | ArrowFunction | undefined;
  (function visit(node: Node): void {
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

function returnedExpressions(fn: SignatureDeclaration): Expression[] | undefined {
  const body = 'body' in fn ? fn.body : undefined;
  if (!body) return;
  if (!ts.isBlock(body)) return [body];
  if (body.statements.length > maxSummaryStatements) return;
  const returned: Expression[] = [];
  (function visit(node: Node): void {
    if (node !== fn && ts.isFunctionLike(node)) return;
    if (ts.isReturnStatement(node) && node.expression) returned.push(node.expression);
    ts.forEachChild(node, visit);
  })(body);
  return returned;
}

function createSummaries(program: ProgramAdapter): TaintSummaries {
  const checker = program.getTypeChecker();
  const summaries = new WeakMap<SignatureDeclaration, Map<SinkKind, number[]>>();
  const callSitesByDeclaration = new WeakMap<SignatureDeclaration, CallExpression[]>();
  const resolvedByName = new Map<string, Map<Node, CallExpression[]>>();
  let callsByName: Map<string, CallExpression[]> | undefined;

  // Parameter indexes whose value can flow to a return of `fn` for a sink kind. `flows(expression,
  // parameterIndex)` resolves an expression inside `fn` with only that parameter treated as
  // tainted.
  function returnSummary(
    fn: SignatureDeclaration,
    sinkKind: SinkKind,
    flows: (expression: Expression, parameterIndex: number) => boolean,
  ): number[] {
    let byKind = summaries.get(fn);
    if (!byKind) summaries.set(fn, (byKind = new Map()));
    const known = byKind.get(sinkKind);
    if (known) return known;
    // Recursion re-enters here; an empty summary ends it.
    byKind.set(sinkKind, []);
    const returned = returnedExpressions(fn) ?? [];
    const indexes = fn.parameters
      .map((_parameter, index) => index)
      .filter((index) => returned.some((expression) => flows(expression, index)));
    byKind.set(sinkKind, indexes);
    return indexes;
  }

  // Every project call whose resolved declaration is `fn`, found through a syntax index by callee
  // name.
  function callSites(fn: SignatureDeclaration): CallExpression[] {
    const cached = callSitesByDeclaration.get(fn);
    if (cached) return cached;
    const name = fn.name && ts.isIdentifier(fn.name) ? fn.name.text : variableName(fn);
    if (!name) return [];
    if (!callsByName) {
      callsByName = new Map<string, CallExpression[]>();
      const indexed = callsByName;
      for (const sourceFile of program.getSourceFiles?.() ?? program.getToolingSourceFiles?.() ?? []) {
        if (!isProjectSource(sourceFile)) continue;
        (function visit(node: Node): void {
          if (ts.isCallExpression(node)) {
            const calledName = calleeName(node);
            if (calledName) {
              const calls = indexed.get(calledName);
              if (calls) calls.push(node);
              else indexed.set(calledName, [node]);
            }
          }
          ts.forEachChild(node, visit);
        })(sourceFile);
      }
    }
    let byDeclaration = resolvedByName.get(name);
    if (!byDeclaration) {
      byDeclaration = new Map<Node, CallExpression[]>();
      for (const call of callsByName.get(name) ?? []) {
        const target = checker.getResolvedSignature(call)?.declaration ?? constructorMethod(call, checker);
        if (!target) continue;
        const list = byDeclaration.get(target);
        if (list) list.push(call);
        else byDeclaration.set(target, [call]);
      }
      resolvedByName.set(name, byDeclaration);
    }
    const calls = byDeclaration.get(fn) ?? [];
    callSitesByDeclaration.set(fn, calls);
    return calls;
  }

  return { returnSummary, callSites, localCallee: (call: CallExpression) => localCallee(call, checker) };
}

// What the project function a call resolves to validates in its arguments: [{ argument, kind, mode
// }]. The summary module reuses this folder's guards, so it is required on first use.
function argumentValidations(call: CallExpression, program: ProgramAdapter): ValidatedArgument[] {
  const validates = functionSummaries(program).summaryOfCall(call)?.validates ?? [];
  return validates
    .map((validation: ArgumentValidation) => ({ ...validation, argument: call.arguments[validation.parameterIndex] }))
    .filter((validation: ValidatedArgument) => validation.argument);
}

// `const helper = (value) => ...` is called by the variable's name; `this.find = (value) => ...` in
// an old-style constructor and `{ find: (value) => ... }` by the property's name.
function variableName(fn: SignatureDeclaration): string | undefined {
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

export { createSummaries, isProjectSource, returnedExpressions, argumentValidations };
