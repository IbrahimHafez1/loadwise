// Rewrites a blocking `xSync(...)` call into its awaited counterpart, keeping the user's receiver
// and arguments. Every builder returns undefined whenever the shape is not provably equivalent, so
// the generic example is shown.
import { isBuiltin } from 'node:module';
import { requireReview, ts, calleeCall, nameTaken } from './helpers.cjs';
import { importLinesEdit, moduleNameOf, requiredModuleName, swappedImportEdits } from './sync-imports.cjs';
import type {
  ArrowFunction,
  CallExpression,
  Expression,
  FunctionExpression,
  ImportDeclaration,
  Node,
  SourceFile,
  Statement,
  VariableStatement,
} from 'typescript';
import type { FixResult, SiteFixInput, TextEdit } from '../../shared/types.cjs';
import type { ModuleBindingStatement } from './types/module-binding.cjs';

/**
 * What a top-level import or require binds a local name to: the whole module, or one named export
 * of it.
 */
type ImportBinding =
  { moduleName: string; kind: 'namespace' } | { moduleName: string; kind: 'named'; importedName: string };

type ResolvedBinding = ImportBinding & { statement: ModuleBindingStatement };

/**
 * The user's callee: `fs.readFileSync` (with a receiver) or a named import such as `readFileSync`.
 */
interface CalleeDescription {
  receiver?: string;
  binding: ResolvedBinding;
  method: string;
}

/** An import the rewrite needs. */
interface NeededImport {
  moduleName: string;
  importedName: string;
}

/**
 * `imports` lists what the new call needs imported, `anchor` is the statement that imports the sync
 * callee, and
 * `swappedName` marks a named fs import that can be swapped.
 */
interface SyncRewrite {
  callEdits: TextEdit[];
  imports: NeededImport[];
  anchor?: ModuleBindingStatement;
  swappedName?: string;
  note?: string;
}

type RewriteCall = (call: CallExpression, sourceFile: SourceFile) => SyncRewrite | undefined;

/**
 * The number of rewritable sync calls in a file, and the one insertion that imports everything they
 * need.
 */
interface ImportPlan {
  siteCount: number;
  importEdit?: TextEdit;
}

/** A callback of `list.map(...)` that an async function runs, and the `map` call. */
interface MapCallback {
  callback: ArrowFunction | FunctionExpression;
  mapCall: CallExpression;
}

const syncSuffix = 'Sync';

// Methods whose promise form takes the same arguments and resolves to the same value as the sync
// form. Left out: existsSync (access has other semantics), fd based calls (promises use
// FileHandle), globSync (iterator).
const fsMethods = new Set([
  'accessSync',
  'appendFileSync',
  'chmodSync',
  'chownSync',
  'copyFileSync',
  'cpSync',
  'linkSync',
  'lstatSync',
  'lutimesSync',
  'mkdirSync',
  'mkdtempSync',
  'readdirSync',
  'readFileSync',
  'readlinkSync',
  'realpathSync',
  'renameSync',
  'rmdirSync',
  'rmSync',
  'statfsSync',
  'statSync',
  'symlinkSync',
  'truncateSync',
  'unlinkSync',
  'utimesSync',
  'writeFileSync',
]);
// The promise form of these has no `throwIfNoEntry` option, so any options argument may change
// behavior.
const fsMethodsWithoutOptions = new Set(['statSync', 'lstatSync', 'statfsSync']);
const compressionMethods = new Set([
  'brotliCompressSync',
  'brotliDecompressSync',
  'deflateRawSync',
  'deflateSync',
  'gunzipSync',
  'gzipSync',
  'inflateRawSync',
  'inflateSync',
  'unzipSync',
  'zstdCompressSync',
  'zstdDecompressSync',
]);
const cryptoMethods = new Set(['argon2Sync', 'generateKeyPairSync', 'pbkdf2Sync', 'scryptSync']);
const bcryptMethods = new Map([
  ['hashSync', 'hash'],
  ['compareSync', 'compare'],
  ['genSaltSync', 'genSalt'],
]);
const bcryptModules = new Set(['bcrypt', 'bcryptjs']);
const childProcessMethods = new Map([
  ['execSync', 'exec'],
  ['execFileSync', 'execFile'],
]);
// Options that behave the same for the sync and the promisified call.
const portableProcessOptions = new Set(['cwd', 'env', 'timeout']);

