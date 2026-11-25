import { ts } from './compiler.js';
import type { Expression } from 'typescript';
import type { SymbolAdapter, TypeAdapter } from '../shared/types.js';

const IOREDIS_PACKAGES = ['ioredis'];
const NODE_REDIS_PACKAGES = ['redis', '@redis/client'];
const REDIS_RECEIVERS = ['Redis', 'Cluster', 'RedisClient', 'RedisClientType', 'RedisCluster', 'RedisClusterType'];

function candidateSymbols(type: TypeAdapter): SymbolAdapter[] {
  // node-redis exposes its client as an intersection alias, so the class symbol sits on a member.
  const members = type.flags & ts.TypeFlags.Intersection ? (type.types ?? []) : [type];
  const symbols: (SymbolAdapter | undefined)[] = [type.aliasSymbol, ...members.map((member) => member.getSymbol())];
  return symbols.filter((symbol): symbol is SymbolAdapter => !!symbol && REDIS_RECEIVERS.includes(symbol.name));
}

function receiverLabel(receiver: Expression): string {
  const expression = ts.skipOuterExpressions(receiver);
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  return 'redis';
}

export { IOREDIS_PACKAGES, NODE_REDIS_PACKAGES, candidateSymbols, receiverLabel };
