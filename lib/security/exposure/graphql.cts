// graphql-introspection-enabled: introspection or a playground that is switched on with a literal
// `true`.
import { loadSyntax } from '../../performance/compiler.cjs';
import { importedFrom } from '../bindings.cjs';
import { unwrap, nameText, isTrue, methodName, objectLiteralOf, isFullyLiteral } from './literals.cjs';
import type {
  CallExpression,
  Expression,
  NewExpression,
  Node,
  ObjectLiteralExpression,
  PropertyAssignment,
  SourceFile,
} from 'typescript';
import type { ProgramAdapter, SecurityRuleContext } from '../../shared/types.cjs';
const ts = loadSyntax();

const ruleId = 'graphql-introspection-enabled';
const message =
  'GraphQL introspection or the playground is enabled unconditionally, exposing the full schema in production. Enable it only outside production.';
const toolingOptions = new Set(['introspection', 'playground', 'graphiql']);
const nonProductionReason = 'Only enabled outside production.';
const factoryNames = new Set(['createYoga', 'graphqlHTTP']);
const serverClassNames = new Set(['ApolloServer']);

function isGraphQlModuleCall(call: CallExpression) {
  const callee = unwrap(call.expression);
  return (
    ts.isPropertyAccessExpression(callee) &&
    ts.isIdentifier(callee.expression) &&
    callee.expression.text === 'GraphQLModule' &&
    ['forRoot', 'forRootAsync'].includes(callee.name.text)
  );
}

function calleeText(call: CallExpression) {
  const callee = unwrap(call.expression);
  if (ts.isIdentifier(callee)) return callee.text;
  return ts.isPropertyAccessExpression(callee) ? callee.name.text : undefined;
}

function isMercuriusRegistration(call: CallExpression, context: SecurityRuleContext) {
  const plugin = unwrap(call.arguments[0]);
  return (
    methodName(call) === 'register' &&
    plugin &&
    ts.isIdentifier(plugin) &&
    (plugin.text === 'mercurius' || importedFrom(plugin, context.checker)?.module === 'mercurius')
  );
}

// True when `literal` is the options object of a GraphQL server: a direct argument, or what a
// `useFactory` returns.
function isServerOptions(literal: ObjectLiteralExpression, context: SecurityRuleContext) {
  const parent = literal.parent;
  if (ts.isNewExpression(parent))
    return parent.arguments?.[0] === literal && serverClassNames.has(parent.expression.getText());
  if (ts.isCallExpression(parent)) {
    if (!parent.arguments.includes(literal)) return false;
    const factoryName = calleeText(parent);
    return (
      isGraphQlModuleCall(parent) ||
      (factoryName !== undefined && factoryNames.has(factoryName)) ||
      isMercuriusRegistration(parent, context)
    );
  }
  const factory = ts.findAncestor(literal, ts.isFunctionLike);
  if (!factory) return false;
  const registration = factory.parent;
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

function isReturnedFrom(literal: Node, factory: Node) {
  let node: Node = literal;
  while (node.parent !== factory) {
    if (!ts.isParenthesizedExpression(node.parent) && !ts.isReturnStatement(node.parent) && !ts.isBlock(node.parent))
      return false;
    node = node.parent;
  }
  return true;
}

function checkProperty(property: PropertyAssignment, context: SecurityRuleContext) {
  if (!ts.isIdentifier(property.name) || !toolingOptions.has(property.name.text)) return;
  if (!isTrue(unwrap(property.initializer)) || !ts.isObjectLiteralExpression(property.parent)) return;
  if (!isServerOptions(property.parent, context)) return;
  const reason = context.fileContext.underNonProductionGuard(property) ? nonProductionReason : undefined;
  context.report(property, ruleId, message, reason);
}

// A depth or cost limit named anywhere in the options: validationRules, a Yoga plugin,
// graphql-armor or mercurius.
const limitOptionPattern = /depth|complexity|cost|armor/i;
const limitLibraryPattern = /graphql-depth-limit|graphql-armor|graphql-query-complexity/;
const depthLimitRuleId = 'graphql-query-depth-unbounded';
const depthLimitMessage =
  'This GraphQL server sets no query depth or cost limit, so one deeply nested query can exhaust it. Cap query depth and cost (for example with graphql-depth-limit, graphql-armor or a complexity rule).';
const unseenOptionsReason =
  'The server options are not a visible object literal; confirm a depth or cost limit is set.';
const projectLimitReason = 'The project imports a depth or cost limit library; confirm it is applied to this server.';
const factoryOptionsReason = 'The options come from a factory; confirm it sets a depth or cost limit.';
const limitLibraryByProgram = new WeakMap<ProgramAdapter, boolean>();

function isLimitLibraryFile(file: SourceFile) {
  return (
    !file.isDeclarationFile && !/[\\/]node_modules[\\/]/.test(file.fileName) && limitLibraryPattern.test(file.text)
  );
}

function programUsesLimitLibrary(program: ProgramAdapter) {
  if (!limitLibraryByProgram.has(program))
    limitLibraryByProgram.set(
      program,
      (program.getSourceFiles?.() ?? program.getToolingSourceFiles?.() ?? []).some(isLimitLibraryFile),
    );
  return limitLibraryByProgram.get(program);
}

function unboundedDepthReason(options: Expression, context: SecurityRuleContext, isAsync: boolean) {
  const literal = objectLiteralOf(options, context.checker);
  if (!literal) return unseenOptionsReason;
  if (limitOptionPattern.test(literal.getText())) return null;
  if (!isFullyLiteral(literal)) return unseenOptionsReason;
  if (isAsync) return factoryOptionsReason;
  return programUsesLimitLibrary(context.program) ? projectLimitReason : undefined;
}

function checkDepthLimit(node: Node, options: Expression | undefined, context: SecurityRuleContext, isAsync = false) {
  if (!options) return;
  const reason = unboundedDepthReason(options, context, isAsync);
  if (reason !== null) context.report(node, depthLimitRuleId, depthLimitMessage, reason);
}

// `new ApolloServer({ ... })`
function checkServer(node: NewExpression, context: SecurityRuleContext) {
  if (unwrap(node.expression).getText() !== 'ApolloServer') return;
  checkDepthLimit(node, node.arguments?.[0], context);
}

// createYoga, graphqlHTTP, `app.register(mercurius, { ... })` and `GraphQLModule.forRoot[Async]({
// ... })`.
function checkCall(call: CallExpression, context: SecurityRuleContext) {
  if (isGraphQlModuleCall(call))
    return checkDepthLimit(call, call.arguments[0], context, methodName(call) === 'forRootAsync');
  const factoryName = calleeText(call);
  if (factoryName !== undefined && factoryNames.has(factoryName))
    return checkDepthLimit(call, call.arguments[0], context);
  if (isMercuriusRegistration(call, context)) checkDepthLimit(call, call.arguments[1], context);
}

export { checkProperty, checkServer, checkCall };
