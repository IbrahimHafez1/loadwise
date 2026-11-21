'use strict';

const { syntax: ts } = require('./compiler.cjs');

const IOREDIS_PACKAGES = ['ioredis'];
const NODE_REDIS_PACKAGES = ['redis', '@redis/client'];
const REDIS_RECEIVERS = ['Redis', 'Cluster', 'RedisClient', 'RedisClientType', 'RedisCluster', 'RedisClusterType'];

function candidateSymbols(type) {
  // node-redis exposes its client as an intersection alias, so the class symbol sits on a member.
  const members = type.flags & ts.TypeFlags.Intersection ? type.types : [type];
  return [type.aliasSymbol, ...members.map((member) => member.getSymbol())].filter(
    (symbol) => symbol && REDIS_RECEIVERS.includes(symbol.name),
  );
}

function receiverLabel(receiver) {
  const expression = ts.skipOuterExpressions(receiver);
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  return 'redis';
}

module.exports = { IOREDIS_PACKAGES, NODE_REDIS_PACKAGES, candidateSymbols, receiverLabel };
