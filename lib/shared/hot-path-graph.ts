// Finds the hot-path rank of a finding from its path and the call graph around it. Loaded on first use because it
// binds the compiler syntax, which the CLI must select before anything touches it.
import { ts } from '../performance/compiler.js';
import { isRequestHandler } from '../performance/request-handlers.js';
import { isTestSource, isSeedSource } from '../performance/review-context.js';
import type {
  CallExpression,
  ClassDeclaration,
  Decorator,
  FunctionDeclaration,
  MemberName,
  MethodDeclaration,
  ModifierLike,
  NewExpression,
  Node,
  SignatureDeclaration,
  SourceFile,
  VariableDeclaration,
} from 'typescript';
import type { CheckerAdapter, HotPath, ProgramAdapter } from './types.js';

type NamedFunctionDeclaration = FunctionDeclaration | MethodDeclaration | VariableDeclaration;

const MAX_CALL_HOPS = 3;
// A name defined in many files (`get`, `save`) cannot be traced cheaply or reliably, so it stays
// unknown.
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

const pathRanks = new WeakMap<SourceFile, HotPath | null>();
const nodeRanks = new WeakMap<Node, HotPath>();
const callSitesByFile = new WeakMap<SourceFile, Map<string, CallExpression[]>>();
const callerIndexes = new WeakMap<ProgramAdapter, Map<string, SourceFile[]>>();

function result(rank: string, reason: string): HotPath {
  return { rank, reason };
}

function pathRank(sourceFile: SourceFile): HotPath | null {
  if (!pathRanks.has(sourceFile)) {
    const file = sourceFile.fileName;
    let rank: HotPath | undefined;
    if (isTestSource(file)) rank = result('test', 'test source');
    else if (isSeedSource(file) || SCRIPT_PATH.test(file)) rank = result('script', 'script, seed or migration source');
    else if (BACKGROUND_PATH.test(file)) rank = result('background', 'job, worker or queue source');
    pathRanks.set(sourceFile, rank ?? null);
  }
  return pathRanks.get(sourceFile) ?? null;
}

function decoratorNames(node: MethodDeclaration | ClassDeclaration): string[] {
  const modifiers: readonly ModifierLike[] = node.modifiers ?? [];
  return modifiers
    .filter((modifier): modifier is Decorator => ts.isDecorator(modifier))
    .map(({ expression }) => (ts.isCallExpression(expression) ? expression.expression : expression))
    .filter(ts.isIdentifier)
    .map(({ text }) => text);
}

function calleeNames(call: CallExpression) {
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

function registersBackgroundWork(call: CallExpression | NewExpression): boolean {
  if (ts.isNewExpression(call)) {
    return ts.isIdentifier(call.expression) && BACKGROUND_CONSTRUCTORS.has(call.expression.text);
  }
  if (!ts.isCallExpression(call)) return false;
  const { method, receiver } = calleeNames(call);
  return BACKGROUND_REGISTRATIONS.some(
    (registration) => registration.method.test(method ?? '') && registration.receiver.test(receiver ?? ''),
  );
}

function isBackgroundEntry(node: Node): boolean {
  if (ts.isMethodDeclaration(node) || ts.isClassDeclaration(node)) {
    return decoratorNames(node).some((name) => BACKGROUND_DECORATORS.has(name));
  }
  if (!ts.isFunctionExpression(node) && !ts.isArrowFunction(node)) return false;
  return (ts.isCallExpression(node.parent) || ts.isNewExpression(node.parent)) && registersBackgroundWork(node.parent);
}

function declarationOf(functionNode: Node): NamedFunctionDeclaration | undefined {
  if (ts.isFunctionDeclaration(functionNode) || ts.isMethodDeclaration(functionNode)) {
    return functionNode.name ? functionNode : undefined;
  }
  const variable = functionNode.parent;
  return variable && ts.isVariableDeclaration(variable) && ts.isIdentifier(variable.name) ? variable : undefined;
}

// What the code around `node` directly is: a request handler or a background entry, innermost
// ancestor first.
function directRank(node: Node): HotPath | undefined {
  let background: HotPath | undefined;
  for (let current = node.parent; current; current = current.parent) {
    if (isRequestHandler(current)) return result('request', 'inside a request handler');
    if (!background && isBackgroundEntry(current)) background = result('background', 'scheduled or queue job');
  }
  return background;
}

function nearestNamedFunction(node: Node): SignatureDeclaration | undefined {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isFunctionLike(current) && declarationOf(current)) return current;
  }
}

