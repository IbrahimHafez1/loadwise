'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { syntax: ts } = require('./compiler.cjs');

const ROUTE_RULE = 'async-route-unhandled-rejection';
const CALLBACK_RULE = 'async-callback-unhandled-rejection';
const ROUTE_MESSAGE =
  'This async Express route handler has no try/catch around its awaits and no `next`, so on Express 4 a rejection never reaches the error middleware: the request hangs until it times out and Node logs an unhandled rejection. Catch the error and pass it to `next(error)`, wrap the handler (for example with express-async-handler), or upgrade to Express 5, which forwards rejections.';
const CALLBACK_MESSAGE =
  'This async callback is given to an emitter, timer or scheduler that ignores the promise it returns, so a rejection inside it is unhandled and, on Node 15 and later, crashes the process. Wrap the awaits in try/catch and log or handle the error.';
const UNKNOWN_EXPRESS_REASON =
  'The Express version could not be read from package.json; Express 5 forwards async rejections to the error middleware, so this only matters on Express 4.';

const ROUTE_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'all', 'use']);
const EMITTER_METHODS = new Set(['on', 'once', 'addListener']);
const TIMER_FUNCTIONS = new Set(['setTimeout', 'setInterval', 'setImmediate']);
const CRON_RECEIVER = /^(?:cron|nodeCron)$/;
const REQUEST_PARAMETER = /^_?req(?:uest)?$/;
const RESPONSE_PARAMETER = /^_?res(?:ponse)?$/;
const ASYNC_ERROR_PACKAGES = /['"]express-async-(?:errors|handler)['"]/;
const FIRST_EXPRESS_MAJOR_FORWARDING_REJECTIONS = 5;
const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies'];

function isAsyncFunctionArgument(node) {
  return (
    (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) &&
    Boolean(node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword))
  );
}

// True when the await sits in a try block (or its catch clause) of a try statement that has a catch.
function isCaught(awaitNode, owner) {
  // `await promise.catch(handler)` settles even when the promise rejects.
  if (ts.isAwaitExpression(awaitNode) && isCatchCall(awaitNode.expression)) return true;
  for (let child = awaitNode, parent = awaitNode.parent; parent && parent !== owner;) {
    if (ts.isTryStatement(parent) && parent.catchClause && child !== parent.finallyBlock) return true;
    child = parent;
    parent = parent.parent;
  }
  return false;
}

function isCatchCall(expression) {
  const call = ts.skipOuterExpressions(expression);
  return (
    ts.isCallExpression(call) && ts.isPropertyAccessExpression(call.expression) && call.expression.name.text === 'catch'
  );
}

// Awaits of `fn` itself (nested functions handle their own) that a try/catch does not cover.
function hasUncaughtAwait(fn) {
  let found = false;
  (function visit(node) {
    if (found) return;
    if (node !== fn && ts.isFunctionLike(node)) return;
    const awaits = ts.isAwaitExpression(node) || (ts.isForOfStatement(node) && node.awaitModifier);
    if (awaits && !isCaught(node, fn)) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  })(fn.body);
  return found;
}

function parameterName(parameter) {
  return parameter && ts.isIdentifier(parameter.name) ? parameter.name.text : undefined;
}

function looksLikeExpressHandler(fn) {
  const [request, response] = fn.parameters.map(parameterName);
  // A third parameter is `next` (or an error handler's), so the handler can forward errors itself.
  return fn.parameters.length === 2 && REQUEST_PARAMETER.test(request ?? '') && RESPONSE_PARAMETER.test(response ?? '');
}

const asyncErrorPackagePrograms = new WeakMap();

// express-async-errors patches Express globally, so one import anywhere covers every handler.
function programPatchesAsyncErrors(program, sourceFile) {
  if (!program?.getSourceFiles) return ASYNC_ERROR_PACKAGES.test(sourceFile.text);
  if (!asyncErrorPackagePrograms.has(program)) {
    asyncErrorPackagePrograms.set(
      program,
      program
        .getSourceFiles()
        .some(
          (source) =>
            !source.isDeclarationFile &&
            !source.fileName.replaceAll('\\', '/').includes('/node_modules/') &&
            ASYNC_ERROR_PACKAGES.test(source.text),
        ),
    );
  }
  return asyncErrorPackagePrograms.get(program);
}

function readManifest(directory) {
  try {
    return JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
  } catch {
    return undefined;
  }
}

function expressRange(manifest) {
  for (const field of DEPENDENCY_FIELDS) {
    const range = manifest?.[field]?.express;
    if (typeof range === 'string') return range;
  }
}

// Major version from a plain range such as `4.18.2`, `^4.18.2`, `~4` or `4.x`; anything else is unknown.
function majorOf(range) {
  const match = /^\s*[\^~=v]*\s*(\d+)(?:\.[\dxX*]+)*\s*$/.exec(range);
  return match ? Number(match[1]) : undefined;
}

const expressMajorsByProgram = new WeakMap();

// The Express major declared by the nearest package.json that lists express, cached per program and folder.
function expressMajor(program, fileName) {
  const cacheKey = program ?? expressMajorsByProgram;
  if (!expressMajorsByProgram.has(cacheKey)) expressMajorsByProgram.set(cacheKey, new Map());
  const majors = expressMajorsByProgram.get(cacheKey);
  const start = path.dirname(fileName);
  if (majors.has(start)) return majors.get(start);
  let major;
  for (let directory = start; ; directory = path.dirname(directory)) {
    const range = expressRange(readManifest(directory));
    if (range !== undefined) {
      major = majorOf(range);
      break;
    }
    if (path.dirname(directory) === directory) break;
  }
  majors.set(start, major);
  return major;
}

function checkRoute(node, context) {
  const callee = ts.skipOuterExpressions(node.expression);
  if (!ts.isPropertyAccessExpression(callee) || !ROUTE_METHODS.has(callee.name.text)) return;
  const handlers = node.arguments.filter(
    (argument) => isAsyncFunctionArgument(argument) && looksLikeExpressHandler(argument) && hasUncaughtAwait(argument),
  );
  if (handlers.length === 0) return;
  const sourceFile = node.getSourceFile();
  if (programPatchesAsyncErrors(context.program, sourceFile)) return;
  const major = expressMajor(context.program, sourceFile.fileName);
  if (major >= FIRST_EXPRESS_MAJOR_FORWARDING_REJECTIONS) return;
  for (const handler of handlers) {
    context.report(handler, ROUTE_RULE, ROUTE_MESSAGE, major === undefined ? UNKNOWN_EXPRESS_REASON : undefined);
  }
}

function isCallbackTaker(callee) {
  if (ts.isIdentifier(callee)) return TIMER_FUNCTIONS.has(callee.text);
  if (!ts.isPropertyAccessExpression(callee)) return false;
  const method = callee.name.text;
  const receiver = ts.skipOuterExpressions(callee.expression);
  if (EMITTER_METHODS.has(method)) return true;
  if (!ts.isIdentifier(receiver)) return false;
  if (method === 'nextTick') return receiver.text === 'process';
  if (method === 'schedule') return CRON_RECEIVER.test(receiver.text);
  return false;
}

function checkCallback(node, context) {
  if (!isCallbackTaker(ts.skipOuterExpressions(node.expression))) return;
  for (const argument of node.arguments) {
    if (isAsyncFunctionArgument(argument) && hasUncaughtAwait(argument)) {
      context.report(argument, CALLBACK_RULE, CALLBACK_MESSAGE);
    }
  }
}

function check(node, context) {
  checkRoute(node, context);
  checkCallback(node, context);
}

module.exports = { check };
