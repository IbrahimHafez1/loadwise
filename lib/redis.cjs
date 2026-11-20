'use strict';

const { syntax: ts } = require('./compiler.cjs');
const { findRepeatOwner } = require('./repeated.cjs');
const { isSequentialByDesign } = require('./sequential-loops.cjs');

const IOREDIS_PACKAGES = ['ioredis'];
const NODE_REDIS_PACKAGES = ['redis', '@redis/client'];
const REDIS_RECEIVERS = ['Redis', 'Cluster', 'RedisClient', 'RedisClientType', 'RedisCluster', 'RedisClusterType'];

// Batch form per command as [ioredis, node-redis]; null means only a pipeline helps.
const perKeyCommands = new Map([
  ['get', ['mget(keys)', 'mGet(keys)']],
  ['set', ['mset(entries)', 'mSet(entries)']],
  ['hget', ['hmget(key, fields)', 'hmGet(key, fields)']],
  ['hgetall', null],
  ['hset', ['hset(key, fieldValues)', 'hSet(key, fieldValues)']],
  ['del', ['del(...keys)', 'del(keys)']],
  ['exists', ['exists(...keys)', 'exists(keys)']],
  ['incr', null],
  ['expire', null],
  ['sadd', ['sadd(key, ...members)', 'sAdd(key, members)']],
  ['sismember', ['smismember(key, members)', 'smIsMember(key, members)']],
  ['zadd', ['zadd(key, ...scoreMembers)', 'zAdd(key, members)']],
  ['zscore', ['zmscore(key, members)', 'zmScore(key, members)']],
  ['lpush', ['lpush(key, ...values)', 'lPush(key, values)']],
  ['rpush', ['rpush(key, ...values)', 'rPush(key, values)']],
]);

function isDeclaredIn(symbol, packages) {
  return !!symbol?.declarations?.some((declaration) => {
    const filename = declaration.getSourceFile().fileName.replaceAll('\\', '/');
    const marker = '/node_modules/';
    const start = filename.lastIndexOf(marker);
    if (start < 0) return false;
    const withinModules = filename.slice(start + marker.length);
    return packages.some((name) => withinModules.startsWith(name + '/'));
  });
}

function candidateSymbols(type) {
  // node-redis exposes its client as an intersection alias, so the class symbol sits on a member.
  const members = type.isIntersection() ? type.types : [type];
  return [type.aliasSymbol, ...members.map((member) => member.getSymbol())].filter(
    (symbol) => symbol && REDIS_RECEIVERS.includes(symbol.name),
  );
}

// Returns 'ioredis' or 'node-redis' for a client receiver, undefined for pipelines and other types.
function redisFlavour(receiver, checker) {
  const symbols = candidateSymbols(checker.getTypeAtLocation(receiver));
  if (symbols.some((symbol) => isDeclaredIn(symbol, IOREDIS_PACKAGES))) return 'ioredis';
  if (symbols.some((symbol) => isDeclaredIn(symbol, NODE_REDIS_PACKAGES))) return 'node-redis';
}

function receiverLabel(receiver) {
  const expression = ts.skipOuterExpressions(receiver);
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  return 'redis';
}

function queueAdvice(label, flavour) {
  return flavour === 'ioredis'
    ? `queue the commands on \`${label}.pipeline()\` and \`exec()\` once`
    : `queue the commands on \`${label}.multi()\` and \`execAsPipeline()\` once`;
}

function redisMessage(label, method, flavour) {
  const batch = perKeyCommands.get(method.toLowerCase())?.[flavour === 'ioredis' ? 0 : 1];
  const queue = queueAdvice(label, flavour);
  const fix = batch
    ? `Batch them with \`${label}.${batch}\`, or ${queue}`
    : `${queue[0].toUpperCase()}${queue.slice(1)}`;
  return `\`${label}.${method}\` runs once per item, one network round trip each. ${fix}. Ignore if each command depends on the previous reply.`;
}

function checkRedisCall(node, context) {
  const callee = node.expression;
  if (!ts.isPropertyAccessExpression(callee) || !perKeyCommands.has(callee.name.text.toLowerCase())) return;
  if (!context.isRepeated(node)) return;
  if (isSequentialByDesign(node, findRepeatOwner(node, context.checker))) return;
  const flavour = redisFlavour(callee.expression, context.checker);
  if (!flavour) return;
  context.report(
    callee.name,
    'redis-command-in-loop',
    redisMessage(receiverLabel(callee.expression), callee.name.text, flavour),
  );
}

module.exports = { checkRedisCall };