function bindingsOfImport(statement: ImportDeclaration, localName: string): ImportBinding | undefined {
  const moduleName = moduleNameOf(statement.moduleSpecifier);
  const clause = statement.importClause;
  if (!moduleName || !clause || clause.isTypeOnly) return;
  if (clause.name?.text === localName) return { moduleName, kind: 'namespace' };
  const { namedBindings } = clause;
  if (!namedBindings) return;
  if (ts.isNamespaceImport(namedBindings)) {
    return namedBindings.name.text === localName ? { moduleName, kind: 'namespace' } : undefined;
  }
  for (const element of namedBindings.elements) {
    if (element.name.text !== localName || element.isTypeOnly) continue;
    const importedName = (element.propertyName ?? element.name).text;
    return importedName === 'default' ? { moduleName, kind: 'namespace' } : { moduleName, kind: 'named', importedName };
  }
}

function bindingsOfRequire(statement: VariableStatement, localName: string): ImportBinding | undefined {
  if (!(statement.declarationList.flags & ts.NodeFlags.Const)) return;
  for (const declaration of statement.declarationList.declarations) {
    const moduleName = requiredModuleName(declaration.initializer);
    if (!moduleName) continue;
    if (ts.isIdentifier(declaration.name) && declaration.name.text === localName)
      return { moduleName, kind: 'namespace' };
    if (!ts.isObjectBindingPattern(declaration.name)) continue;
    for (const element of declaration.name.elements) {
      if (element.dotDotDotToken || element.initializer || !ts.isIdentifier(element.name)) continue;
      if (element.name.text !== localName) continue;
      const key = element.propertyName ?? element.name;
      if (ts.isIdentifier(key)) return { moduleName, kind: 'named', importedName: key.text };
    }
  }
}

function bindingOfStatement(statement: Statement, localName: string): ResolvedBinding | undefined {
  if (ts.isImportDeclaration(statement)) {
    const binding = bindingsOfImport(statement, localName);
    return binding && { ...binding, statement };
  }
  if (ts.isVariableStatement(statement)) {
    const binding = bindingsOfRequire(statement, localName);
    return binding && { ...binding, statement };
  }
  if (
    ts.isImportEqualsDeclaration(statement) &&
    !statement.isTypeOnly &&
    statement.name.text === localName &&
    ts.isExternalModuleReference(statement.moduleReference)
  ) {
    const moduleName = moduleNameOf(statement.moduleReference.expression);
    return moduleName ? { moduleName, kind: 'namespace', statement } : undefined;
  }
}

// What a top-level import or require binds `localName` to: the whole module, or one named export of
// it.
function resolveBinding(sourceFile: SourceFile, localName: string): ResolvedBinding | undefined {
  for (const statement of sourceFile.statements) {
    const binding = bindingOfStatement(statement, localName);
    if (binding) return binding;
  }
}

// The user's callee as `{ receiver, binding, method }`: `fs.readFileSync` or a named import such as
// `readFileSync`.
function describeCallee(call: CallExpression, sourceFile: SourceFile): CalleeDescription | undefined {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) {
    const binding = resolveBinding(sourceFile, callee.text);
    if (binding?.kind !== 'named') return;
    return { binding, method: binding.importedName };
  }
  if (!ts.isPropertyAccessExpression(callee) || callee.questionDotToken || !ts.isIdentifier(callee.expression)) return;
  const binding = resolveBinding(sourceFile, callee.expression.text);
  if (binding?.kind !== 'namespace') return;
  return { receiver: callee.expression.text, binding, method: callee.name.text };
}

