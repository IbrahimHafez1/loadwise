'use strict';

// Where request data enters a handler (design section 2.2). Every source is recognised from project-local syntax:
// decorators and type names through their import binding, handler shapes through call and parameter names.
const { syntax: ts } = require('../../performance/compiler.cjs');
const {
  isHonoHandler,
  isFastifyHandler,
  isPagesApiHandler,
  isServerAction,
} = require('../../performance/request-handlers.cjs');
const { importedFrom } = require('../bindings.cjs');

// A container field is either another container, or a tainted value: whole (an object of client fields) or a
// scalar. Fields not listed (req.user, req.session, ctx.state, file.path) are server data and stay clean.
const whole = { taint: 'whole' };
const scalar = { taint: 'scalar' };

const upload = { fields: { originalname: scalar, mimetype: scalar, buffer: scalar } };
const expressRequest = {
  fields: {
    body: whole,
    query: whole,
    params: whole,
    headers: whole,
    cookies: whole,
    signedCookies: whole,
    url: scalar,
    originalUrl: scalar,
    path: scalar,
    hostname: scalar,
    file: upload,
    files: { element: upload, fields: {} },
  },
  calls: { get: scalar, header: scalar },
};
const koaRequest = {
  fields: {
    body: whole,
    query: whole,
    headers: whole,
    header: whole,
    url: scalar,
    originalUrl: scalar,
    path: scalar,
    querystring: scalar,
    href: scalar,
    host: scalar,
    hostname: scalar,
    files: whole,
  },
  calls: { get: scalar },
};
const koaContext = {
  fields: { ...koaRequest.fields, params: whole, request: koaRequest, cookies: { calls: { get: scalar } } },
  calls: { get: scalar },
};
const searchParams = { calls: { get: scalar, getAll: whole } };
const webRequest = {
  fields: {
    url: scalar,
    headers: { calls: { get: scalar } },
    nextUrl: { fields: { searchParams, pathname: scalar, search: scalar } },
  },
  calls: { json: whole, formData: whole, text: scalar },
};
const honoContext = {
  fields: {
    req: {
      fields: { url: scalar, path: scalar },
      calls: {
        query: scalar,
        queries: whole,
        param: scalar,
        json: whole,
        header: scalar,
        text: scalar,
        parseBody: whole,
        formData: whole,
        valid: whole,
      },
    },
  },
};
// A server action's `FormData` argument: every entry is client text.
const formData = { calls: { get: scalar, getAll: whole } };
// The second argument of an App Router handler carries the dynamic route segments.
const nextRouteContext = { fields: { params: whole } };
const trpcOptions = { fields: { input: whole } };
const remixArguments = { fields: { request: webRequest, params: whole } };

const nestDecorators = {
  '@nestjs/common': new Set([
    'Body',
    'Query',
    'Param',
    'Headers',
    'HostParam',
    'RawBody',
    'Req',
    'Request',
    'UploadedFile',
    'UploadedFiles',
  ]),
  '@nestjs/graphql': new Set(['Args']),
  '@nestjs/websockets': new Set(['MessageBody']),
};
// A pipe that parses the value into a number, boolean, UUID, enum or date leaves no injectable text.
const parsingPipes = new Set([
  'ParseIntPipe',
  'ParseFloatPipe',
  'ParseBoolPipe',
  'ParseUUIDPipe',
  'ParseEnumPipe',
  'ParseDatePipe',
]);
const routeMethods = new Set(['get', 'post', 'put', 'patch', 'delete', 'del', 'all', 'use', 'head', 'options']);
// Fastify derives `ip`, `ips` and `protocol` from X-Forwarded-* headers when `trustProxy` is on, and `raw` is the
// Node request. `routerPath` is the matched route pattern, so it stays clean.
const fastifyRequest = {
  fields: {
    ...expressRequest.fields,
    ip: scalar,
    ips: whole,
    protocol: scalar,
    raw: { fields: { url: scalar, headers: whole } },
  },
  calls: expressRequest.calls,
};
const typedRequests = {
  express: { Request: expressRequest },
  fastify: { FastifyRequest: fastifyRequest },
  koa: { Context: koaContext, ParameterizedContext: koaContext },
  '@koa/router': { RouterContext: koaContext },
  'koa-router': { RouterContext: koaContext },
  hono: { Context: honoContext },
  'next/server': { NextRequest: webRequest },
};
const routeHandlerNames = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

function decoratorCall(decorator) {
  const expression = decorator.expression;
  return ts.isCallExpression(expression) && ts.isIdentifier(expression.expression) ? expression : undefined;
}

function isParsingPipe(argument) {
  const node = ts.isNewExpression(argument) ? argument.expression : argument;
  return ts.isIdentifier(node) && parsingPipes.has(node.text);
}

// The parameter's NestJS source decorator, or undefined. A parsing pipe makes the value clean (null).
function nestSource(parameter, checker) {
  for (const decorator of ts.getDecorators(parameter) ?? []) {
    const call = decoratorCall(decorator);
    const binding = call && importedFrom(call.expression, checker);
    if (!binding || !nestDecorators[binding.module]?.has(binding.exported)) continue;
    if (call.arguments.some(isParsingPipe)) return null;
    const label = `@${binding.exported}(${call.arguments[0] && ts.isStringLiteralLike(call.arguments[0]) ? call.arguments[0].getText() : ''}) ${parameter.name.getText()}`;
    if (binding.exported === 'Req' || binding.exported === 'Request') return { container: expressRequest, label };
    if (binding.exported === 'UploadedFile') return { container: upload, label };
    if (binding.exported === 'UploadedFiles') return { container: { element: upload, fields: {} }, label };
    const named = call.arguments[0] && ts.isStringLiteralLike(call.arguments[0]);
    return { taint: named ? 'scalar' : 'whole', label };
  }
}

