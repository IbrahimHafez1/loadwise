// Resources that must be given back on every path: file handles, TypeORM query runners, browsers and
// intervals. Each rule only fires for a resource held in a local (or a field, for intervals), so a
// resource that is returned, stored or passed on is never reported: its new owner decides when it ends.
import { ts } from '../performance/compiler.js';
import { walkNodes } from './walk.js';
import { isIgnoredSource } from './source-helpers.js';
import type {
  BindingElement,
  CallExpression,
  Expression,
  Identifier,
  ImportClause,
  ImportEqualsDeclaration,
  ImportSpecifier,
  NamespaceImport,
  Node,
  SourceFile,
  SyntaxKind,
  VariableDeclaration,
  VariableStatement,
} from 'typescript';
import type { CheckerAdapter, Finding } from '../shared/types.js';

type AcquisitionRule = 'file-handle-not-closed' | 'query-runner-not-released' | 'browser-not-closed';
type ReferenceKind = 'release-in-finally' | 'release-in-catch' | 'release-elsewhere' | 'use' | 'handoff';
type LeakState = 'never-released' | 'released-outside-finally';

const typeormPackage = /[\\/]node_modules[\\/]typeorm[\\/]/;

// A resource the code acquires and must give back, with the words the finding uses for it.
interface Acquisition {
  ruleId: AcquisitionRule;
  declaration: VariableDeclaration;
  releaseMethods: ReadonlySet<string>;
  // Calls that give the resource to something that closes it later, such as a stream over a file.
  handoffMethods: ReadonlySet<string>;
  what: string;
  consequence: string;
  remedy: string;
}

interface ModuleMember {
  moduleName: string;
  members: string[];
}

const noMethods: ReadonlySet<string> = new Set();
const fileHandleMessage = {
  what: 'a file handle',
  consequence: 'its file descriptor stays open',
  remedy: 'Close it in a finally block, or declare it with `await using`.',
};
const queryRunnerMessage = {
  what: 'a TypeORM query runner',
  consequence: 'its database connection is never returned to the pool',
  remedy: 'Release it in a finally block.',
};
const browserMessage = {
  what: 'a launched browser',
  consequence: 'its browser process keeps running',
  remedy: 'Close it in a finally block.',
};

const playwrightModules = new Set(['playwright', 'playwright-core']);
const puppeteerModules = new Set(['puppeteer', 'puppeteer-core']);
const playwrightEngines = new Set(['chromium', 'firefox', 'webkit']);
const playwrightLaunchers = new Set(['launch', 'launchPersistentContext']);
const frontendFramework = /^(?:react|preact|vue|@vue\/.+|svelte|solid-js|@angular\/core)$/;
const frontendLifecycleCallbacks = new Set([
  'useEffect',
  'useLayoutEffect',
  'useInsertionEffect',
  'onMounted',
  'onBeforeMount',
  'onUpdated',
  'onActivated',
  'watch',
  'watchEffect',
  'watchPostEffect',
]);
const frontendLifecycleMethods = new Set([
  'setup',
  'mounted',
  'created',
  'beforeMount',
  'componentDidMount',
  'componentDidUpdate',
  'ngOnInit',
  'ngOnChanges',
  'ngAfterViewInit',
  'ngAfterContentInit',
]);
const startupFunctionNames = new Set(['main', 'bootstrap']);
// A background timer started here is the singleton timer of the service, not one per call.
const singletonInitializerNames = new Set([
  'onModuleInit',
  'onApplicationBootstrap',
  'init',
  'initialize',
  'start',
  'setup',
  'register',
  'listen',
]);
// A callback of these runs once when the program starts, like top-level code.
const startupCallbackOwners = new Set(['listen', 'once', 'then', 'whenReady', 'ready']);
const reactHookName = /^use[A-Z]/;
const comparisonOperators: ReadonlySet<SyntaxKind> = new Set([
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
]);
// The only calls an acquisition rule starts from (`fs.open`, `launch`, `connect`, `createQueryRunner`), so a file
// without these words has nothing to check.
const acquisitionWords = /open|launch|connect|createQueryRunner/;

function withoutNodePrefix(moduleName: string): string {
  return moduleName.startsWith('node:') ? moduleName.slice('node:'.length) : moduleName;
}