// The nearest function must be async and own the call in its body; parameters, fields and sync
// callbacks cannot await.
function awaitable(call: CallExpression): boolean {
  for (let parent = call.parent, child: Node = call; parent; child = parent, parent = parent.parent) {
    if (ts.isPropertyDeclaration(parent) || ts.isClassStaticBlockDeclaration(parent) || ts.isDecorator(parent))
      return false;
    if (!ts.isFunctionLike(parent)) continue;
    const isAsync =
      ts.canHaveModifiers(parent) &&
      ts.getModifiers(parent)?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword);
    return Boolean(isAsync) && 'body' in parent && parent.body === child;
  }
  return false;
}

function candidateCall(node: Node): CallExpression | undefined {
  const call = calleeCall(node);
  return call && awaitableCall(call) ? call : undefined;
}

function awaitableCall(call: CallExpression): boolean {
  if (call.typeArguments || call.questionDotToken || !awaitable(call)) return false;
  return !(call.parent && ts.isAwaitExpression(call.parent));
}

// `await` binds looser than member access, calls and `**`, so those parents need the awaited value
// wrapped.
function needsParentheses(call: CallExpression): boolean {
  const { parent } = call;
  if (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) return parent.expression === call;
  if (ts.isCallExpression(parent) || ts.isNewExpression(parent)) return parent.expression === call;
  if (ts.isTaggedTemplateExpression(parent)) return parent.tag === call;
  if (ts.isNonNullExpression(parent)) return true;
  return (
    ts.isBinaryExpression(parent) &&
    parent.operatorToken.kind === ts.SyntaxKind.AsteriskAsteriskToken &&
    parent.left === call
  );
}

// Replaces only the callee, so the arguments keep the user's formatting.
function awaitedCallEdits(call: CallExpression, newCalleeText: string): TextEdit[] {
  const callee = call.expression;
  const wrap = needsParentheses(call);
  const edits: TextEdit[] = [
    {
      start: callee.getStart(call.getSourceFile()),
      end: callee.end,
      text: (wrap ? '(await ' : 'await ') + newCalleeText,
    },
  ];
  if (wrap) edits.push({ start: call.end, end: call.end, text: ')' });
  return edits;
}

// The import the rewrite needs as `[{ moduleName, importedName }]`: empty when the file already
// imports it, undefined when the local name is taken by something else.
function neededImports(
  sourceFile: SourceFile,
  localName: string,
  moduleName: string,
  importedName = localName,
): NeededImport[] | undefined {
  const binding = resolveBinding(sourceFile, localName);
  if (binding) {
    const sameExport =
      binding.moduleName === moduleName && binding.kind === 'named' && binding.importedName === importedName;
    return sameExport ? [] : undefined;
  }
  if (nameTaken(sourceFile, localName)) return;
  return [{ moduleName, importedName }];
}

// Notes telling the user which import the rewrite needs; undefined when the local name is already
// taken by something else.
function importNotes(
  sourceFile: SourceFile,
  localName: string,
  moduleName: string,
  importedName = localName,
): string[] | undefined {
  return neededImports(sourceFile, localName, moduleName, importedName)?.map((needed) => {
    const specifier = isBuiltin(needed.moduleName) ? `node:${needed.moduleName}` : needed.moduleName;
    return `Import \`${needed.importedName}\` from '${specifier}'.`;
  });
}

function result(edits: TextEdit[], notes: readonly string[]): FixResult {
  return { edits, ...(notes.length ? { note: notes.join(' ') } : {}) };
}

function fdLike(argument: Expression | undefined): boolean {
  if (!argument) return false;
  if (ts.isNumericLiteral(argument)) return true;
  return ts.isIdentifier(argument) && /fd$/i.test(argument.text);
}

