'use strict';

const { syntax: ts } = require('./compiler.cjs');

const BCRYPTJS_PACKAGES = ['bcryptjs/', '@types/bcryptjs/'];
const ASYNC_HASH_METHODS = new Set(['hash', 'compare']);
// Tests hash with bcryptjs for speed of setup, not on a request path.
const TEST_FILE = /(?:\/(?:__tests__|e2e)\/|\.(?:test|spec|e2e|e2e-spec|itest|e2e-test)\.[cm]?[jt]sx?$)/;
const COST_METHODS = new Set(['hash', 'genSalt']);
const bcryptjsPackagePath = /[\\/]node_modules[\\/](?:@types[\\/])?bcryptjs[\\/]/;
const bcryptjsPrograms = new WeakMap();

// A call can only resolve into bcryptjs when the program loaded its declarations, so a program without them
// skips the per-call signature request (a round trip on the native engine).
function includesBcryptjs(program) {
  if (!bcryptjsPrograms.has(program)) {
    const sources = program.getSourceFileNames?.() ?? program.getSourceFiles?.().map(({ fileName }) => fileName);
    bcryptjsPrograms.set(program, sources?.some((file) => bcryptjsPackagePath.test(file)) ?? true);
  }
  return bcryptjsPrograms.get(program);
}

function calledName(callee) {
  if (ts.isPropertyAccessExpression(callee)) return callee.name;
  if (ts.isIdentifier(callee)) return callee;
}

// The exported name the call resolves to, so `import { hash as bcryptHash }` still counts as `hash`.
function exportedName(call, checker) {
  const declaration = checker.getResolvedSignature(call)?.declaration;
  return declaration?.name && ts.isIdentifier(declaration.name) ? declaration.name.text : undefined;
}

function isBcryptjsCall(call, checker) {
  if (!ASYNC_HASH_METHODS.has(exportedName(call, checker))) return false;
  const declaration = checker.getResolvedSignature(call).declaration;
  const filename = declaration.getSourceFile().fileName.replaceAll('\\', '/');
  const start = filename.lastIndexOf('/node_modules/');
  if (start < 0) return false;
  const modulePath = filename.slice(start + '/node_modules/'.length);
  return BCRYPTJS_PACKAGES.some((name) => modulePath.startsWith(name));
}

// The numeric cost when the rounds argument is a literal or a const the checker can resolve.
function costOf(call, checker) {
  const rounds = call.arguments[1];
  if (!rounds) return;
  const type = checker.getTypeAtLocation(rounds);
  return type.isNumberLiteral() ? type.value : undefined;
}

function forEachBcryptjsCall(sourceFile, checker, visitCall) {
  let stopped = false;
  (function visit(node) {
    if (stopped) return;
    if (ts.isCallExpression(node) && isBcryptjsCall(node, checker) && visitCall(node) === true) stopped = true;
    else ts.forEachChild(node, visit);
  })(sourceFile);
}

function firstCostIn(sourceFile, checker) {
  let cost;
  forEachBcryptjsCall(sourceFile, checker, (call) => {
    if (COST_METHODS.has(exportedName(call, checker))) cost = costOf(call, checker);
    return cost !== undefined;
  });
  return cost;
}

function isFirstBcryptjsCall(node, checker) {
  let first;
  forEachBcryptjsCall(node.getSourceFile(), checker, (call) => {
    first = call;
    return true;
  });
  return first === node;
}

function check(node, context) {
  if (!includesBcryptjs(context.program)) return;
  if (TEST_FILE.test(node.getSourceFile().fileName.replaceAll('\\', '/'))) return;
  if (!isBcryptjsCall(node, context.checker) || !isFirstBcryptjsCall(node, context.checker)) return;
  const name = calledName(ts.skipOuterExpressions(node.expression));
  const cost = firstCostIn(node.getSourceFile(), context.checker);
  const costText = cost === undefined ? 'a typical cost of 10-12' : `cost ${cost}`;
  context.report(
    name,
    'password-hash-pure-js',
    `\`bcryptjs\` is pure JavaScript, so every hash or compare at ${costText} burns roughly 50-400 ms of main-thread CPU (the async variant only yields between chunks), stalling every other request in the process. Use native \`bcrypt\`, \`@node-rs/bcrypt\` or \`argon2\`, which hash on the libuv threadpool. Reported once per file. Caveat: the native packages need a build or prebuilt binary at install time, and hashes stay compatible with bcryptjs.`,
  );
}

module.exports = { check };