function requiredModule(node: Expression | undefined): string | undefined {
  if (!node || !ts.isCallExpression(node)) return;
  const [argument] = node.arguments;
  if (!ts.isIdentifier(node.expression) || node.expression.text !== 'require' || node.arguments.length !== 1) return;
  return ts.isStringLiteralLike(argument) ? argument.text : undefined;
}

function importSpecifierOrigin(declaration: ImportSpecifier): ModuleMember | undefined {
  if (declaration.isTypeOnly) return;
  const member = (declaration.propertyName ?? declaration.name).text;
  const moduleSpecifier = declaration.parent.parent.parent.moduleSpecifier;
  if (!ts.isStringLiteralLike(moduleSpecifier)) return;
  return { moduleName: moduleSpecifier.text, members: member === 'default' ? [] : [member] };
}

function importClauseOrigin(declaration: ImportClause | NamespaceImport): ModuleMember | undefined {
  const importDeclaration = ts.isImportClause(declaration) ? declaration.parent : declaration.parent.parent;
  if (!ts.isStringLiteralLike(importDeclaration.moduleSpecifier)) return;
  return { moduleName: importDeclaration.moduleSpecifier.text, members: [] };
}

function importEqualsOrigin(declaration: ImportEqualsDeclaration): ModuleMember | undefined {
  if (!ts.isExternalModuleReference(declaration.moduleReference)) return;
  const reference = declaration.moduleReference.expression;
  return ts.isStringLiteralLike(reference) ? { moduleName: reference.text, members: [] } : undefined;
}

function requiredModuleOrigin(declaration: VariableDeclaration): ModuleMember | undefined {
  const moduleName = requiredModule(declaration.initializer);
  return moduleName === undefined ? undefined : { moduleName, members: [] };
}

function destructuredRequireOrigin(declaration: BindingElement): ModuleMember | undefined {
  const moduleName = requiredModule(declaration.parent.parent.initializer);
  if (moduleName === undefined || !ts.isObjectBindingPattern(declaration.parent)) return;
  const member = declaration.propertyName ?? declaration.name;
  return ts.isIdentifier(member) ? { moduleName, members: [member.text] } : undefined;
}

// Where a local name came from: the module and the member path below it. `import { promises as p }
// from 'fs'` gives `fs` and ['promises']; a default or namespace import gives an empty path.
function importOrigin(declaration: Node): ModuleMember | undefined {
  if (ts.isImportSpecifier(declaration)) return importSpecifierOrigin(declaration);
  if (ts.isImportClause(declaration) || ts.isNamespaceImport(declaration)) return importClauseOrigin(declaration);
  if (ts.isImportEqualsDeclaration(declaration)) return importEqualsOrigin(declaration);
  if (ts.isVariableDeclaration(declaration)) return requiredModuleOrigin(declaration);
  if (ts.isBindingElement(declaration) && ts.isIdentifier(declaration.name))
    return destructuredRequireOrigin(declaration);
}

// `fs.promises.open` resolves to `fs` + ['promises', 'open'] however the module was imported.
function importedReference(expression: Expression, checker: CheckerAdapter): ModuleMember | undefined {
  const members: string[] = [];
  let current = ts.skipOuterExpressions(expression);
  while (ts.isPropertyAccessExpression(current)) {
    members.unshift(current.name.text);
    current = ts.skipOuterExpressions(current.expression);
  }
  if (!ts.isIdentifier(current)) return;
  for (const declaration of checker.getSymbolAtLocation(current)?.declarations ?? []) {
    const origin = importOrigin(declaration);
    if (origin) return { moduleName: withoutNodePrefix(origin.moduleName), members: [...origin.members, ...members] };
  }
}

function sameMembers(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && actual.every((member, index) => member === expected[index]);
}

function opensFileHandle(reference: ModuleMember): boolean {
  return (
    (reference.moduleName === 'fs/promises' && sameMembers(reference.members, ['open'])) ||
    (reference.moduleName === 'fs' && sameMembers(reference.members, ['promises', 'open']))
  );
}