function projectSources(program: ProgramAdapter): readonly SourceFile[] {
  const sources = program.getToolingSourceFiles?.() ?? program.getSourceFiles?.() ?? [];
  return sources.filter(
    (source) =>
      !source.isDeclarationFile && !/[\\/]node_modules[\\/]/i.test(source.fileName) && !isTestSource(source.fileName),
  );
}

// Files whose text calls a name; one regex pass over the project, built the first time a finding
// needs it.
function callerIndex(program: ProgramAdapter): Map<string, SourceFile[]> {
  const cached = callerIndexes.get(program);
  if (cached) return cached;
  const filesByName = new Map<string, SourceFile[]>();
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

function calleeNameNode(call: CallExpression): MemberName | undefined {
  const callee = ts.skipOuterExpressions(call.expression);
  if (ts.isIdentifier(callee)) return callee;
  return ts.isPropertyAccessExpression(callee) ? callee.name : undefined;
}

// Every call in the file keyed by callee name, so a file is walked once however many names ask
// about it.
function callSites(sourceFile: SourceFile): Map<string, CallExpression[]> {
  const cached = callSitesByFile.get(sourceFile);
  if (cached) return cached;
  const byName = new Map<string, CallExpression[]>();
  (function visit(node: Node): void {
    if (ts.isCallExpression(node)) {
      const name = calleeNameNode(node)?.text;
      const sites = name ? byName.get(name) : undefined;
      if (name && sites) sites.push(node);
      else if (name) byName.set(name, [node]);
    }
    ts.forEachChild(node, visit);
  })(sourceFile);
  callSitesByFile.set(sourceFile, byName);
  return byName;
}

function callsDeclaration(
  call: CallExpression,
  declaration: NamedFunctionDeclaration,
  checker: CheckerAdapter,
): boolean {
  const nameNode = calleeNameNode(call);
  if (!nameNode) return false;
  let symbol = checker.getSymbolAtLocation(nameNode);
  if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
  return Boolean(symbol?.declarations?.includes(declaration));
}

function callersOf(functionNode: SignatureDeclaration, program: ProgramAdapter): CallExpression[] {
  const declaration = declarationOf(functionNode);
  if (!declaration) return [];
  const nameNode = declaration.name;
  const name = nameNode && 'text' in nameNode ? nameNode.text : undefined;
  const files = name === undefined ? undefined : callerIndex(program).get(name);
  if (!files || files.length > MAX_CALLER_FILES) return [];
  const checker = program.getTypeChecker();
  const calls = files.flatMap((source: SourceFile) => callSites(source).get(name ?? '') ?? []);
  return calls.slice(0, MAX_CALL_SITES).filter((call: CallExpression) => callsDeclaration(call, declaration, checker));
}

// Request when a project function is called, within a few hops, from a request handler; otherwise
// background when a job calls it. Callers are found through the type checker, so imports, aliases
// and injected services resolve.
function reachableRank(
  functionNode: SignatureDeclaration,
  program: ProgramAdapter,
  hops: number,
  visited: Set<Node>,
): HotPath | undefined {
  if (visited.has(functionNode)) return;
  visited.add(functionNode);
  let best: HotPath | undefined;
  for (const call of callersOf(functionNode, program)) {
    const direct = directRank(call);
    const caller = direct ? undefined : nearestNamedFunction(call);
    const found: HotPath | undefined =
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

function classify(node: Node, program: ProgramAdapter): HotPath {
  const sourceFile = node.getSourceFile();
  const byPath = pathRank(sourceFile);
  if (byPath && byPath.rank !== 'background') return byPath;
  const direct = directRank(node);
  if (direct) return direct;
  if (byPath) return byPath;
  const owner = nearestNamedFunction(node);
  if (!owner) return result('unknown', 'no request or job entry found');
  const known = nodeRanks.get(owner);
  if (known) return known;
  const ranked =
    reachableRank(owner, program, 1, new Set<Node>()) ?? result('unknown', 'no request or job entry found');
  nodeRanks.set(owner, ranked);
  return ranked;
}

// Never throws: an unresolvable program or node means "unknown", not a failed scan.
function hotPathOf(node: Node, program: ProgramAdapter): HotPath {
  try {
    return classify(node, program);
  } catch {
    return result('unknown', 'call graph unavailable');
  }
}

export { hotPathOf };
