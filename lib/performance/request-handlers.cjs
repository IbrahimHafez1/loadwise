'use strict';

// Shared by the rules that only matter when the work happens for a request: which function is a request handler,
// and whether a value ends up in its response.
const { syntax: ts } = require('./compiler.cjs');

const ROUTE_DECORATORS = new Set([
  'Get',
  'Post',
  'Put',
  'Patch',
  'Delete',
  'All',
  'Head',
  'Options',
  'Query',
  'Mutation',
  'ResolveField',
]);
const HTTP_VERB_EXPORTS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
const REQUEST_PARAMETER = /^req(?:uest)?$/;
const RESPONSE_PARAMETER = /^(?:res|response|reply|h)$/;
const RESPONSE_RECEIVER = /^(?:res|response|reply|ctx|c|NextResponse|Response)$/;
const RESPONSE_METHODS = new Set(['json', 'send', 'jsonp', 'text', 'html']);
// `app/**/route.ts` (App Router) and `pages/api/**` (Pages Router) are handler files by location alone.
const NEXT_ROUTE_FILE = /(?:^|[/\\])app[/\\](?:.*[/\\])?route\.[cm]?[jt]sx?$/;
const NEXT_PAGES_API_FILE = /(?:^|[/\\])pages[/\\]api[/\\].+\.[cm]?[jt]sx?$/;
const USE_SERVER_DIRECTIVE = 'use server';
const HONO_MODULE = /^@?hono(?:[/-]|$)/;
const FASTIFY_MODULE = /^(?:fastify|@fastify\/|fastify-)/;
const ROUTE_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'all', 'head', 'options', 'on', 'route']);
const FASTIFY_HANDLER_OPTIONS = new Set(['handler', 'preHandler', 'onRequest', 'preValidation', 'preParsing']);
const TYPED_REQUEST_PARAMETERS = new Set(['FastifyRequest', 'NextApiRequest']);
const HONO_CONTEXT_NAME = 'c';
const HONO_CONTEXT_MEMBERS = new Set(['req', 'json', 'text', 'html']);
const TRPC_RESOLVERS = new Set(['query', 'mutation', 'subscription']);
const TRPC_PROCEDURE_BASE = /procedure$/i;
// Reading these off a result takes one element or a count, so the full list never reaches the response.
const NARROWING_MEMBERS = new Set(['length', 'slice', 'splice', 'at', 'find', 'findIndex', 'some', 'every']);
const SIZE_PRESERVING_METHODS = new Set(['map', 'filter', 'sort', 'toSorted', 'reverse', 'flatMap']);
const TRANSPARENT_KINDS = [
  'isParenthesizedExpression',
  'isAwaitExpression',
  'isAsExpression',
  'isNonNullExpression',
  'isSatisfiesExpression',
  'isObjectLiteralExpression',
  'isPropertyAssignment',
  'isShorthandPropertyAssignment',
  'isArrayLiteralExpression',
  'isSpreadElement',
  'isSpreadAssignment',
];
const FALLBACK_OPERATORS = new Set([
  ts.SyntaxKind.BarBarToken,
  ts.SyntaxKind.QuestionQuestionToken,
  ts.SyntaxKind.AmpersandAmpersandToken,
]);
const MAX_ALIAS_DEPTH = 3;

function hasDecoratorNamed(node, names) {
  return !!node.modifiers?.some(
    (modifier) =>
      ts.isDecorator(modifier) &&
      ts.isCallExpression(modifier.expression) &&
      ts.isIdentifier(modifier.expression.expression) &&
      names.has(modifier.expression.expression.text),
  );
}

function parameterName(parameter) {
  return parameter && ts.isIdentifier(parameter.name) ? parameter.name.text : undefined;
}

function isExported(node) {
  return !!node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
}

const importedModulesByFile = new WeakMap();