// The close methods that end a launched browser, or undefined when the call is no browser launch.
function browserReleaseMethods(reference: ModuleMember): ReadonlySet<string> | undefined {
  const { moduleName, members } = reference;
  if (playwrightModules.has(moduleName) && members.length === 2) {
    const [engine, launcher] = members;
    return playwrightEngines.has(engine) && playwrightLaunchers.has(launcher) ? new Set(['close']) : undefined;
  }
  if (!puppeteerModules.has(moduleName) || members.length !== 1) return;
  if (members[0] === 'launch') return new Set(['close']);
  // A connected browser keeps running for its owner, so ending the connection is enough.
  return members[0] === 'connect' ? new Set(['disconnect', 'close']) : undefined;
}

function createsTypeormQueryRunner(call: CallExpression, checker: CheckerAdapter): boolean {
  const callee = ts.skipOuterExpressions(call.expression);
  if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== 'createQueryRunner') return false;
  const declaration = checker.getResolvedSignature(call)?.declaration;
  return declaration !== undefined && typeormPackage.test(declaration.getSourceFile().fileName);
}

function importsModule(sourceFile: SourceFile, matches: (moduleName: string) => boolean): boolean {
  return sourceFile.statements.some(
    (statement) =>
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteralLike(statement.moduleSpecifier) &&
      matches(statement.moduleSpecifier.text),
  );
}

function acquisitionOf(
  declaration: VariableDeclaration,
  checker: CheckerAdapter,
  isPlaywrightTestFile: boolean,
): Acquisition | undefined {
  if (!declaration.initializer) return;
  const initializer = ts.skipOuterExpressions(declaration.initializer);
  if (ts.isAwaitExpression(initializer)) {
    const call = ts.skipOuterExpressions(initializer.expression);
    if (!ts.isCallExpression(call)) return;
    const reference = importedReference(call.expression, checker);
    if (!reference) return;
    if (opensFileHandle(reference))
      return {
        ruleId: 'file-handle-not-closed',
        declaration,
        releaseMethods: new Set(['close']),
        handoffMethods: new Set(['createReadStream', 'createWriteStream', 'readableWebStream']),
        ...fileHandleMessage,
      };
    const releaseMethods = isPlaywrightTestFile ? undefined : browserReleaseMethods(reference);
    if (releaseMethods)
      return {
        ruleId: 'browser-not-closed',
        declaration,
        releaseMethods,
        handoffMethods: noMethods,
        ...browserMessage,
      };
    return;
  }
  if (ts.isCallExpression(initializer) && createsTypeormQueryRunner(initializer, checker))
    return {
      ruleId: 'query-runner-not-released',
      declaration,
      releaseMethods: new Set(['release']),
      handoffMethods: noMethods,
      ...queryRunnerMessage,
    };
}

function isUsingDeclaration(declaration: VariableDeclaration): boolean {
  const flags = declaration.parent.flags;
  return (flags & ts.NodeFlags.Using) === ts.NodeFlags.Using;
}

function declaringStatement(declaration: VariableDeclaration): VariableStatement | undefined {
  const statement = declaration.parent.parent;
  return ts.isVariableStatement(statement) && statement.declarationList.declarations.length === 1
    ? statement
    : undefined;
}

// Every use of the declared local, including from closures and methods written above it. A shorthand `{ browser }` names the local
// through its value symbol.
function referencesTo(declaration: VariableDeclaration, container: Node, checker: CheckerAdapter): Identifier[] {
  if (!ts.isIdentifier(declaration.name)) return [];
  const name = declaration.name.text;
  const references: Identifier[] = [];
  walkNodes(container, (node: Node) => {
    if (!ts.isIdentifier(node) || node.text !== name || node === declaration.name) return;
    const symbol = ts.isShorthandPropertyAssignment(node.parent)
      ? checker.getShorthandAssignmentValueSymbol(node.parent)
      : checker.getSymbolAtLocation(node);
    if (symbol?.valueDeclaration === declaration) references.push(node);
  });
  return references;
}

// The reference with the wrappers that do not change what it is, such as `browser!` or `(browser)`.
function outermostWrapper(node: Node): Node {
  let current = node;
  while (
    ts.isParenthesizedExpression(current.parent) ||
    ts.isNonNullExpression(current.parent) ||
    ts.isAsExpression(current.parent) ||
    ts.isSatisfiesExpression(current.parent)
  )
    current = current.parent;
  return current;
}

