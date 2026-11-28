// Helpers shared by the injection rules: trace wording and tiering, global and locally created
// values.
import { ts } from '../../performance/compiler.js';
import { fieldWritesTo } from '../taint/guards.js';
import type { FieldWrite } from '../taint/guards.js';
import type {
  CallExpression,
  Expression,
  Identifier,
  MemberName,
  NewExpression,
  Node,
  SourceFile,
  SyntaxKind,
} from 'typescript';
import type { CheckerAdapter, LibraryCall, SecurityRuleContext, SymbolAdapter, Trace } from '../../shared/types.js';

const secondHopReason = 'Reached through two calls; confirm the intermediate functions do not validate the value.';
// Bounds the alias chains followed when a value is created by a library call in another statement.
const maxAliasDepth = 4;
const fallbackOperators = (): readonly SyntaxKind[] => [ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken];

/**
 * A symbol that lists what a module exports; TypeScript symbols do, the adapter's shared surface
 * does not say so.
 */
interface ExportingSymbol extends SymbolAdapter {
  exports?: { get(name: string): SymbolAdapter | undefined };
}

function hasExports(symbol: SymbolAdapter): symbol is ExportingSymbol {
  return 'exports' in symbol;
}

/** A call or `new` expression that creates a value, such as `mysql.createPool(...)`. */
type FactoryTest = (creation: CallExpression | NewExpression) => boolean;

// ` (`req.query.sort`)` for a message, or '' without a trace.
function sourceSuffix(trace: Trace | undefined) {
  return trace ? ` (\`${trace.label}\`)` : '';
}

// Two call boundaries leave room for validation the engine did not see (security design section
// 2.5).
function hopReason(trace: Trace | undefined) {
  return trace && trace.hops >= 2 ? secondHopReason : undefined;
}

// loadwise-reviewed long-parameter-list -- mirrors the positional shape of context.report (node, ruleId, message, reason) plus the trace; every injection rule calls it positionally and the optional reason is the only trailing argument
function reportTraced(
  context: SecurityRuleContext,
  node: Node,
  ruleId: string,
  message: string,
  trace: Trace | undefined,
  contextualReason?: string,
) {
  context.report(node, ruleId, message, contextualReason ?? hopReason(trace), trace && { taint: trace });
}

// The called property name, or undefined.
function methodName(call: CallExpression) {
  const callee = ts.skipOuterExpressions(call.expression);
  return ts.isPropertyAccessExpression(callee) ? callee.name.text : undefined;
}

// `eval`, `RegExp`, `setTimeout`: an identifier that is not declared anywhere in the project.
function isGlobalName(identifier: Node, names: ReadonlySet<string>, checker: CheckerAdapter): identifier is Identifier {
  if (!ts.isIdentifier(identifier) || !names.has(identifier.text)) return false;
  const declarations = checker.getSymbolAtLocation(identifier)?.declarations ?? [];
  return declarations.every((declaration) => declaration.getSourceFile().isDeclarationFile);
}

// The export a library call stands for: 'render' for `ejs.render(...)`, `render(...)` and
// `ejs.default.render(...)`.
function calledExport(found: LibraryCall | undefined): string | undefined {
  if (!found) return;
  return found.method && found.exported !== found.method ? found.method : found.exported;
}

function valueDeclaration(identifier: MemberName, checker: CheckerAdapter): Node | undefined {
  let symbol = ts.isShorthandPropertyAssignment(identifier.parent)
    ? checker.getShorthandAssignmentValueSymbol(identifier.parent)
    : checker.getSymbolAtLocation(identifier);
  if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
  return symbol?.valueDeclaration ?? symbol?.declarations?.[0];
}

// The expression a `const` (or an imported `const`, default export or `module.exports =`) was
// initialised with.
function initializerOf(identifier: MemberName, checker: CheckerAdapter): Expression | undefined {
  const declaration = valueDeclaration(identifier, checker);
  if (!declaration) return;
  if (ts.isVariableDeclaration(declaration) && declaration.parent.flags & ts.NodeFlags.Const)
    return declaration.initializer && ts.skipOuterExpressions(declaration.initializer);
  if (ts.isExportAssignment(declaration)) return ts.skipOuterExpressions(declaration.expression);
  if (ts.isBinaryExpression(declaration)) return ts.skipOuterExpressions(declaration.right);
}

