'use strict';

// Finds the hot-path rank of a finding from its path and the call graph around it. Loaded on first use because it
// binds the compiler syntax, which the CLI must select before anything touches it.
const { syntax: ts } = require('../performance/compiler.cjs');
const { isRequestHandler } = require('../performance/request-handlers.cjs');
const { isTestSource, isSeedSource } = require('../performance/review-context.cjs');

const MAX_CALL_HOPS = 3;
// A name defined in many files (`get`, `save`) cannot be traced cheaply or reliably, so it stays unknown.
const MAX_CALLER_FILES = 25;
const MAX_CALL_SITES = 20;

const SCRIPT_PATH = /[\\/](?:scripts?|seeds?|seeders?|migrations?|migrate|commands|bin)[\\/]/i;
const BACKGROUND_PATH =
  /[\\/](?:cron|jobs?|workers?|queues?|processors?|consumers?|schedulers?)[\\/]|[.-](?:cron|job|worker|processor|consumer|scheduler)\.[cm]?[jt]sx?$/i;
const BACKGROUND_DECORATORS = new Set([
  'Cron',
  'Interval',
  'Timeout',
  'OnEvent',
  'Process',
  'Processor',
  'EventPattern',
  'MessagePattern',
  'SqsMessageHandler',
  'RabbitSubscribe',
]);
// Registering a callback with one of these makes it run on a schedule or per queued job.
const BACKGROUND_REGISTRATIONS = [
  { method: /^(?:schedule|scheduleJob)$/, receiver: /cron|schedule/i },
  { method: /^define$/, receiver: /agenda/i },
  { method: /^process$/, receiver: /queue/i },
  { method: /^consume$/, receiver: /channel/i },
];
const BACKGROUND_CONSTRUCTORS = new Set(['Worker', 'CronJob']);
const CALL_NAME = /([A-Za-z_$][\w$]*)(?=\s*[(<])/g;

const pathRanks = new WeakMap();
const nodeRanks = new WeakMap();
const callSitesByFile = new WeakMap();
const callerIndexes = new WeakMap();

function result(rank, reason) {
  return { rank, reason };
}

function pathRank(sourceFile) {
  if (!pathRanks.has(sourceFile)) {
    const file = sourceFile.fileName;
    let rank;
    if (isTestSource(file)) rank = result('test', 'test source');
    else if (isSeedSource(file) || SCRIPT_PATH.test(file)) rank = result('script', 'script, seed or migration source');
    else if (BACKGROUND_PATH.test(file)) rank = result('background', 'job, worker or queue source');
    pathRanks.set(sourceFile, rank ?? null);
  }
  return pathRanks.get(sourceFile);
}

function decoratorNames(node) {
  return (node.modifiers ?? [])
    .filter((modifier) => ts.isDecorator(modifier))
    .map(({ expression }) => (ts.isCallExpression(expression) ? expression.expression : expression))
    .filter(ts.isIdentifier)
    .map(({ text }) => text);
}

function calleeNames(call) {
  const callee = ts.skipOuterExpressions(call.expression);
  if (ts.isIdentifier(callee)) return { method: callee.text };
  if (!ts.isPropertyAccessExpression(callee)) return {};
  const receiver = ts.skipOuterExpressions(callee.expression);
  const receiverText = ts.isIdentifier(receiver)
    ? receiver.text
    : ts.isPropertyAccessExpression(receiver)
      ? receiver.name.text
      : '';
  return { method: callee.name.text, receiver: receiverText };
}

function registersBackgroundWork(call) {
  if (ts.isNewExpression(call)) {
    return ts.isIdentifier(call.expression) && BACKGROUND_CONSTRUCTORS.has(call.expression.text);
  }
  if (!ts.isCallExpression(call)) return false;
  const { method, receiver } = calleeNames(call);
  return BACKGROUND_REGISTRATIONS.some(
    (registration) => registration.method.test(method ?? '') && registration.receiver.test(receiver ?? ''),
  );
}

function isBackgroundEntry(node) {
  if (ts.isMethodDeclaration(node) || ts.isClassDeclaration(node)) {
    return decoratorNames(node).some((name) => BACKGROUND_DECORATORS.has(name));
  }
  if (!ts.isFunctionExpression(node) && !ts.isArrowFunction(node)) return false;
  return (ts.isCallExpression(node.parent) || ts.isNewExpression(node.parent)) && registersBackgroundWork(node.parent);
}

function declarationOf(functionNode) {
  if (ts.isFunctionDeclaration(functionNode) || ts.isMethodDeclaration(functionNode)) {
    return functionNode.name ? functionNode : undefined;
  }
  const variable = functionNode.parent;
  return variable && ts.isVariableDeclaration(variable) && ts.isIdentifier(variable.name) ? variable : undefined;
}

// What the code around `node` directly is: a request handler or a background entry, innermost ancestor first.
function directRank(node) {
  let background;
  for (let current = node.parent; current; current = current.parent) {
    if (isRequestHandler(current)) return result('request', 'inside a request handler');
    if (!background && isBackgroundEntry(current)) background = result('background', 'scheduled or queue job');
  }
  return background;
}

function nearestNamedFunction(node) {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isFunctionLike(current) && declarationOf(current)) return current;
  }
}

