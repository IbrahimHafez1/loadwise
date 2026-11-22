'use strict';

const { syntax: ts } = require('./compiler.cjs');

const RULE_ID = 'session-memory-store';
const EXPRESS_SESSION = 'express-session';
const FASTIFY_SESSION = '@fastify/session';
const MESSAGE =
  'This session middleware has no `store`, so sessions live in process memory: the default store leaks memory, loses every session on restart and cannot share sessions across instances. Pass a shared store such as connect-redis or connect-pg-simple.';

function requiredModule(initializer) {
  if (!initializer) return;
  const call = ts.skipOuterExpressions(initializer);
  if (!ts.isCallExpression(call) || !ts.isIdentifier(call.expression) || call.expression.text !== 'require') return;
  const [argument] = call.arguments;
  return argument && ts.isStringLiteralLike(argument) ? argument.text : undefined;
}

function moduleOfDeclaration(declaration) {
  if (ts.isImportClause(declaration)) return declaration.parent.moduleSpecifier.text;
  if (ts.isImportSpecifier(declaration)) return declaration.parent.parent.parent.moduleSpecifier.text;
  if (ts.isNamespaceImport(declaration)) return declaration.parent.parent.moduleSpecifier.text;
  if (ts.isVariableDeclaration(declaration)) return requiredModule(declaration.initializer);
  if (ts.isImportEqualsDeclaration(declaration) && ts.isExternalModuleReference(declaration.moduleReference)) {
    return declaration.moduleReference.expression.text;
  }
}

// The module a plain identifier was imported or required from, found syntactically so it works without type packages.
function importedModuleOf(identifier, context) {
  if (!ts.isIdentifier(identifier)) return;
  const declaration = context.checker.getSymbolAtLocation(identifier)?.declarations?.[0];
  return declaration && moduleOfDeclaration(declaration);
}

function resolveObjectLiteral(expression, context) {
  const value = ts.skipOuterExpressions(expression);
  if (ts.isObjectLiteralExpression(value)) return value;
  if (!ts.isIdentifier(value)) return;
  const declaration = context.checker.getSymbolAtLocation(value)?.declarations?.[0];
  if (!declaration || !ts.isVariableDeclaration(declaration) || !declaration.initializer) return;
  if (!(declaration.parent.flags & ts.NodeFlags.Const)) return;
  const initializer = ts.skipOuterExpressions(declaration.initializer);
  return ts.isObjectLiteralExpression(initializer) ? initializer : undefined;
}

// A spread may carry a `store`, so only an object with no spread and no `store` key is certain to use memory.
function lacksStore(options) {
  return options.properties.every(
    (property) => !ts.isSpreadAssignment(property) && property.name?.getText() !== 'store',
  );
}

function hasNoStore(optionsArgument, context) {
  const options = resolveObjectLiteral(optionsArgument, context);
  return options !== undefined && lacksStore(options);
}

function isExpressSession(node, context) {
  return importedModuleOf(ts.skipOuterExpressions(node.expression), context) === EXPRESS_SESSION;
}

function isFastifySessionRegistration(node, context) {
  const callee = node.expression;
  if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== 'register') return false;
  const [plugin] = node.arguments;
  return plugin !== undefined && importedModuleOf(ts.skipOuterExpressions(plugin), context) === FASTIFY_SESSION;
}

function check(node, context) {
  const express = isExpressSession(node, context);
  if (!express && !isFastifySessionRegistration(node, context)) return;
  // express-session takes its options first; a fastify plugin takes them second.
  const optionsArgument = express ? node.arguments[0] : node.arguments[1];
  // `session()` with no options is rejected by express-session at runtime; fastify needs a secret, so skip both.
  if (!optionsArgument) return;
  if (!hasNoStore(optionsArgument, context)) return;
  context.report(express ? node.expression : node.arguments[0], RULE_ID, MESSAGE);
}

module.exports = { check };