function fsRewrite(call: CallExpression, sourceFile: SourceFile): SyncRewrite | undefined {
  const callee = describeCallee(call, sourceFile);
  if (!callee || callee.binding.moduleName !== 'fs' || !fsMethods.has(callee.method)) return;
  if (fdLike(call.arguments[0]) || call.arguments.some(ts.isSpreadElement)) return;
  if (fsMethodsWithoutOptions.has(callee.method) && call.arguments.length > 1) return;
  const promiseName = callee.method.slice(0, -syncSuffix.length);
  if (callee.receiver)
    return { callEdits: awaitedCallEdits(call, `${callee.receiver}.promises.${promiseName}`), imports: [] };
  const imports = neededImports(sourceFile, promiseName, 'fs/promises');
  if (!imports) return;
  return {
    callEdits: awaitedCallEdits(call, promiseName),
    imports,
    anchor: callee.binding.statement,
    swappedName: promiseName,
  };
}

// Every fix carries its own import edit, so it compiles when applied alone. A file with one
// rewritable call swaps the sync import for the promise one; with several, each fix adds the same
// import lines covering all of them, so fixes applied together share that one change instead of
// editing the import line in conflicting ways.
function fixWithImports(rewriteCall: RewriteCall): (input: SiteFixInput) => FixResult | undefined {
  return ({ node, sourceFile }) => {
    if (!node || !sourceFile) return;
    const call = candidateCall(node);
    if (!call) return;
    const rewrite = rewriteCall(call, sourceFile);
    if (!rewrite) return;
    const notes = rewrite.note ? [rewrite.note] : [];
    const plan = importPlan(sourceFile);
    if (rewrite.swappedName && plan.siteCount === 1 && ts.isIdentifier(call.expression)) {
      const needsImport = rewrite.imports.length > 0;
      const swapped = swappedImportEdits(sourceFile, call.expression, rewrite.swappedName, needsImport);
      if (swapped) return result([...rewrite.callEdits, ...swapped], notes);
    }
    if (!rewrite.imports.length || !plan.importEdit) return result(rewrite.callEdits, notes);
    return {
      ...result([...rewrite.callEdits, plan.importEdit], notes),
      ...(plan.siteCount > 1 && { separateEdits: true }),
    };
  };
}

const importPlans = new WeakMap<SourceFile, ImportPlan>();
function importPlan(sourceFile: SourceFile): ImportPlan {
  let plan = importPlans.get(sourceFile);
  if (!plan) {
    plan = buildImportPlan(sourceFile);
    importPlans.set(sourceFile, plan);
  }
  return plan;
}

// The number of rewritable sync calls in the file, and one insertion after the earliest statement
// importing one of their callees that imports everything their rewrites need.
function buildImportPlan(sourceFile: SourceFile): ImportPlan {
  const rewrites: SyncRewrite[] = [];
  (function visit(node: Node): void {
    if (ts.isCallExpression(node) && awaitableCall(node)) {
      const rewrite = rewriteKinds.map((rewriteCall) => rewriteCall(node, sourceFile)).find(Boolean);
      if (rewrite) rewrites.push(rewrite);
    }
    ts.forEachChild(node, visit);
  })(sourceFile);
  const importing = rewrites.filter((rewrite) => rewrite.imports.length);
  if (!importing.length) return { siteCount: rewrites.length };
  const anchor = importing.flatMap((rewrite) => rewrite.anchor ?? []).sort((left, right) => left.pos - right.pos)[0];
  const namesByModule = new Map<string, Set<string>>();
  for (const { moduleName, importedName } of importing.flatMap((rewrite) => rewrite.imports)) {
    const names = namesByModule.get(moduleName) ?? new Set<string>();
    namesByModule.set(moduleName, names);
    names.add(importedName);
  }
  return { siteCount: rewrites.length, importEdit: importLinesEdit(sourceFile, anchor, namesByModule) };
}