function projectSources(program) {
  const sources = program.getToolingSourceFiles?.() ?? program.getSourceFiles();
  return sources.filter(
    (source) =>
      !source.isDeclarationFile && !/[\\/]node_modules[\\/]/i.test(source.fileName) && !isTestSource(source.fileName),
  );
}

// Files whose text calls a name; one regex pass over the project, built the first time a finding needs it.
function callerIndex(program) {
  if (callerIndexes.has(program)) return callerIndexes.get(program);
  const filesByName = new Map();
  for (const source of projectSources(program)) {
    for (const name of new Set(source.text.match(CALL_NAME))) {
      const files = filesByName.get(name);
      if (files) files.push(source);
      else filesByName.set(name, [source]);
    }
  }
  callerIndexes.set(program, filesByName);
  return filesByName;
}

function calleeNameNode(call) {
  const callee = ts.skipOuterExpressions(call.expression);
  if (ts.isIdentifier(callee)) return callee;
  return ts.isPropertyAccessExpression(callee) ? callee.name : undefined;
}

// Every call in the file keyed by callee name, so a file is walked once however many names ask about it.
function callSites(sourceFile) {
  if (!callSitesByFile.has(sourceFile)) {
    const byName = new Map();
    (function visit(node) {
      if (ts.isCallExpression(node)) {
        const name = calleeNameNode(node)?.text;
        if (name) byName.set(name, [...(byName.get(name) ?? []), node]);
      }
      ts.forEachChild(node, visit);
    })(sourceFile);
    callSitesByFile.set(sourceFile, byName);
  }
  return callSitesByFile.get(sourceFile);
}

function callsDeclaration(call, declaration, checker) {
  let symbol = checker.getSymbolAtLocation(calleeNameNode(call));
  if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
  return Boolean(symbol?.declarations?.includes(declaration));
}

function callersOf(functionNode, program) {
  const declaration = declarationOf(functionNode);
  const name = declaration.name.text;
  const files = callerIndex(program).get(name);
  if (!files || files.length > MAX_CALLER_FILES) return [];
  const checker = program.getTypeChecker();
  const calls = files.flatMap((source) => callSites(source).get(name) ?? []);
  return calls.slice(0, MAX_CALL_SITES).filter((call) => callsDeclaration(call, declaration, checker));
}

// Request when a project function is called, within a few hops, from a request handler; otherwise background when
// a job calls it. Callers are found through the type checker, so imports, aliases and injected services resolve.
function reachableRank(functionNode, program, hops, visited) {
  if (visited.has(functionNode)) return;
  visited.add(functionNode);
  let best;
  for (const call of callersOf(functionNode, program)) {
    const direct = directRank(call);
    const caller = direct ? undefined : nearestNamedFunction(call);
    const found =
      direct ?? (caller && hops < MAX_CALL_HOPS ? reachableRank(caller, program, hops + 1, visited) : undefined);
    if (found?.rank === 'request') {
      return result(
        'request',
        hops === 1 ? 'called from a request handler' : `reachable from a request handler in ${hops} calls`,
      );
    }
    best ??= found && result('background', 'called from a background job');
  }
  return best;
}

function classify(node, program) {
  const sourceFile = node.getSourceFile();
  const byPath = pathRank(sourceFile);
  if (byPath && byPath.rank !== 'background') return byPath;
  const direct = directRank(node);
  if (direct) return direct;
  if (byPath) return byPath;
  const owner = nearestNamedFunction(node);
  if (!owner) return result('unknown', 'no request or job entry found');
  if (!nodeRanks.has(owner)) {
    nodeRanks.set(
      owner,
      reachableRank(owner, program, 1, new Set()) ?? result('unknown', 'no request or job entry found'),
    );
  }
  return nodeRanks.get(owner);
}

// Never throws: an unresolvable program or node means "unknown", not a failed scan.
function hotPathOf(node, program) {
  try {
    return classify(node, program);
  } catch {
    return result('unknown', 'call graph unavailable');
  }
}

module.exports = { hotPathOf };