function typedSource(parameter, checker) {
  const type = parameter.type;
  if (!type || !ts.isTypeReferenceNode(type) || !ts.isIdentifier(type.typeName)) return;
  const binding = importedFrom(type.typeName, checker);
  const container = binding && typedRequests[binding.module]?.[binding.exported];
  return container && { container, label: parameter.name.getText() };
}

// `router.get(path, handler)` or `app.use(handler)`. With `withPath`, the first argument must be a literal route
// path, so callbacks of unrelated `.get(key, (error, value) => ...)` APIs are not mistaken for handlers.
function isRouteCallback(fn, withPath) {
  const call = fn.parent;
  if (!ts.isCallExpression(call) || !call.arguments.includes(fn)) return false;
  const callee = call.expression;
  if (!ts.isPropertyAccessExpression(callee) || !routeMethods.has(callee.name.text)) return false;
  const [route] = call.arguments;
  return !withPath || (ts.isStringLiteralLike(route) && route.text.startsWith('/'));
}

// `.query(({ input }) => ...)` or `.mutation(...)` on a chain that declared `.input(schema)`.
function isTrpcResolver(fn) {
  const call = fn.parent;
  if (!ts.isCallExpression(call) || call.arguments[0] !== fn || !ts.isPropertyAccessExpression(call.expression))
    return false;
  if (!['query', 'mutation', 'subscription'].includes(call.expression.name.text)) return false;
  for (let node = call.expression.expression; ts.isCallExpression(node);) {
    if (!ts.isPropertyAccessExpression(node.expression)) return false;
    if (node.expression.name.text === 'input') return true;
    node = node.expression.expression;
  }
  return false;
}

function exportedName(fn) {
  if (ts.isFunctionDeclaration(fn)) {
    const exported = ts.getCombinedModifierFlags(fn) & ts.ModifierFlags.Export;
    return exported ? fn.name?.text : undefined;
  }
  const declaration = fn.parent;
  if (!ts.isVariableDeclaration(declaration) || !ts.isIdentifier(declaration.name)) return;
  const statement = declaration.parent.parent;
  return ts.isVariableStatement(statement) && ts.getCombinedModifierFlags(statement) & ts.ModifierFlags.Export
    ? declaration.name.text
    : undefined;
}

function isFormDataParameter(parameter) {
  const type = parameter.type;
  return !!type && ts.isTypeReferenceNode(type) && ts.isIdentifier(type.typeName) && type.typeName.text === 'FormData';
}

function isNextRouteFile(fn) {
  return /(?:^|[/\\])route\.[cm]?[jt]sx?$/.test(fn.getSourceFile().fileName);
}

// The first parameter's model for handlers recognised by how they are registered (Hono, Fastify, Pages API).
function registeredHandlerRequest(fn) {
  if (isHonoHandler(fn)) return honoContext;
  if (isFastifyHandler(fn)) return fastifyRequest;
  if (isPagesApiHandler(fn)) return expressRequest;
}

function shapeSource(parameter, fn) {
  const index = fn.parameters.indexOf(parameter);
  const name = ts.isIdentifier(parameter.name) ? parameter.name.text : undefined;
  if (isServerAction(fn))
    return isFormDataParameter(parameter)
      ? { container: formData, label: parameter.name.getText() }
      : { taint: 'whole', label: parameter.name.getText() };
  const exported = exportedName(fn);
  if (index === 1 && exported && isNextRouteFile(fn) && routeHandlerNames.has(exported))
    return { container: nextRouteContext, label: parameter.name.getText() };
  if (index !== 0) return;
  const label = parameter.name.getText();
  const registered = registeredHandlerRequest(fn);
  if (registered) return { container: registered, label };
  const second = fn.parameters[1]?.name;
  const secondName = second && ts.isIdentifier(second) ? second.text : undefined;
  if (/^(?:req|request)$/.test(name ?? '') && /^(?:res|response|reply)$/.test(secondName ?? ''))
    return { container: expressRequest, label };
  if (name === 'ctx' && isRouteCallback(fn, false)) return { container: koaContext, label };
  if (fn.parameters.length >= 2 && isRouteCallback(fn, true) && name) return { container: expressRequest, label };
  if (isTrpcResolver(fn)) return { container: trpcOptions, label: ts.isIdentifier(parameter.name) ? label : 'tRPC' };
  if (exported && isNextRouteFile(fn) && routeHandlerNames.has(exported)) return { container: webRequest, label };
  if (exported === 'loader' || exported === 'action') return { container: remixArguments, label };
}

// For a parameter: { taint: 'whole' | 'scalar', label }, { container, label }, null when a pipe sanitises it, or
// undefined when it is not a request source.
function parameterSource(parameter, checker) {
  const fn = parameter.parent;
  if (!ts.isFunctionLike(fn)) return;
  const nest = nestSource(parameter, checker);
  if (nest !== undefined) return nest;
  return typedSource(parameter, checker) ?? shapeSource(parameter, fn);
}

module.exports = { parameterSource };