// `if (handle)`, `!handle` and `handle === undefined` look at the value without passing it on.
function inspectsOnly(node: Node): boolean {
  const parent = node.parent;
  if (ts.isIfStatement(parent)) return parent.expression === node;
  if (ts.isConditionalExpression(parent)) return parent.condition === node;
  if (ts.isPrefixUnaryExpression(parent)) return parent.operator === ts.SyntaxKind.ExclamationToken;
  if (ts.isTypeOfExpression(parent)) return true;
  return ts.isBinaryExpression(parent) && comparisonOperators.has(parent.operatorToken.kind);
}

// A release counts when it sits in the finally block of a try inside the declaring block. One inside
// a nested function runs whenever that function does, so ownership has moved there.
function releasePlacement(release: Node, container: Node): 'finally' | 'catch' | 'function' | 'plain' {
  for (
    let child = release, parent = release.parent;
    parent && parent !== container;
    child = parent, parent = parent.parent
  ) {
    if (ts.isFunctionLike(parent)) return 'function';
    if (ts.isTryStatement(parent) && parent.finallyBlock === child) return 'finally';
    if (ts.isCatchClause(parent)) return 'catch';
  }
  return 'plain';
}

// A function that uses the resource may run any time later, so it owns the resource from then on.
function insideNestedFunction(node: Node, container: Node): boolean {
  for (let current = node.parent; current && current !== container; current = current.parent)
    if (ts.isFunctionLike(current)) return true;
  return false;
}

const releaseKindByPlacement = {
  finally: 'release-in-finally',
  catch: 'release-in-catch',
  plain: 'release-elsewhere',
} as const;

function referenceKind(
  reference: Identifier,
  container: Node,
  releaseMethods: ReadonlySet<string>,
  handoffMethods: ReadonlySet<string>,
): ReferenceKind {
  if (insideNestedFunction(reference, container)) return 'handoff';
  const node = outermostWrapper(reference);
  const access = node.parent;
  if (ts.isElementAccessExpression(access) && access.expression === node) return 'use';
  if (!ts.isPropertyAccessExpression(access) || access.expression !== node)
    return inspectsOnly(node) ? 'use' : 'handoff';
  const method = access.name.text;
  if (handoffMethods.has(method)) return 'handoff';
  if (!releaseMethods.has(method)) return 'use';
  const call = access.parent;
  if (!ts.isCallExpression(call) || call.expression !== access) return 'handoff';
  const placement = releasePlacement(call, container);
  return placement === 'function' ? 'handoff' : releaseKindByPlacement[placement];
}

// undefined means the resource is released safely, or its ownership moved on.
function leakState(acquisition: Acquisition, checker: CheckerAdapter): LeakState | undefined {
  const { declaration, releaseMethods, handoffMethods } = acquisition;
  const statement = declaringStatement(declaration);
  if (!statement || isUsingDeclaration(declaration)) return;
  // A module-level resource is a singleton that lives as long as the process.
  if (ts.isSourceFile(statement.parent)) return;
  const kinds = referencesTo(declaration, statement.parent, checker).map((reference) =>
    referenceKind(reference, statement.parent, releaseMethods, handoffMethods),
  );
  if (kinds.includes('handoff') || kinds.includes('release-in-finally')) return;
  const releasedInCatch = kinds.includes('release-in-catch');
  // Closed on the success path and in a catch: every path gives it back.
  if (releasedInCatch && kinds.includes('release-elsewhere')) return;
  if (!releasedInCatch && !kinds.includes('release-elsewhere')) return 'never-released';
  // Acquired and released with nothing done in between leaves no step that could fail.
  return kinds.includes('use') ? 'released-outside-finally' : undefined;
}

function acquisitionMessage(acquisition: Acquisition, state: LeakState): string {
  const { declaration, what, consequence, remedy, releaseMethods } = acquisition;
  const name = ts.isIdentifier(declaration.name) ? declaration.name.text : 'resource';
  const [release] = releaseMethods;
  if (state === 'never-released')
    return `\`${name}\` is ${what} and \`${name}.${release}()\` is never called, so ${consequence}. ${remedy}`;
  return `\`${name}.${release}()\` is not in a finally block, so an error before it leaves ${what} unreleased and ${consequence}. ${remedy}`;
}

function findingAt(sourceFile: SourceFile, file: string, node: Node, ruleId: string, message: string): Finding {
  const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return { file, line: position.line + 1, column: position.character + 1, ruleId, message };
}

