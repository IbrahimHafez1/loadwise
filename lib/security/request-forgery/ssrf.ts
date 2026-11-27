// ssrf-request-url: an outgoing HTTP request whose host a caller chooses.
import { ts } from '../../performance/compiler.js';
import { importedFrom } from '../bindings.js';
import {
  strip,
  propertyValue,
  hasProperty,
  isGlobalIdentifier,
  hopReason,
  isAllowedHost,
  isHostHeader,
} from './shared.js';
import type { CallExpression, Expression } from 'typescript';
import type { SecurityRuleContext, UrlControl } from '../../shared/types.js';

/** How a client's calls take a URL: see `clients`. */
type ClientStyle = 'url' | 'method-url' | 'options';

/** A call to a known HTTP client; `method` is undefined when the client itself is called. */
interface ClientCall {
  module: string;
  method: string | undefined;
}

/**
 * A URL-bearing expression of a client call; `hostOnly` marks an options object's `host` and
 * `hostname`.
 */
interface UrlArgument {
  expression: Expression;
  hostOnly: boolean;
}

const ruleId = 'ssrf-request-url';
const message = (label: string) =>
  `The request URL host comes from \`${label}\`, so a caller can make this server reach internal addresses. Parse it with \`new URL()\` and allow only known hosts, or build the URL from a fixed origin.`;
const hostHeaderReason =
  'The host comes from the Host header; a reverse proxy that accepts only known hosts makes this unreachable.';

const verbMethods = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'request', 'stream']);
const clientPropertyMethods = new Set([...verbMethods, 'fetch', 'default']);
// Module -> how its calls take a URL: 'url' (first argument, a URL or a config object),
// 'method-url' (the method name first, as `needle('get', url)`), or 'options' (a URL or an
// http.request options object).
const clients: Record<string, ClientStyle> = {
  axios: 'url',
  got: 'url',
  ky: 'url',
  'node-fetch': 'url',
  'cross-fetch': 'url',
  'isomorphic-fetch': 'url',
  undici: 'url',
  superagent: 'url',
  needle: 'method-url',
  http: 'options',
  https: 'options',
  '@nestjs/axios': 'url',
};
const fetchModules = new Set(['node-fetch', 'cross-fetch', 'isomorphic-fetch', 'undici']);
// Agents from these packages refuse private and loopback addresses.
const filterModules = new Set(['ssrf-req-filter', 'request-filtering-agent']);
const agentOptions = ['agent', 'httpAgent', 'httpsAgent', 'dispatcher'];

// `const api = axios.create(...)`, so `api.get(url)` is recognised without installed types.
function createdClient(receiver: Expression, context: SecurityRuleContext): string | undefined {
  const node = strip(receiver);
  if (!ts.isIdentifier(node)) return;
  const declaration = context.checker.getSymbolAtLocation(node)?.valueDeclaration;
  const initializer = declaration && ts.isVariableDeclaration(declaration) ? strip(declaration.initializer) : undefined;
  if (!initializer || !ts.isCallExpression(initializer)) return;
  const callee = strip(initializer.expression);
  if (!ts.isPropertyAccessExpression(callee) || !['create', 'extend'].includes(callee.name.text)) return;
  const root = strip(callee.expression);
  const binding = ts.isIdentifier(root) ? importedFrom(root, context.checker) : undefined;
  return binding && clients[binding.module] === 'url' ? binding.module : undefined;
}

// { module, method } for a call to a known HTTP client, or undefined.
function clientCall(call: CallExpression, context: SecurityRuleContext): ClientCall | undefined {
  if (!call.arguments.length) return;
  const callee = strip(call.expression);
  if (ts.isIdentifier(callee) && callee.text === 'fetch' && isGlobalIdentifier(callee, context.checker))
    return { module: 'fetch', method: undefined };
  if (ts.isPropertyAccessExpression(callee)) {
    if (!clientPropertyMethods.has(callee.name.text)) return;
    const created = createdClient(callee.expression, context);
    if (created) return { module: created, method: callee.name.text };
  }
  const library = context.libraryCall(call);
  if (!library || library.module === undefined || !Object.hasOwn(clients, library.module)) return;
  // A namespace call (`https.get`) names the export; a default or instance call names the method.
  const method = library.method ?? (library.exported === 'default' ? undefined : library.exported);
  return { module: library.module, method };
}

// The URL-bearing expressions of a client call: [{ expression, hostOnly }].
function urlArguments(call: CallExpression, client: ClientCall): UrlArgument[] {
  const { module, method } = client;
  const style = module === 'fetch' ? 'url' : clients[module];
  if (fetchModules.has(module) && method && !['fetch', 'request', 'stream'].includes(method)) return [];
  if (style !== 'options' && method && !verbMethods.has(method)) return [];
  if (style === 'options' && (method === undefined || !['get', 'request'].includes(method))) return [];
  const methodFirst = style === 'method-url' && (!method || method === 'request');
  const first = call.arguments[methodFirst ? 1 : 0];
  if (!first) return [];
  if (!ts.isObjectLiteralExpression(strip(first))) return [{ expression: first, hostOnly: false }];
  const found: UrlArgument[] = [];
  for (const name of ['url', 'baseURL', 'prefixUrl', 'origin']) {
    const value = propertyValue(first, name);
    if (value) found.push({ expression: value, hostOnly: false });
  }
  for (const name of ['hostname', 'host']) {
    const value = propertyValue(first, name);
    if (value) found.push({ expression: value, hostOnly: true });
  }
  return found;
}

function hasFilteringAgent(call: CallExpression, context: SecurityRuleContext) {
  return call.arguments.some((argument: Expression) =>
    agentOptions.some((name) => {
      if (!hasProperty(argument, name)) return false;
      let root = strip(propertyValue(argument, name));
      while (root && (ts.isCallExpression(root) || ts.isNewExpression(root) || ts.isPropertyAccessExpression(root)))
        root = strip(root.expression);
      const binding = root && ts.isIdentifier(root) && importedFrom(root, context.checker);
      return Boolean(binding && filterModules.has(binding.module));
    }),
  );
}

function checkRequestUrl(call: CallExpression, context: SecurityRuleContext) {
  const client = clientCall(call, context);
  if (!client) return;
  const candidates = urlArguments(call, client);
  if (!candidates.length || hasFilteringAgent(call, context)) return;
  for (const { expression, hostOnly } of candidates) {
    const control = hostOnly ? hostControl(expression, context) : context.taint.urlControl(expression);
    if (!control || (control.part === 'path' && !control.rawPathname)) continue;
    if (isAllowedHost(call, expression, context, hostOnly)) continue;
    const { trace } = control;
    const reason =
      (control.part === 'path' ? 'The host is fixed; only the URL path is derived from input.' : undefined) ??
      hopReason(trace) ??
      (isHostHeader(trace) ? hostHeaderReason : undefined);
    context.report(call, ruleId, message(trace.label), reason, { taint: trace });
    return;
  }
}

function hostControl(expression: Expression, context: SecurityRuleContext): UrlControl | undefined {
  const trace = context.taint.trace(expression, 'url');
  return trace && { part: 'host', trace };
}

export { ruleId, checkRequestUrl };