function requiredModule(expression) {
  if (!ts.isCallExpression(expression)) return undefined;
  const isRequire = ts.isIdentifier(expression.expression) && expression.expression.text === 'require';
  if (!isRequire) return requiredModule(expression.expression);
  const [specifier] = expression.arguments;
  return specifier && ts.isStringLiteralLike(specifier) ? specifier.text : undefined;
}

function requiredModules(variableStatement) {
  const modules = [];
  for (const declaration of variableStatement.declarationList.declarations) {
    const module = declaration.initializer && requiredModule(declaration.initializer);
    if (module) modules.push(module);
  }
  return modules;
}

// Top-level `import ... from 'x'` and `const x = require('x')`, which are visible without installed packages.
function importedModules(sourceFile) {
  const cached = importedModulesByFile.get(sourceFile);
  if (cached) return cached;
  const modules = [];
  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteralLike(statement.moduleSpecifier)) {
      modules.push(statement.moduleSpecifier.text);
    } else if (ts.isVariableStatement(statement)) {
      modules.push(...requiredModules(statement));
    }
  }
  importedModulesByFile.set(sourceFile, modules);
  return modules;
}

function importsModule(node, modulePattern) {
  return importedModules(node.getSourceFile()).some((module) => modulePattern.test(module));
}

function directivePrologue(statements) {
  const directives = [];
  for (const statement of statements) {
    if (!ts.isExpressionStatement(statement) || !ts.isStringLiteral(statement.expression)) break;
    directives.push(statement.expression.text);
  }
  return directives;
}

function isDefaultExported(node) {
  const modifiers = node.modifiers ?? [];
  const isDefaultModifier = modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword);
  if (isExported(node) && isDefaultModifier) return true;
  if (ts.isExportAssignment(node.parent)) return true;
  const name = ts.isFunctionDeclaration(node) ? node.name : ts.isVariableDeclaration(node.parent) && node.parent.name;
  if (!name || !ts.isIdentifier(name)) return false;
  return node
    .getSourceFile()
    .statements.some(
      (statement) =>
        ts.isExportAssignment(statement) &&
        ts.isIdentifier(statement.expression) &&
        statement.expression.text === name.text,
    );
}

// The name `fn` is exported under: `export function GET() {}` or `export const GET = () => {}`.
function exportedName(fn) {
  if (ts.isFunctionDeclaration(fn)) return isExported(fn) ? fn.name?.text : undefined;
  const declaration = fn.parent;
  if (!ts.isVariableDeclaration(declaration) || !ts.isIdentifier(declaration.name)) return undefined;
  const statement = declaration.parent.parent;
  return ts.isVariableStatement(statement) && isExported(statement) ? declaration.name.text : undefined;
}

function isNextRouteHandler(node) {
  return NEXT_ROUTE_FILE.test(node.getSourceFile().fileName) && HTTP_VERB_EXPORTS.has(exportedName(node));
}

function isPagesApiHandler(node) {
  return (
    NEXT_PAGES_API_FILE.test(node.getSourceFile().fileName) && node.parameters.length > 0 && isDefaultExported(node)
  );
}

// An exported async function of a file that starts with 'use server', or a function whose own body starts with it.
function isServerAction(node) {
  if (ts.isBlock(node.body) && directivePrologue(node.body.statements).includes(USE_SERVER_DIRECTIVE)) return true;
  if (!node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)) return false;
  const fileIsServerOnly = directivePrologue(node.getSourceFile().statements).includes(USE_SERVER_DIRECTIVE);
  return fileIsServerOnly && (exportedName(node) !== undefined || isDefaultExported(node));
}

function routeCall(fn) {
  const call = fn.parent;
  if (!ts.isCallExpression(call) || !call.arguments.includes(fn) || !ts.isPropertyAccessExpression(call.expression))
    return undefined;
  return ROUTE_METHODS.has(call.expression.name.text) || call.expression.name.text === 'use' ? call : undefined;
}

