'use strict';

// KEYS walks the whole keyspace in one command.
const fs = require('node:fs');
const { syntax: ts } = require('./compiler.cjs');

const IOREDIS_PACKAGES = ['ioredis'];
const NODE_REDIS_PACKAGES = ['redis', '@redis/client'];
const REDIS_RECEIVERS = ['Redis', 'Cluster', 'RedisClient', 'RedisClientType', 'RedisCluster', 'RedisClusterType'];
// Raw-command entry points that take the command name as an argument.
const RAW_COMMAND_METHODS = new Set(['call', 'send_command', 'sendcommand']);
const NODE_REDIS_ARRAY_ITERATOR_MAJOR = 5;

// The package folder (`.../node_modules/ioredis`) a symbol is declared in, when it is one of `packages`.
function declaringPackageFolder(symbol, packages) {
  for (const declaration of symbol?.declarations ?? []) {
    const filename = declaration.getSourceFile().fileName.replaceAll('\\', '/');
    const marker = '/node_modules/';
    const start = filename.lastIndexOf(marker);
    if (start < 0) continue;
    const within = filename.slice(start + marker.length);
    const name = packages.find((candidate) => within.startsWith(candidate + '/'));
    if (name) return filename.slice(0, start + marker.length) + name;
  }
}

function candidateSymbols(type) {
  // node-redis exposes its client as an intersection alias, so the class symbol sits on a member.
  const members = type.flags & ts.TypeFlags.Intersection ? type.types : [type];
  return [type.aliasSymbol, ...members.map((member) => member.getSymbol())].filter(
    (symbol) => symbol && REDIS_RECEIVERS.includes(symbol.name),
  );
}

function majorVersion(packageFolder) {
  try {
    const { version } = JSON.parse(fs.readFileSync(packageFolder + '/package.json', 'utf8'));
    return Number.parseInt(version, 10);
  } catch {
    return undefined;
  }
}

// { flavour: 'ioredis' | 'node-redis', major } for a client receiver, undefined for pipelines and other types.
function redisClient(receiver, checker) {
  const symbols = candidateSymbols(checker.getTypeAtLocation(receiver));
  for (const symbol of symbols) {
    if (declaringPackageFolder(symbol, IOREDIS_PACKAGES)) return { flavour: 'ioredis' };
    const folder = declaringPackageFolder(symbol, NODE_REDIS_PACKAGES);
    if (folder) return { flavour: 'node-redis', major: majorVersion(folder) };
  }
}

function isKeysCommandName(node) {
  return !!node && ts.isStringLiteralLike(node) && node.text.toLowerCase() === 'keys';
}

// `redis.keys(p)`, `redis.call('KEYS', p)`, `client.sendCommand(['KEYS', p])`.
function isKeysCall(call) {
  const method = call.expression.name.text.toLowerCase();
  if (method === 'keys') return true;
  if (!RAW_COMMAND_METHODS.has(method)) return false;
  const [first] = call.arguments;
  if (isKeysCommandName(first)) return true;
  return !!first && ts.isArrayLiteralExpression(first) && isKeysCommandName(first.elements[0]);
}

const COMMON_ADVICE =
  'it walks the whole keyspace in one command and Redis is single-threaded, so every client waits while it runs and the stall grows with the total key count.';
const NAMESPACE_ADVICE = 'For pattern deletes prefer a version/namespace key so no scan is needed.';
const SCAN_CAVEAT = 'SCAN can return a key twice and may miss keys written while it runs.';

function message(label, client) {
  const iteration =
    client.flavour === 'ioredis'
      ? `Iterate with \`for await (const batch of ${label}.scanStream({ match, count: 100 }))\``
      : client.major < NODE_REDIS_ARRAY_ITERATOR_MAJOR
        ? `Iterate with \`for await (const key of ${label}.scanIterator({ MATCH, COUNT: 100 }))\` (yields one key per step)`
        : `Iterate with \`${label}.scanIterator({ MATCH, COUNT: 100 })\` (yields keys one by one in v4, arrays in v5)`;
  return `\`${label}.keys()\` blocks Redis: ${COMMON_ADVICE} ${iteration}. ${NAMESPACE_ADVICE} Caveat: ${SCAN_CAVEAT}`;
}

function receiverLabel(receiver) {
  const expression = ts.skipOuterExpressions(receiver);
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  return 'redis';
}

function check(node, context) {
  if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return;
  if (!isKeysCall(node)) return;
  const client = redisClient(node.expression.expression, context.checker);
  if (!client) return;
  context.report(
    node.expression.name,
    'redis-keys-command',
    message(receiverLabel(node.expression.expression), client),
  );
}

module.exports = { check };