function promisifiedRewrite(
  call: CallExpression,
  callee: CalleeDescription,
  callbackName: string,
  moduleName: string,
  sourceFile: SourceFile,
): SyncRewrite | undefined {
  const promisifyImports = neededImports(sourceFile, 'promisify', 'util');
  if (!promisifyImports) return;
  const anchor = callee.binding.statement;
  if (callee.receiver) {
    const callEdits = awaitedCallEdits(call, `promisify(${callee.receiver}.${callbackName})`);
    return { callEdits, imports: promisifyImports, anchor };
  }
  const callbackImports = neededImports(sourceFile, callbackName, moduleName);
  if (!callbackImports) return;
  const callEdits = awaitedCallEdits(call, `promisify(${callbackName})`);
  return { callEdits, imports: [...callbackImports, ...promisifyImports], anchor };
}

function callbackFormRewrite(moduleName: string, methods: ReadonlySet<string>): RewriteCall {
  return (call: CallExpression, sourceFile: SourceFile) => {
    const callee = describeCallee(call, sourceFile);
    if (!callee || callee.binding.moduleName !== moduleName || !methods.has(callee.method)) return;
    if (call.arguments.some(ts.isSpreadElement)) return;
    const callbackName = callee.method.slice(0, -syncSuffix.length);
    return promisifiedRewrite(call, callee, callbackName, moduleName, sourceFile);
  };
}

function isPortableProcessOptions(argument: Expression): boolean {
  if (!ts.isObjectLiteralExpression(argument)) return false;
  return argument.properties.every(
    (property) =>
      (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) &&
      ts.isIdentifier(property.name) &&
      portableProcessOptions.has(property.name.text),
  );
}

// execSync returns the output while the promisified exec resolves to { stdout, stderr }, so only a
// call whose result is discarded, with options both forms treat alike, is rewritten.
function hasPortableProcessArguments(call: CallExpression, method: string): boolean {
  const args = [...call.arguments];
  if (args.some(ts.isSpreadElement) || args.length === 0) return false;
  const last = args[args.length - 1];
  if (ts.isObjectLiteralExpression(last)) return isPortableProcessOptions(last);
  if (method === 'execSync') return args.length === 1;
  return args.length === 1 || (args.length === 2 && ts.isArrayLiteralExpression(last));
}

function childProcessRewrite(call: CallExpression, sourceFile: SourceFile): SyncRewrite | undefined {
  const callee = describeCallee(call, sourceFile);
  if (!callee || callee.binding.moduleName !== 'child_process') return;
  const callbackName = childProcessMethods.get(callee.method);
  if (!callbackName || !ts.isExpressionStatement(call.parent)) return;
  if (!hasPortableProcessArguments(call, callee.method)) return;
  const promisified = promisifiedRewrite(call, callee, callbackName, 'child_process', sourceFile);
  return promisified && { ...promisified, note: 'Output is no longer forwarded to the parent stderr.' };
}

function fixBcrypt({ node, sourceFile }: SiteFixInput): FixResult | undefined {
  if (!node || !sourceFile) return;
  const call = candidateCall(node) ?? mapCallbackCall(node);
  if (!call) return;
  const callee = describeCallee(call, sourceFile);
  const promiseName = callee && bcryptMethods.get(callee.method);
  if (!callee || !promiseName || !bcryptModules.has(callee.binding.moduleName)) return;
  if (call.arguments.some(ts.isSpreadElement)) return;
  const mapEdits = awaitable(call) ? [] : asyncMapEdits(call);
  if (!mapEdits) return;
  const mapNote = mapEdits.length
    ? ['The map callback becomes async under `Promise.all`, so the hashes run in parallel and keep their order.']
    : [];
  if (callee.receiver)
    return result([...mapEdits, ...awaitedCallEdits(call, `${callee.receiver}.${promiseName}`)], mapNote);
  const notes = importNotes(sourceFile, promiseName, callee.binding.moduleName);
  if (!notes) return;
  return result([...mapEdits, ...awaitedCallEdits(call, promiseName)], [...notes, ...mapNote]);
}

// A sync call directly inside a sync `.map(...)` callback that an async function runs.
function mapCallbackCall(node: Node): CallExpression | undefined {
  const call = calleeCall(node);
  if (!call || call.typeArguments || call.questionDotToken || ts.isAwaitExpression(call.parent)) return;
  return mapCallbackOf(call) ? call : undefined;
}

