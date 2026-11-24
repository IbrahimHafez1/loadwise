import { loadSyntax } from './compiler.cjs';
import type { CallExpression, Expression, Node, ObjectLiteralExpression } from 'typescript';
import type { PerformanceRuleContext } from '../shared/types.cjs';
const ts = loadSyntax();

const RULE_ID = 'session-memory-store';
const EXPRESS_SESSION = 'express-session';
const FASTIFY_SESSION = '@fastify/session';
const MESSAGE =
  'This session middleware has no `store`, so sessions live in process memory: the default store leaks memory, loses every session on restart and cannot share sessions across instances. Pass a shared store such as connect-redis or connect-pg-simple.';

function stringLiteralText(specifier: Expression): string | undefined {
  return ts.isStringLiteral(specifier) ? specifier.text : undefined;
}

function requiredModule(initializer: Expression | undefined): string | undefined {
  if (!initializer) return;
  const call = ts.skipOuterExpressions(initializer);
  if (!ts.isCallExpression(call) || !ts.isIdentifier(call.expression) || call.expression.text !== 'require') return;
  const [argument] = call.arguments;
  return argument && ts.isStringLiteralLike(argument) ? argument.text : undefined;
}

function moduleOfDeclaration(declaration: Node): string | undefined {
  if (ts.isImportClause(declaration)) return stringLiteralText(declaration.parent.moduleSpecifier);
  if (ts.isImportSpecifier(declaration)) return stringLiteralText(declaration.parent.parent.parent.moduleSpecifier);
  if (ts.isNamespaceImport(declaration)) return stringLiteralText(declaration.parent.parent.moduleSpecifier);
  if (ts.isVariableDeclaration(declaration)) return requiredModule(declaration.initializer);
  if (ts.isImportEqualsDeclaration(declaration) && ts.isExternalModuleReference(declaration.moduleReference)) {
    return stringLiteralText(declaration.moduleReference.expression);
  }
}

// The module a plain identifier was imported or required from, found syntactically so it works
// without type packages.
function importedModuleOf(identifier: Expression, context: PerformanceRuleContext): string | undefined {
  if (!ts.isIdentifier(identifier)) return;
  const declaration = context.checker.getSymbolAtLocation(identifier)?.declarations?.[0];
  return declaration && moduleOfDeclaration(declaration);
}

function resolveObjectLiteral(
  expression: Expression,
  context: PerformanceRuleContext,
): ObjectLiteralExpression | undefined {
  const value = ts.skipOuterExpressions(expression);
  if (ts.isObjectLiteralExpression(value)) return value;
  if (!ts.isIdentifier(value)) return;
  const declaration = context.checker.getSymbolAtLocation(value)?.declarations?.[0];
  if (!declaration || !ts.isVariableDeclaration(declaration) || !declaration.initializer) return;
  if (!(declaration.parent.flags & ts.NodeFlags.Const)) return;
  const initializer = ts.skipOuterExpressions(declaration.initializer);
  return ts.isObjectLiteralExpression(initializer) ? initializer : undefined;
}

// A spread may carry a `store`, so only an object with no spread and no `store` key is certain to
// use memory.
function lacksStore(options: ObjectLiteralExpression): boolean {
  return options.properties.every(
    (property) => !ts.isSpreadAssignment(property) && property.name?.getText() !== 'store',
  );
}

function hasNoStore(optionsArgument: Expression, context: PerformanceRuleContext): boolean {
  const options = resolveObjectLiteral(optionsArgument, context);
  return options !== undefined && lacksStore(options);
}

function isExpressSession(node: CallExpression, context: PerformanceRuleContext): boolean {
  return importedModuleOf(ts.skipOuterExpressions(node.expression), context) === EXPRESS_SESSION;
}

function isFastifySessionRegistration(node: CallExpression, context: PerformanceRuleContext): boolean {
  const callee = node.expression;
  if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== 'register') return false;
  const [plugin] = node.arguments;
  return plugin !== undefined && importedModuleOf(ts.skipOuterExpressions(plugin), context) === FASTIFY_SESSION;
}

function check(node: CallExpression, context: PerformanceRuleContext): void {
  const express = isExpressSession(node, context);
  if (!express && !isFastifySessionRegistration(node, context)) return;
  // express-session takes its options first; a fastify plugin takes them second.
  const optionsArgument = express ? node.arguments[0] : node.arguments[1];
  // `session()` with no options is rejected by express-session at runtime; fastify needs a secret,
  // so skip both.
  if (!optionsArgument) return;
  if (!hasNoStore(optionsArgument, context)) return;
  context.report(express ? node.expression : node.arguments[0], RULE_ID, MESSAGE);
}

export { check };