function hasRoutePath(call, fn) {
  return call.arguments
    .slice(0, call.arguments.indexOf(fn))
    .some((argument) => ts.isStringLiteralLike(argument) && /^[/*]/.test(argument.text));
}

function usesHonoContext(fn, contextName) {
  let found = false;
  (function visit(node) {
    if (found) return;
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === contextName &&
      HONO_CONTEXT_MEMBERS.has(node.name.text)
    )
      found = true;
    else ts.forEachChild(node, visit);
  })(fn.body);
  return found;
}

// `app.get('/x', (c) => ...)` and `app.use(async (c, next) => ...)` where the callback reads or answers through `c`.
function isHonoHandler(node) {
  const call = routeCall(node);
  const contextName = parameterName(node.parameters[0]);
  if (!call || !contextName) return false;
  const isMiddleware = call.expression.name.text === 'use';
  if (!isMiddleware && !hasRoutePath(call, node)) return false;
  const looksLikeHono = importsModule(node, HONO_MODULE) || contextName === HONO_CONTEXT_NAME;
  return looksLikeHono && usesHonoContext(node, contextName);
}

function isFastifyRouteOption(node) {
  const property = ts.isMethodDeclaration(node) ? node : node.parent;
  if (!ts.isPropertyAssignment(property) && !ts.isMethodDeclaration(property)) return false;
  if (!ts.isIdentifier(property.name) || !FASTIFY_HANDLER_OPTIONS.has(property.name.text)) return false;
  const options = property.parent;
  const call = ts.isObjectLiteralExpression(options) && options.parent;
  if (!call || !ts.isCallExpression(call) || !ts.isPropertyAccessExpression(call.expression)) return false;
  return ROUTE_METHODS.has(call.expression.name.text) && isFastifyReceiver(call);
}

function isFastifyReceiver(call) {
  const receiver = call.expression.expression;
  return importsModule(call, FASTIFY_MODULE) || (ts.isIdentifier(receiver) && receiver.text === 'fastify');
}

function isFastifyHandler(node) {
  if (isFastifyRouteOption(node)) return true;
  const call = routeCall(node);
  if (!call || !node.parameters.length || call.expression.name.text === 'use') return false;
  return hasRoutePath(call, node) && isFastifyReceiver(call);
}

function isTrpcProcedureChain(receiver) {
  for (let node = receiver; node;) {
    if (ts.isIdentifier(node)) return TRPC_PROCEDURE_BASE.test(node.text);
    if (ts.isPropertyAccessExpression(node)) {
      if (node.name.text === 'procedure') return true;
      node = node.expression;
    } else if (ts.isCallExpression(node)) {
      const [argument] = node.arguments;
      const isInput = ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'input';
      if (isInput && argument && !ts.isStringLiteralLike(argument)) return true;
      node = node.expression;
    } else return false;
  }
  return false;
}

// `publicProcedure.input(schema).query(({ input, ctx }) => ...)`: the resolver answers a client request.
function isTrpcResolver(node) {
  const call = node.parent;
  if (!ts.isCallExpression(call) || call.arguments[0] !== node || !ts.isPropertyAccessExpression(call.expression))
    return false;
  return TRPC_RESOLVERS.has(call.expression.name.text) && isTrpcProcedureChain(call.expression.expression);
}

function hasTypedRequestParameter(node) {
  const type = node.parameters[0]?.type;
  return (
    node.parameters.length > 1 &&
    !!type &&
    ts.isTypeReferenceNode(type) &&
    ts.isIdentifier(type.typeName) &&
    TYPED_REQUEST_PARAMETERS.has(type.typeName.text)
  );
}

function isFrameworkHandler(node) {
  return (
    isNextRouteHandler(node) ||
    isPagesApiHandler(node) ||
    isServerAction(node) ||
    isHonoHandler(node) ||
    isFastifyHandler(node) ||
    isTrpcResolver(node) ||
    hasTypedRequestParameter(node)
  );
}

function isRequestHandler(node) {
  if (!ts.isFunctionLike(node) || !node.body) return false;
  if (ts.isMethodDeclaration(node)) return hasDecoratorNamed(node, ROUTE_DECORATORS) || isFastifyRouteOption(node);
  const [first, second] = node.parameters.map(parameterName);
  if (first && REQUEST_PARAMETER.test(first)) {
    if (second && RESPONSE_PARAMETER.test(second)) return true;
    if (ts.isFunctionDeclaration(node) && isExported(node) && HTTP_VERB_EXPORTS.has(node.name?.text)) return true;
  }
  return isFrameworkHandler(node);
}

function enclosingRequestHandler(node) {
  return ts.findAncestor(node.parent, isRequestHandler);
}

function isResponseCall(call) {
  const callee = call.expression;
  if (!ts.isPropertyAccessExpression(callee) || !RESPONSE_METHODS.has(callee.name.text)) return false;
  let receiver = ts.skipOuterExpressions(callee.expression);
  while (ts.isCallExpression(receiver) && ts.isPropertyAccessExpression(receiver.expression)) {
    receiver = ts.skipOuterExpressions(receiver.expression.expression);
  }
  return ts.isIdentifier(receiver) && RESPONSE_RECEIVER.test(receiver.text);
}

function identifiersNamed(root, name, declaration) {
  const found = [];
  (function visit(node) {
    if (ts.isIdentifier(node) && node.text === name && node !== declaration) found.push(node);
    ts.forEachChild(node, visit);
  })(root);
  return found;
}

function isTransparent(node) {
  return TRANSPARENT_KINDS.some((kind) => ts[kind](node));
}

// True when `value` is returned from `handler` or passed to a response call, possibly after being wrapped in an
// object or array, mapped, or stored in a local that is then returned. Stops at nested callbacks.
function reachesResponse(value, handler, depth = 0) {
  let current = value;
  for (let parent = current.parent; parent; current = parent, parent = parent.parent) {
    if (ts.isReturnStatement(parent)) return ts.findAncestor(parent, ts.isFunctionLike) === handler;
    if (ts.isArrowFunction(parent) && parent.body === current) return parent === handler;
    if (ts.isFunctionLike(parent)) return false;
    if (isTransparent(parent)) continue;
    if (ts.isConditionalExpression(parent) && parent.condition !== current) continue;
    if (ts.isBinaryExpression(parent) && parent.left === current) continue;
    if (ts.isBinaryExpression(parent) && FALLBACK_OPERATORS.has(parent.operatorToken.kind)) continue;
    if (ts.isCallExpression(parent)) return parent.arguments.includes(current) && isResponseCall(parent);
    if (ts.isPropertyAccessExpression(parent) && parent.expression === current) {
      const call = parent.parent;
      const isMethodCall = ts.isCallExpression(call) && call.expression === parent;
      if (isMethodCall && SIZE_PRESERVING_METHODS.has(parent.name.text)) {
        parent = call;
        continue;
      }
      if (isMethodCall || NARROWING_MEMBERS.has(parent.name.text)) return false;
      continue;
    }
    if (ts.isVariableDeclaration(parent) && parent.initializer === current) {
      return ts.isIdentifier(parent.name) && depth < MAX_ALIAS_DEPTH && usesReachResponse(parent.name, handler, depth);
    }
    return false;
  }
  return false;
}

function usesReachResponse(declaredName, handler, depth) {
  return identifiersNamed(handler.body, declaredName.text, declaredName).some((use) =>
    reachesResponse(use, handler, depth + 1),
  );
}

module.exports = {
  enclosingRequestHandler,
  reachesResponse,
  isRequestHandler,
  parameterName,
  isHonoHandler,
  isFastifyHandler,
  isPagesApiHandler,
  isServerAction,
};
