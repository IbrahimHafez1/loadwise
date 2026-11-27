// Where request data enters a handler (design section 2.2). Every source is recognised from
// project-local syntax: decorators and type names through their import binding, handler shapes
// through call and parameter names.
import { ts } from '../../performance/compiler.js';
import {
  isHonoHandler,
  isFastifyHandler,
  isPagesApiHandler,
  isServerAction,
} from '../../performance/request-handlers.js';
import { importedFrom } from '../bindings.js';
import type {
  CallExpression,
  Decorator,
  Expression,
  Node,
  ParameterDeclaration,
  SignatureDeclaration,
} from 'typescript';
import type { CheckerAdapter, ParameterSource, TaintContainer, TaintField } from '../../shared/types.js';

// A container field is either another container, or a tainted value: whole (an object of client
// fields) or a scalar. Fields not listed (req.user, req.session, ctx.state, file.path) are server
// data and stay clean.
const whole: TaintField = { taint: 'whole' };
const scalar: TaintField = { taint: 'scalar' };

const upload: TaintContainer = { fields: { originalname: scalar, mimetype: scalar, buffer: scalar } };
const expressRequest: TaintContainer = {
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
const koaRequest: TaintContainer = {
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
const koaContext: TaintContainer = {
  fields: { ...koaRequest.fields, params: whole, request: koaRequest, cookies: { calls: { get: scalar } } },
  calls: { get: scalar },
};
const searchParams: TaintContainer = { calls: { get: scalar, getAll: whole } };
const webRequest: TaintContainer = {
  fields: {
    url: scalar,
    headers: { calls: { get: scalar } },
    nextUrl: { fields: { searchParams, pathname: scalar, search: scalar } },
  },
  calls: { json: whole, formData: whole, text: scalar },
};
const honoContext: TaintContainer = {
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
const formData: TaintContainer = { calls: { get: scalar, getAll: whole } };
// The second argument of an App Router handler carries the dynamic route segments.
const nextRouteContext: TaintContainer = { fields: { params: whole } };
const trpcOptions: TaintContainer = { fields: { input: whole } };
const remixArguments: TaintContainer = { fields: { request: webRequest, params: whole } };

const nestDecorators: Record<string, ReadonlySet<string>> = {
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
// A pipe that parses the value into a number, boolean, UUID, enum or date leaves no injectable
// text.
const parsingPipes = new Set([
  'ParseIntPipe',
  'ParseFloatPipe',
  'ParseBoolPipe',
  'ParseUUIDPipe',
  'ParseEnumPipe',
  'ParseDatePipe',
]);
const routeMethods = new Set(['get', 'post', 'put', 'patch', 'delete', 'del', 'all', 'use', 'head', 'options']);
// Fastify derives `ip`, `ips` and `protocol` from X-Forwarded-* headers when `trustProxy` is on,
// and `raw` is the Node request. `routerPath` is the matched route pattern, so it stays clean.
const fastifyRequest: TaintContainer = {
  fields: {
    ...expressRequest.fields,
    ip: scalar,
    ips: whole,
    protocol: scalar,
    raw: { fields: { url: scalar, headers: whole } },
  },
  calls: expressRequest.calls,
};
const svelteKitEvent: TaintContainer = {
  fields: {
    request: webRequest,
    params: whole,
    url: { fields: { searchParams, pathname: scalar, search: scalar } },
    cookies: { calls: { get: scalar, getAll: whole } },
  },
};
const h3Event: TaintContainer = {
  fields: {
    node: { fields: { req: { fields: { url: scalar, headers: whole } } } },
    context: { fields: { params: whole } },
  },
};
const elysiaContext: TaintContainer = {
  fields: {
    body: whole,
    query: whole,
    params: whole,
    headers: whole,
    cookie: whole,
    request: webRequest,
    path: scalar,
  },
};
const hapiRequest: TaintContainer = {
  fields: {
    payload: whole,
    query: whole,
    params: whole,
    headers: whole,
    state: whole,
    path: scalar,
    url: { fields: { searchParams, pathname: scalar } },
  },
};

const typedRequests: Record<string, Record<string, TaintContainer>> = {
  express: { Request: expressRequest },
  fastify: { FastifyRequest: fastifyRequest },
  koa: { Context: koaContext, ParameterizedContext: koaContext },
  '@koa/router': { RouterContext: koaContext },
  'koa-router': { RouterContext: koaContext },
  hono: { Context: honoContext },
  'next/server': { NextRequest: webRequest },
  '@sveltejs/kit': { RequestEvent: svelteKitEvent },
  h3: { H3Event: h3Event },
  elysia: { Context: elysiaContext },
  '@hapi/hapi': { Request: hapiRequest },
};
const routeHandlerNames = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

function decoratorCall(decorator: Decorator) {
  const expression = decorator.expression;
  return ts.isCallExpression(expression) && ts.isIdentifier(expression.expression) ? expression : undefined;
}

// A same-named pipe of the project can return its input unchanged, so only the `@nestjs/common`
// export counts, under whatever local name it is imported.
function isParsingPipe(argument: Expression, checker: CheckerAdapter) {
  const node = ts.isNewExpression(argument) ? argument.expression : argument;
  const binding = importedFrom(node, checker);
  return binding?.module === '@nestjs/common' && binding.exported !== undefined && parsingPipes.has(binding.exported);
}

// The parameter's NestJS source decorator, or undefined. A parsing pipe makes the value clean
// (null).
function nestSource(parameter: ParameterDeclaration, checker: CheckerAdapter): ParameterSource | null | undefined {
  for (const decorator of ts.getDecorators(parameter) ?? []) {
    const call = decoratorCall(decorator);
    const binding = call && importedFrom(call.expression, checker);
    if (!call || !binding || binding.exported === undefined || !nestDecorators[binding.module]?.has(binding.exported))
      continue;
    if (call.arguments.some((argument) => isParsingPipe(argument, checker))) return null;
    const label = `@${binding.exported}(${call.arguments[0] && ts.isStringLiteralLike(call.arguments[0]) ? call.arguments[0].getText() : ''}) ${parameter.name.getText()}`;
    if (binding.exported === 'Req' || binding.exported === 'Request') return { container: expressRequest, label };
    if (binding.exported === 'UploadedFile') return { container: upload, label };
    if (binding.exported === 'UploadedFiles') return { container: { element: upload, fields: {} }, label };
    const named = call.arguments[0] && ts.isStringLiteralLike(call.arguments[0]);
    return { taint: named ? 'scalar' : 'whole', label };
  }
}

function typedSource(parameter: ParameterDeclaration, checker: CheckerAdapter): ParameterSource | undefined {
  const type = parameter.type;
  if (!type || !ts.isTypeReferenceNode(type) || !ts.isIdentifier(type.typeName)) return;
  const binding = importedFrom(type.typeName, checker);
  const container = binding?.exported === undefined ? undefined : typedRequests[binding.module]?.[binding.exported];
  return container && { container, label: parameter.name.getText() };
}

// `router.get(path, handler)` or `app.use(handler)`. With `withPath`, the first argument must be a
// literal route path, so callbacks of unrelated `.get(key, (error, value) => ...)` APIs are not
// mistaken for handlers.
function isRouteCallback(fn: SignatureDeclaration, withPath: boolean) {
  const call = fn.parent;
  if (!ts.isCallExpression(call) || !call.arguments.some((argument) => argument === fn)) return false;
  const callee = call.expression;
  if (!ts.isPropertyAccessExpression(callee) || !routeMethods.has(callee.name.text)) return false;
  const [route] = call.arguments;
  return !withPath || (ts.isStringLiteralLike(route) && route.text.startsWith('/'));
}

// `.query(({ input }) => ...)` or `.mutation(...)` on a chain that declared `.input(schema)`.
function isTrpcResolver(fn: SignatureDeclaration) {
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

function exportedName(fn: SignatureDeclaration): string | undefined {
  if (ts.isFunctionDeclaration(fn)) {
    const exported = ts.getCombinedModifierFlags(fn) & ts.ModifierFlags.Export;
    return exported ? fn.name?.text : undefined;
  }
  const declaration = fn.parent;
  if (!ts.isVariableDeclaration(declaration) || !ts.isIdentifier(declaration.name)) return;
  const statement = declaration.parent.parent;
  return ts.isVariableStatement(statement) && ts.getCombinedModifierFlags(declaration) & ts.ModifierFlags.Export
    ? declaration.name.text
    : undefined;
}

function isFormDataParameter(parameter: ParameterDeclaration) {
  const type = parameter.type;
  return !!type && ts.isTypeReferenceNode(type) && ts.isIdentifier(type.typeName) && type.typeName.text === 'FormData';
}

function isNextRouteFile(fn: Node) {
  return /(?:^|[/\\])route\.[cm]?[jt]sx?$/.test(fn.getSourceFile().fileName);
}

// The first parameter's model for handlers recognised by how they are registered (Hono, Fastify,
// Pages API).
function registeredHandlerRequest(fn: Node): TaintContainer | undefined {
  if (isHonoHandler(fn)) return honoContext;
  if (isFastifyHandler(fn)) return fastifyRequest;
  if (isPagesApiHandler(fn)) return expressRequest;
}

const h3WholeCalls = new Set(['readBody', 'getQuery', 'getRouterParams', 'getHeaders', 'readFormData']);
const h3ScalarCalls = new Set(['getRouterParam', 'getHeader', 'getCookie', 'readRawBody']);
const socketReceiverPattern = /(?:^|\.)(?:ws|wss|socket|io)$/i;

function h3SourceCall(
  call: CallExpression,
  checker: CheckerAdapter,
): { taint: 'whole' | 'scalar'; label: string } | undefined {
  const callee = ts.skipOuterExpressions(call.expression);
  if (!ts.isIdentifier(callee)) return;
  const binding = importedFrom(callee, checker);
  if (binding?.module !== 'h3' && binding?.module !== 'nitropack') return;
  const exported = binding.exported ?? callee.text;
  if (h3WholeCalls.has(exported)) return { taint: 'whole', label: call.getText() };
  if (h3ScalarCalls.has(exported)) return { taint: 'scalar', label: call.getText() };
}

function isGraphqlResolverArgs(parameter: ParameterDeclaration, fn: SignatureDeclaration, index: number): boolean {
  if (index !== 1 || fn.parameters.length < 2 || fn.parameters.length > 4) return false;
  const first = fn.parameters[0]?.name;
  const second = parameter.name;
  const firstText = ts.isIdentifier(first) ? first.text : undefined;
  const secondText = ts.isIdentifier(second) ? second.text : undefined;
  return Boolean(
    firstText &&
    /^(?:_?parent|_?root|_?source|_)$/.test(firstText) &&
    (secondText === 'args' || ts.isObjectBindingPattern(second)),
  );
}

function socketSource(
  parameter: ParameterDeclaration,
  fn: SignatureDeclaration,
  index: number,
): ParameterSource | undefined {
  const call = fn.parent;
  if (!ts.isCallExpression(call) || call.arguments[1] !== fn || !ts.isPropertyAccessExpression(call.expression)) return;
  if (call.expression.name.text !== 'on' || !socketReceiverPattern.test(call.expression.expression.getText())) return;
  const [event] = call.arguments;
  if (!event || !ts.isStringLiteralLike(event)) return;
  const label = parameter.name.getText();
  if (event.text === 'connection') return index === 1 ? { container: expressRequest, label } : undefined;
  return index === 0 ? { taint: 'whole', label } : undefined;
}

function shapeSource(parameter: ParameterDeclaration, fn: SignatureDeclaration): ParameterSource | undefined {
  const index = fn.parameters.indexOf(parameter);
  const name = ts.isIdentifier(parameter.name) ? parameter.name.text : undefined;
  if (isServerAction(fn))
    return isFormDataParameter(parameter)
      ? { container: formData, label: parameter.name.getText() }
      : { taint: 'whole', label: parameter.name.getText() };
  const exported = exportedName(fn);
  if (index === 1 && exported && isNextRouteFile(fn) && routeHandlerNames.has(exported))
    return { container: nextRouteContext, label: parameter.name.getText() };
  const socket = socketSource(parameter, fn, index);
  if (socket) return socket;
  if (isGraphqlResolverArgs(parameter, fn, index)) return { taint: 'whole', label: parameter.name.getText() };
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

// For a parameter: { taint: 'whole' | 'scalar', label }, { container, label }, null when a pipe
// sanitises it, or undefined when it is not a request source.
function parameterSource(parameter: ParameterDeclaration, checker: CheckerAdapter): ParameterSource | null | undefined {
  const fn = parameter.parent;
  if (!ts.isFunctionLike(fn)) return;
  const nest = nestSource(parameter, checker);
  if (nest !== undefined) return nest;
  return typedSource(parameter, checker) ?? shapeSource(parameter, fn);
}

export { parameterSource, h3SourceCall };
