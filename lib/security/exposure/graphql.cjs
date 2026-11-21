'use strict';

// graphql-introspection-enabled: introspection or a playground that is switched on with a literal `true`.
const { syntax: ts } = require('../../performance/compiler.cjs');
const { importedFrom } = require('../bindings.cjs');
const { unwrap, nameText, isTrue, methodName } = require('./literals.cjs');

const ruleId = 'graphql-introspection-enabled';
const message =
  'GraphQL introspection or the playground is enabled unconditionally, exposing the full schema in production. Enable it only outside production.';
const toolingOptions = new Set(['introspection', 'playground', 'graphiql']);
const nonProductionReason = 'Only enabled outside production.';
const factoryNames = new Set(['createYoga', 'graphqlHTTP']);
const serverClassNames = new Set(['ApolloServer']);

function isGraphQlModuleCall(call) {
  const callee = unwrap(call.expression);
  return (
    ts.isPropertyAccessExpression(callee) &&
    ts.isIdentifier(callee.expression) &&
    callee.expression.text === 'GraphQLModule' &&
    ['forRoot', 'forRootAsync'].includes(callee.name.text)
  );
}

function calleeText(call) {
  const callee = unwrap(call.expression);
  if (ts.isIdentifier(callee)) return callee.text;
  return ts.isPropertyAccessExpression(callee) ? callee.name.text : undefined;
}

function isMercuriusRegistration(call, context) {
  const plugin = unwrap(call.arguments[0]);
  return (
    methodName(call) === 'register' &&
    plugin &&
    ts.isIdentifier(plugin) &&
    (plugin.text === 'mercurius' || importedFrom(plugin, context.checker)?.module === 'mercurius')
  );
}

// True when `literal` is the options object of a GraphQL server: a direct argument, or what a `useFactory` returns.
function isServerOptions(literal, context) {
  const parent = literal.parent;
  if (ts.isNewExpression(parent))
    return parent.arguments?.[0] === literal && serverClassNames.has(parent.expression.getText());
  if (ts.isCallExpression(parent)) {
    if (!parent.arguments.includes(literal)) return false;
    return (
      isGraphQlModuleCall(parent) || factoryNames.has(calleeText(parent)) || isMercuriusRegistration(parent, context)
    );
  }
  const factory = ts.findAncestor(literal, ts.isFunctionLike);
  const registration = factory?.parent;
  return Boolean(
    registration &&
    ts.isPropertyAssignment(registration) &&
    nameText(registration.name) === 'useFactory' &&
    isReturnedFrom(literal, factory) &&
    ts.isObjectLiteralExpression(registration.parent) &&
    ts.isCallExpression(registration.parent.parent) &&
    isGraphQlModuleCall(registration.parent.parent),
  );
}

function isReturnedFrom(literal, factory) {
  let node = literal;
  while (node.parent !== factory) {
    if (!ts.isParenthesizedExpression(node.parent) && !ts.isReturnStatement(node.parent) && !ts.isBlock(node.parent))
      return false;
    node = node.parent;
  }
  return true;
}

function checkProperty(property, context) {
  if (!ts.isIdentifier(property.name) || !toolingOptions.has(property.name.text)) return;
  if (!isTrue(unwrap(property.initializer)) || !ts.isObjectLiteralExpression(property.parent)) return;
  if (!isServerOptions(property.parent, context)) return;
  const reason = context.fileContext.underNonProductionGuard(property) ? nonProductionReason : undefined;
  context.report(property, ruleId, message, reason);
}

module.exports = { checkProperty };