// The field writes (`options.shell = true`) to the local object `identifier` names, which change
// what its literal initializer says.
function fieldWritesOf(identifier: Identifier, checker: CheckerAdapter): FieldWrite[] {
  const declaration = valueDeclaration(identifier, checker);
  if (!declaration || !ts.isVariableDeclaration(declaration)) return [];
  const scope = ts.findAncestor(declaration, (node: Node) => ts.isFunctionLike(node) || ts.isSourceFile(node));
  return scope ? fieldWritesTo(declaration, scope, checker) : [];
}

// The arguments in the positions the callee receives them: `f(...['a', b])` passes `'a'`, then `b`.
// A spread of anything else stays a spread, since the positions it fills are unknown.
function positionalArguments(args: readonly Expression[]): Expression[] {
  return args.flatMap((argument) => {
    const spread = ts.isSpreadElement(argument) ? ts.skipOuterExpressions(argument.expression) : undefined;
    return spread && ts.isArrayLiteralExpression(spread) ? positionalArguments(spread.elements) : [argument];
  });
}

// The value of `module.exports = value` or `export = value` in a project source file.
function moduleExportValue(sourceFile: SourceFile, checker: CheckerAdapter): Expression | undefined {
  if (sourceFile.isDeclarationFile) return;
  const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
  const exported = moduleSymbol && hasExports(moduleSymbol) ? moduleSymbol.exports?.get('export=') : undefined;
  const assignment = exported?.valueDeclaration ?? exported?.declarations?.[0];
  if (assignment && ts.isBinaryExpression(assignment)) return ts.skipOuterExpressions(assignment.right);
  if (assignment && ts.isExportAssignment(assignment)) return ts.skipOuterExpressions(assignment.expression);
}

// `require('./db')` becomes the value that module exports, or undefined; anything else is returned
// unchanged.
function requiredModule(expression: Expression, checker: CheckerAdapter): Expression | undefined {
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

function isNamespaceImport(expression: Expression, checker: CheckerAdapter): boolean {
  const object = ts.skipOuterExpressions(expression);
  if (!ts.isIdentifier(object)) return false;
  return Boolean(checker.getSymbolAtLocation(object)?.declarations?.some(ts.isNamespaceImport));
}

// True when `expression` is a value created by a call or `new` that `isFactory(callOrNew)` accepts,
// followed through
// `const` aliases, imports, `require` and `a || b` / `a ?? b`: `const pool =
// mysql.createPool(...)`, then `pool`.
function createdBy(
  expression: Expression | undefined,
  isFactory: FactoryTest,
  checker: CheckerAdapter,
  depth = 0,
): boolean {
  if (!expression || depth > maxAliasDepth) return false;
  const stripped = ts.skipOuterExpressions(expression);
  const value = requiredModule(stripped, checker);
  if (value !== stripped) return createdBy(value, isFactory, checker, depth + 1);
  if (ts.isIdentifier(value)) return createdBy(initializerOf(value, checker), isFactory, checker, depth + 1);
  // `db.reviews` after `import * as db from './db'`: the export's own name resolves to its
  // declaration.
  if (ts.isPropertyAccessExpression(value) && isNamespaceImport(value.expression, checker))
    return createdBy(initializerOf(value.name, checker), isFactory, checker, depth + 1);
  if (ts.isCallExpression(value) || ts.isNewExpression(value)) return isFactory(value);
  if (ts.isBinaryExpression(value) && fallbackOperators().includes(value.operatorToken.kind))
    return (
      createdBy(value.left, isFactory, checker, depth + 1) || createdBy(value.right, isFactory, checker, depth + 1)
    );
  return false;
}

export {
  sourceSuffix,
  hopReason,
  reportTraced,
  methodName,
  isGlobalName,
  calledExport,
  initializerOf,
  fieldWritesOf,
  positionalArguments,
  createdBy,
};