function mapCallbackOf(call: CallExpression): MapCallback | undefined {
  let callback: Node = call.parent;
  while (callback && !ts.isFunctionLike(callback)) callback = callback.parent;
  if (!callback || !(ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))) return;
  // `await` is not allowed in parameter defaults.
  if (call.pos < callback.body.pos) return;
  if (callback.asteriskToken || callback.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword))
    return;
  const mapCall = callback.parent;
  if (!ts.isCallExpression(mapCall) || mapCall.arguments[0] !== callback || ts.isOptionalChain(mapCall)) return;
  if (!ts.isPropertyAccessExpression(mapCall.expression) || mapCall.expression.name.text !== 'map') return;
  if (ts.isAwaitExpression(mapCall.parent) || !awaitable(mapCall)) return;
  return { callback, mapCall };
}

// Code that runs after an await inside the callback interleaves with the other elements, so only
// side-effect free code may follow the call.
function hasEffectsAfter(callback: ArrowFunction | FunctionExpression, call: CallExpression): boolean {
  let found = false;
  (function visit(current: Node): void {
    if (found) return;
    if (current.pos >= call.end && hasEffect(current)) found = true;
    else ts.forEachChild(current, visit);
  })(callback.body);
  return found;
}

function hasEffect(node: Node): boolean {
  if (ts.isCallExpression(node) || ts.isNewExpression(node) || ts.isTaggedTemplateExpression(node)) return true;
  if (ts.isAwaitExpression(node) || ts.isYieldExpression(node) || ts.isDeleteExpression(node)) return true;
  if (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) {
    return node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken;
  }
  if (!ts.isBinaryExpression(node)) return false;
  const operator = node.operatorToken.kind;
  return operator >= ts.SyntaxKind.FirstAssignment && operator <= ts.SyntaxKind.LastAssignment;
}

// `list.map((item) => ...)` becomes `await Promise.all(list.map(async (item) => ...))`.
function asyncMapEdits(call: CallExpression): TextEdit[] | undefined {
  const found = mapCallbackOf(call);
  if (!found || hasEffectsAfter(found.callback, call)) return;
  const { callback, mapCall } = found;
  const sourceFile = call.getSourceFile();
  const wrap = needsParentheses(mapCall);
  const mapStart = mapCall.getStart(sourceFile);
  const callbackStart = callback.getStart(sourceFile);
  return [
    { start: mapStart, end: mapStart, text: (wrap ? '(' : '') + 'await Promise.all(' },
    { start: callbackStart, end: callbackStart, text: 'async ' },
    { start: mapCall.end, end: mapCall.end, text: wrap ? '))' : ')' },
  ];
}

const compressionRewrite = callbackFormRewrite('zlib', compressionMethods);
const cryptoRewrite = callbackFormRewrite('crypto', cryptoMethods);
// Text asyncMapEdits inserts to run a map callback's calls concurrently.
const concurrentMapMarker = 'await Promise.all(';
// The rewrites whose imports one file-wide plan covers.
const rewriteKinds: readonly RewriteCall[] = [fsRewrite, compressionRewrite, cryptoRewrite, childProcessRewrite];

export default {
  'node-sync-fs-in-async': requireReview(
    'File operations in a map callback now run concurrently, so their order and error timing change.',
    fixWithImports(fsRewrite),
    (fix: FixResult) => fix.edits?.some(({ text }) => text.includes(concurrentMapMarker)) ?? false,
  ),
  'node-sync-compression-in-async': fixWithImports(compressionRewrite),
  'node-sync-crypto-in-async': fixWithImports(cryptoRewrite),
  'node-sync-process-in-async': requireReview(
    'The child process no longer shares the parent stdio and its failure surfaces as a rejection.',
    fixWithImports(childProcessRewrite),
  ),
  'password-hash-sync-in-async': fixBcrypt,
};