function calleeName(call: CallExpression): string | undefined {
  const callee = ts.skipOuterExpressions(call.expression);
  if (ts.isIdentifier(callee)) return callee.text;
  return ts.isPropertyAccessExpression(callee) ? callee.name.text : undefined;
}

function functionNameOf(functionNode: Node): string | undefined {
  if (
    (ts.isMethodDeclaration(functionNode) ||
      ts.isFunctionDeclaration(functionNode) ||
      ts.isFunctionExpression(functionNode)) &&
    functionNode.name &&
    ts.isIdentifier(functionNode.name)
  )
    return functionNode.name.text;
  if (!ts.isArrowFunction(functionNode) && !ts.isFunctionExpression(functionNode)) return;
  const owner = functionNode.parent;
  if ((ts.isPropertyAssignment(owner) || ts.isVariableDeclaration(owner)) && ts.isIdentifier(owner.name))
    return owner.name.text;
}

// A callback handed directly to a call, as opposed to one stored under a name.
function callbackOwner(functionNode: Node): CallExpression | undefined {
  const call = functionNode.parent;
  return ts.isCallExpression(call) && call.arguments.some((argument) => argument === functionNode) ? call : undefined;
}

// React, Vue and Angular lifecycles are covered by the frontend cleanup rules.
function insideFrontendLifecycle(node: Node): boolean {
  for (let current = node.parent; current; current = current.parent) {
    if (!ts.isFunctionLike(current)) continue;
    const name = functionNameOf(current);
    if (name !== undefined && (frontendLifecycleMethods.has(name) || reactHookName.test(name))) return true;
    const owner = callbackOwner(current);
    const ownerName = owner && calleeName(owner);
    if (ownerName !== undefined && frontendLifecycleCallbacks.has(ownerName)) return true;
  }
  return false;
}

// `main()`, an immediately invoked function or a `listen(...)` callback runs once at startup, where a
// timer that lives as long as the process is intended.
function isStartupFunction(functionNode: Node): boolean {
  const name = functionNameOf(functionNode);
  if (name !== undefined && startupFunctionNames.has(name)) return true;
  const call =
    ts.isFunctionExpression(functionNode) || ts.isArrowFunction(functionNode)
      ? outermostWrapper(functionNode).parent
      : undefined;
  if (call && ts.isCallExpression(call) && ts.skipOuterExpressions(call.expression) === functionNode) return true;
  const owner = callbackOwner(functionNode);
  const ownerName = owner && calleeName(owner);
  return ownerName !== undefined && startupCallbackOwners.has(ownerName);
}

// A constructor or lifecycle hook runs once per instance of a singleton service, so a timer it
// starts without keeping the handle is the service's background timer.
function isSingletonInitializer(functionNode: Node): boolean {
  if (ts.isConstructorDeclaration(functionNode)) return true;
  const name = functionNameOf(functionNode);
  return name !== undefined && singletonInitializerNames.has(name);
}

function enclosingFunction(node: Node): Node | undefined {
  for (let current = node.parent; current; current = current.parent) if (ts.isFunctionLike(current)) return current;
}

// Names that reach `clearInterval`, or that get `.unref()`: an unref'd timer does not keep the process
// alive, so it is a deliberate background timer.
interface HandledNames {
  cleared: Set<string>;
  unreferenced: Set<string>;
}

function nameOfHandle(expression: Expression): string | undefined {
  const handle = ts.skipOuterExpressions(expression);
  if (ts.isIdentifier(handle)) return handle.text;
  return ts.isPropertyAccessExpression(handle) ? handle.name.text : undefined;
}

function collectHandledNames(sourceFile: SourceFile): HandledNames {
  const handled: HandledNames = { cleared: new Set(), unreferenced: new Set() };
  walkNodes(sourceFile, (node: Node) => {
    if (!ts.isCallExpression(node)) return;
    const callee = ts.skipOuterExpressions(node.expression);
    const calledName = calleeName(node);
    if (calledName === 'clearInterval' || calledName === 'clearTimeout') {
      const name = node.arguments[0] && nameOfHandle(node.arguments[0]);
      if (name !== undefined) handled.cleared.add(name);
    } else if (calledName === 'unref' && ts.isPropertyAccessExpression(callee)) {
      const name = nameOfHandle(callee.expression);
      if (name !== undefined) handled.unreferenced.add(name);
    }
  });
  return handled;
}

