'use strict';

const { IOREDIS_PACKAGES, NODE_REDIS_PACKAGES, candidateSymbols, receiverLabel } = require('./redis-client.cjs');
const { syntax: ts } = require('./compiler.cjs');
const { findRepeatOwner } = require('./repeated.cjs');
const { isSequentialByDesign } = require('./sequential-loops.cjs');

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

// Returns 'ioredis' or 'node-redis' for a client receiver, undefined for pipelines and other types.
function redisFlavour(receiver, checker) {
  const symbols = candidateSymbols(checker.getTypeAtLocation(receiver));
  if (symbols.some((symbol) => isDeclaredIn(symbol, IOREDIS_PACKAGES))) return 'ioredis';
  if (symbols.some((symbol) => isDeclaredIn(symbol, NODE_REDIS_PACKAGES))) return 'node-redis';
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

const multiKeyCommands = new Set(['del', 'unlink', 'exists']);
const scanCommands = new Set(['scan', 'sscan', 'hscan', 'zscan']);

// del(...keys) and exists([keys]) already send every key in one command.
function isAlreadyBatched(callee, call) {
  if (!multiKeyCommands.has(callee.name.text.toLowerCase())) return false;
  return call.arguments.some(
    (argument) => ts.isSpreadElement(argument) || ts.isArrayLiteralExpression(ts.skipOuterExpressions(argument)),
  );
}

function isBatchLengthCheck(condition, name) {
  const check = ts.skipOuterExpressions(condition);
  return (
    ts.isBinaryExpression(check) &&
    [
      ts.SyntaxKind.EqualsEqualsEqualsToken,
      ts.SyntaxKind.EqualsEqualsToken,
      ts.SyntaxKind.GreaterThanEqualsToken,
      ts.SyntaxKind.GreaterThanToken,
    ].includes(check.operatorToken.kind) &&
    ts.isPropertyAccessExpression(check.left) &&
    check.left.name.text === 'length' &&
    ts.isIdentifier(check.left.expression) &&
    check.left.expression.text === name
  );
}

function appendsTo(node, name) {
  if (ts.isFunctionLike(node)) return false;
  if (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === 'push' &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === name
  )
    return true;
  return !!ts.forEachChild(node, (child) => appendsTo(child, name) || undefined);
}

// `if (keys.length === BATCH) await del(keys)` in a loop that fills `keys` sends one batch per round,
// the advised pattern for deleting many keys.
function isFlushedBatch(callee, call, owner) {
  if (!multiKeyCommands.has(callee.name.text.toLowerCase()) || !owner || ts.isFunctionLike(owner)) return false;
  return call.arguments.some((argument) => {
    const batch = ts.skipOuterExpressions(argument);
    if (!ts.isIdentifier(batch) || !appendsTo(owner.statement, batch.text)) return false;
    for (let node = call.parent; node && node !== owner; node = node.parent)
      if (ts.isIfStatement(node) && isBatchLengthCheck(node.expression, batch.text)) return true;
    return false;
  });
}

function callsScan(node) {
  if (ts.isFunctionLike(node)) return false;
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression))
    if (scanCommands.has(node.expression.name.text.toLowerCase())) return true;
  return !!ts.forEachChild(node, (child) => callsScan(child) || undefined);
}

// Each round of a SCAN cursor drain needs the cursor returned by the previous round.
const scanCursorLoops = new WeakMap();

function isScanCursorLoop(owner) {
  if (!owner || ts.isFunctionLike(owner)) return false;
  let result = scanCursorLoops.get(owner.statement);
  if (result === undefined) {
    result = callsScan(owner.statement);
    scanCursorLoops.set(owner.statement, result);
  }
  return result;
}

const counterCommands = new Set(['incr', 'incrby', 'hincrby']);
const expireCommands = new Set(['expire', 'pexpire', 'expireat', 'pexpireat']);

function sourceText(node) {
  const sourceFile = node.getSourceFile();
  return sourceFile.text.slice(node.getStart(sourceFile), node.end);
}

// The first `expire`-family call after `counter` in the same function on the same client and key.
function followingExpire(counter, receiverText, keyText) {
  const scope = ts.findAncestor(counter.parent, ts.isFunctionLike)?.body ?? counter.getSourceFile();
  let found;
  (function visit(node) {
    if (found) return;
    if (
      node.pos >= counter.end &&
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      expireCommands.has(node.expression.name.text.toLowerCase()) &&
      node.arguments[0] &&
      sourceText(ts.skipOuterExpressions(node.expression.expression)) === receiverText &&
      sourceText(ts.skipOuterExpressions(node.arguments[0])) === keyText
    )
      found = node;
    else ts.forEachChild(node, visit);
  })(scope);
  return found;
}

function incrThenExpireMessage(label, counterMethod, expireMethod) {
  const counter = `${label}.${counterMethod}`;
  const expire = `${label}.${expireMethod}`;
  const atomic = `${label}.multi().${counterMethod}(key).${expireMethod}(key, ttl, 'NX').exec()`;
  return `\`${counter}\` and the later \`${expire}\` on the same key are two round trips and not atomic: if the process stops or the second command fails in between, the key keeps its count with no TTL and never resets. Send both in one \`${atomic}\` (\`NX\` needs Redis 7 and keeps the TTL of the first increment), or run both in one Lua script. Caveat: the counter value then comes from the \`exec()\` reply.`;
}

function checkIncrThenExpire(node, callee, context) {
  if (!counterCommands.has(callee.name.text.toLowerCase())) return;
  const [key] = node.arguments;
  if (!key) return;
  const receiver = ts.skipOuterExpressions(callee.expression);
  const expire = followingExpire(node, sourceText(receiver), sourceText(ts.skipOuterExpressions(key)));
  if (!expire || !redisFlavour(callee.expression, context.checker)) return;
  context.report(
    callee.name,
    'redis-incr-then-expire',
    incrThenExpireMessage(receiverLabel(callee.expression), callee.name.text, expire.expression.name.text),
  );
}

function checkRedisCall(node, context) {
  const callee = node.expression;
  if (!ts.isPropertyAccessExpression(callee)) return;
  checkIncrThenExpire(node, callee, context);
  if (!perKeyCommands.has(callee.name.text.toLowerCase())) return;
  if (!context.isRepeated(node)) return;
  const owner = findRepeatOwner(node, context.checker);
  if (
    isSequentialByDesign(node, owner) ||
    isScanCursorLoop(owner) ||
    isAlreadyBatched(callee, node) ||
    isFlushedBatch(callee, node, owner)
  )
    return;
  const flavour = redisFlavour(callee.expression, context.checker);
  if (!flavour) return;
  context.report(
    callee.name,
    'redis-command-in-loop',
    redisMessage(receiverLabel(callee.expression), callee.name.text, flavour),
  );
}

module.exports = { checkRedisCall };