function isIntervalCall(call: CallExpression, checker: CheckerAdapter): boolean {
  const callee = ts.skipOuterExpressions(call.expression);
  if (ts.isPropertyAccessExpression(callee)) {
    const receiver = ts.skipOuterExpressions(callee.expression);
    return (
      callee.name.text === 'setInterval' &&
      ts.isIdentifier(receiver) &&
      ['window', 'globalThis'].includes(receiver.text)
    );
  }
  if (!ts.isIdentifier(callee) || callee.text !== 'setInterval') return false;
  const origin = importedReference(callee, checker);
  if (origin) return origin.moduleName === 'timers' && sameMembers(origin.members, ['setInterval']);
  // A local function that happens to be named setInterval is not the timer.
  const declarations = checker.getSymbolAtLocation(callee)?.declarations ?? [];
  return declarations.every((declaration) => declaration.getSourceFile().isDeclarationFile);
}

function isDiscarded(node: Node): boolean {
  const parent = node.parent;
  if (ts.isExpressionStatement(parent)) return true;
  return ts.isVoidExpression(parent) && ts.isExpressionStatement(parent.parent);
}

function intervalLeaks(call: CallExpression, checker: CheckerAdapter, handled: HandledNames): boolean {
  const node = outermostWrapper(call);
  const parent = node.parent;
  if (isDiscarded(node)) return true;
  if (ts.isVariableDeclaration(parent) && parent.initializer === node && ts.isIdentifier(parent.name)) {
    const statement = declaringStatement(parent);
    if (!statement) return false;
    // Anything beyond reading a property of the handle, clearing or returning it, ends the search.
    return referencesTo(parent, statement.parent, checker).every(
      (reference) => referenceKind(reference, statement.parent, noMethods, new Set(['unref'])) === 'use',
    );
  }
  if (
    !ts.isBinaryExpression(parent) ||
    parent.right !== node ||
    parent.operatorToken.kind !== ts.SyntaxKind.EqualsToken
  )
    return false;
  const name = nameOfHandle(parent.left);
  return name !== undefined && !handled.cleared.has(name) && !handled.unreferenced.has(name);
}

function checkIntervals(sourceFile: SourceFile, file: string, checker: CheckerAdapter, findings: Finding[]): void {
  if (!sourceFile.text.includes('setInterval')) return;
  if (importsModule(sourceFile, (moduleName) => frontendFramework.test(moduleName))) return;
  const handled = collectHandledNames(sourceFile);
  walkNodes(sourceFile, (node: Node) => {
    if (!ts.isCallExpression(node) || !isIntervalCall(node, checker)) return;
    const owner = enclosingFunction(node);
    if (!owner || isStartupFunction(owner) || insideFrontendLifecycle(node)) return;
    if (isDiscarded(outermostWrapper(node)) && isSingletonInitializer(owner)) return;
    if (!intervalLeaks(node, checker, handled)) return;
    findings.push(
      findingAt(
        sourceFile,
        file,
        node,
        'interval-not-cleared',
        'This setInterval handle is discarded or never passed to clearInterval, so the timer keeps running after its owner is gone and each call adds another. Keep the handle and clear it when the owner stops.',
      ),
    );
  });
}

function checkAcquisitions(sourceFile: SourceFile, file: string, checker: CheckerAdapter, findings: Finding[]): void {
  if (!acquisitionWords.test(sourceFile.text)) return;
  const isPlaywrightTestFile = importsModule(sourceFile, (moduleName) => moduleName === '@playwright/test');
  walkNodes(sourceFile, (node: Node) => {
    if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name)) return;
    const acquisition = acquisitionOf(node, checker, isPlaywrightTestFile);
    const state = acquisition && leakState(acquisition, checker);
    if (acquisition && state)
      findings.push(findingAt(sourceFile, file, node, acquisition.ruleId, acquisitionMessage(acquisition, state)));
  });
}

function checkResourceLeaks(sourceFile: SourceFile, file: string, checker: CheckerAdapter): Finding[] {
  if (isIgnoredSource(sourceFile, file)) return [];
  const findings: Finding[] = [];
  checkAcquisitions(sourceFile, file, checker, findings);
  checkIntervals(sourceFile, file, checker, findings);
  return findings;
}

export { checkResourceLeaks };
