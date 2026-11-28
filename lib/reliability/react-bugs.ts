// React and Next.js bugs that break an app at runtime without a build error: an effect that re-renders forever, an
// async effect callback, state mutated in place, list items without a key, and server-only environment variables read
// in a client component. Hooks are recognised by their import from react, never by name alone.
import { ts } from '../performance/compiler.js';
import { REACT_EFFECTS, REACT_MODULES, importedName, walkSkippingFunctions } from '../performance/frontend-helpers.js';
import { walkNodes } from './walk.js';
import { isAccess, isAssignmentOperator, isIgnoredSource, withoutParentheses } from './source-helpers.js';
import type {
  ArrowFunction,
  Block,
  CallExpression,
  Expression,
  FunctionDeclaration,
  FunctionExpression,
  Node,
  SourceFile,
} from 'typescript';
import type { CheckerAdapter, Finding } from '../shared/types.js';

type FunctionWithBody = ArrowFunction | FunctionExpression | (FunctionDeclaration & { body: Block });
type ServerBranch = 'whenTrue' | 'whenFalse';

interface StateSetter {
  setterSymbol: object;
  stateSymbol: object | undefined;
}

// Array methods that change the array they are called on.
const mutatingArrayMethods = new Set([
  'push',
  'pop',
  'shift',
  'unshift',
  'splice',
  'sort',
  'reverse',
  'fill',
  'copyWithin',
]);
// Map and Set methods that change the collection they are called on.
const mutatingCollectionMethods = new Set(['set', 'add', 'delete', 'clear']);
const collectionTypeNames = new Set(['Map', 'Set', 'WeakMap', 'WeakSet']);
const jsxImportSourcePragma = /@jsxImportSource\s+(\S+)/;
// Calls that always hand back a new array, so a setter given one gets a new value on every render.
const freshArrayMethods = new Set(['map', 'filter', 'slice', 'concat', 'flat', 'flatMap', 'toSorted', 'toReversed']);
// JSX runtimes where list items are not reconciled by `key`.
const keylessJsxModules = /^(?:solid-js|@solidjs\/|vue|@vue\/|@builder\.io\/qwik|@stencil\/core)/;
const clientDirective = 'use client';
// Next.js inlines these into the browser bundle.
const browserSafeEnvironmentName = /^(?:NEXT_PUBLIC_|NODE_ENV$|NEXT_RUNTIME$)/;
const serverGlobals = new Set(['window', 'document']);

function findingAt(sourceFile: SourceFile, file: string, node: Node, ruleId: string, message: string): Finding {
  const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return { file, line: position.line + 1, column: position.character + 1, ruleId, message };
}

function hasBlockBody(declaration: FunctionDeclaration): declaration is FunctionDeclaration & { body: Block } {
  return declaration.body !== undefined;
}

// An inline function, or a function declared elsewhere in the file and passed by name.
function functionBodyOf(node: Expression | undefined, checker: CheckerAdapter): FunctionWithBody | undefined {
  const target = node && withoutParentheses(node);
  if (!target) return;
  if (ts.isArrowFunction(target) || ts.isFunctionExpression(target)) return target;
  if (!ts.isIdentifier(target)) return;
  const declaration = checker.getSymbolAtLocation(target)?.declarations?.[0];
  if (declaration && ts.isFunctionDeclaration(declaration)) return hasBlockBody(declaration) ? declaration : undefined;
  const initializer =
    declaration && ts.isVariableDeclaration(declaration) && declaration.initializer
      ? withoutParentheses(declaration.initializer)
      : undefined;
  return initializer && (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))
    ? initializer
    : undefined;
}

function reactEffectCall(node: Node, checker: CheckerAdapter): CallExpression | undefined {
  if (!ts.isCallExpression(node)) return;
  const hook = importedName(node.expression, checker, REACT_MODULES);
  return hook && REACT_EFFECTS.has(hook) ? node : undefined;
}

// --- state setters ---

// `const [items, setItems] = useState(...)` -> the symbols of `items` and `setItems`.
function stateSetterOf(declaration: Node, checker: CheckerAdapter): StateSetter | undefined {
  if (!ts.isVariableDeclaration(declaration) || !ts.isArrayBindingPattern(declaration.name)) return;
  const initializer = declaration.initializer && withoutParentheses(declaration.initializer);
  if (!initializer || !ts.isCallExpression(initializer)) return;
  if (importedName(initializer.expression, checker, REACT_MODULES) !== 'useState') return;
  const [stateElement, setterElement] = declaration.name.elements;
  if (!setterElement || !ts.isBindingElement(setterElement) || !ts.isIdentifier(setterElement.name)) return;
  const setterSymbol = checker.getSymbolAtLocation(setterElement.name);
  if (!setterSymbol) return;
  const stateName = stateElement && ts.isBindingElement(stateElement) ? stateElement.name : undefined;
  const stateSymbol = stateName && ts.isIdentifier(stateName) ? checker.getSymbolAtLocation(stateName) : undefined;
  return { setterSymbol, stateSymbol };
}

function stateSetterCalledBy(call: CallExpression, checker: CheckerAdapter): StateSetter | undefined {
  const callee = withoutParentheses(call.expression);
  if (!ts.isIdentifier(callee)) return;
  const symbol = checker.getSymbolAtLocation(callee);
  // The symbol's declaration is the binding element; the useState call hangs off the declaration two levels up.
  const declaration = symbol?.declarations?.[0]?.parent?.parent;
  const setter = declaration && stateSetterOf(declaration, checker);
  return setter && setter.setterSymbol === symbol ? setter : undefined;
}

// --- react-async-effect-callback ---

function isAsync(callback: FunctionWithBody): boolean {
  return Boolean(callback.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword));
}

function checkAsyncEffects(
  effects: CallExpression[],
  sourceFile: SourceFile,
  file: string,
  checker: CheckerAdapter,
  findings: Finding[],
) {
  for (const effect of effects) {
    const callback = functionBodyOf(effect.arguments[0], checker);
    if (!callback || !isAsync(callback)) continue;
    findings.push(
      findingAt(
        sourceFile,
        file,
        callback,
        'react-async-effect-callback',
        'An async effect callback returns a promise, which React treats as the cleanup function: React warns, the effect never cleans up, and a rejection goes unhandled. Declare an async function inside the effect and call it.',
      ),
    );
  }
}

// --- react-effect-sets-state-every-render ---

function updaterResults(updater: FunctionWithBody): Expression[] {
  if (!ts.isBlock(updater.body)) return [withoutParentheses(updater.body)];
  const results: Expression[] = [];
  walkSkippingFunctions(updater.body, (node: Node) => {
    if (ts.isReturnStatement(node) && node.expression) results.push(withoutParentheses(node.expression));
  });
  return results;
}

function isZeroLiteral(expression: Expression): boolean {
  const value = withoutParentheses(expression);
  return ts.isNumericLiteral(value) && Number(value.text) === 0;
}

// `prev => prev`, `prev || true` and `prev + 0` settle on a value React bails out on; `prev + 1` and `[...prev, x]` never do.
function changesValue(result: Expression): boolean {
  if (ts.isArrayLiteralExpression(result) || ts.isObjectLiteralExpression(result)) return true;
  if (!ts.isBinaryExpression(result)) return false;
  const kind = result.operatorToken.kind;
  const isArithmetic = kind === ts.SyntaxKind.PlusToken || kind === ts.SyntaxKind.MinusToken;
  return isArithmetic && !isZeroLiteral(result.left) && !isZeroLiteral(result.right);
}

function returnsOrThrows(statement: Node): boolean {
  let exits = false;
  walkSkippingFunctions(statement, (node: Node) => {
    if (ts.isReturnStatement(node) || ts.isThrowStatement(node)) exits = true;
  });
  return exits;
}

// A setter given the value it already holds bails out of the re-render, so only arguments that are a new object,
// array or computed number each time keep the loop going.
function isFreshValue(argument: Expression, checker: CheckerAdapter): boolean {
  const value = withoutParentheses(argument);
  if (ts.isObjectLiteralExpression(value) || ts.isArrayLiteralExpression(value) || ts.isNewExpression(value))
    return true;
  if (ts.isCallExpression(value)) {
    const callee = withoutParentheses(value.expression);
    if (!ts.isPropertyAccessExpression(callee)) return false;
    const isClock =
      ts.isIdentifier(callee.expression) && callee.expression.text === 'Date' && callee.name.text === 'now';
    return isClock || freshArrayMethods.has(callee.name.text);
  }
  const updater = functionBodyOf(value, checker);
  if (!updater || updater.parameters.length === 0) return false;
  const results = updaterResults(updater);
  return results.length > 0 && results.every(changesValue);
}

function freshSetterCall(expression: Expression, checker: CheckerAdapter): CallExpression | undefined {
  const call = withoutParentheses(expression);
  if (!ts.isCallExpression(call) || !stateSetterCalledBy(call, checker)) return;
  return call.arguments[0] && isFreshValue(call.arguments[0], checker) ? call : undefined;
}

function unconditionalSetterCall(body: Node, checker: CheckerAdapter): CallExpression | undefined {
  if (!ts.isBlock(body)) return ts.isExpression(body) ? freshSetterCall(body, checker) : undefined;
  for (const statement of body.statements) {
    // `return setItems([])` still runs the setter before it leaves.
    if (ts.isReturnStatement(statement)) return statement.expression && freshSetterCall(statement.expression, checker);
    // A guard before the call (an early return, a thrown error) makes the update conditional.
    if (returnsOrThrows(statement) && !ts.isExpressionStatement(statement)) return;
    if (!ts.isExpressionStatement(statement)) continue;
    const call = freshSetterCall(statement.expression, checker);
    if (call) return call;
  }
}

// React treats an explicit `undefined` like an omitted dependency array.
function hasNoDependencies(effect: CallExpression): boolean {
  if (effect.arguments.length === 1) return true;
  const dependencies = effect.arguments[1] && withoutParentheses(effect.arguments[1]);
  return (
    effect.arguments.length === 2 &&
    dependencies !== undefined &&
    ts.isIdentifier(dependencies) &&
    dependencies.text === 'undefined'
  );
}

function checkEffectLoops(
  effects: CallExpression[],
  sourceFile: SourceFile,
  file: string,
  checker: CheckerAdapter,
  findings: Finding[],
) {
  for (const effect of effects) {
    if (!hasNoDependencies(effect)) continue;
    const callback = functionBodyOf(effect.arguments[0], checker);
    const setterCall = callback && unconditionalSetterCall(callback.body, checker);
    if (!setterCall) continue;
    findings.push(
      findingAt(
        sourceFile,
        file,
        setterCall,
        'react-effect-sets-state-every-render',
        'This effect has no dependency array and sets state to a new value on every run, so each render schedules another render without end. Add a dependency array or move the update into an event handler.',
      ),
    );
  }
}

// --- react-state-mutated-in-place ---

// An alias is followed back to the state it points at, so `const alias = items; alias.push(x)` changes `items`.
function stateSymbolOfRoot(
  expression: Expression,
  checker: CheckerAdapter,
  aliases: Map<object, object>,
): object | undefined {
  let current = withoutParentheses(expression);
  while (isAccess(current)) current = withoutParentheses(current.expression);
  const symbol = ts.isIdentifier(current) ? checker.getSymbolAtLocation(current) : undefined;
  return symbol && (aliases.get(symbol) ?? symbol);
}

function isCollection(receiver: Expression, checker: CheckerAdapter): boolean {
  const type = checker.getNonNullableType(checker.getTypeAtLocation(receiver));
  const name = type.getSymbol()?.name;
  return name !== undefined && collectionTypeNames.has(name);
}

function isMutatingCall(callee: Expression, checker: CheckerAdapter): boolean {
  if (!ts.isPropertyAccessExpression(callee)) return false;
  if (mutatingArrayMethods.has(callee.name.text)) return true;
  return mutatingCollectionMethods.has(callee.name.text) && isCollection(callee.expression, checker);
}

function mutatedSymbolOf(node: Node, checker: CheckerAdapter, aliases: Map<object, object>): object | undefined {
  if (ts.isCallExpression(node)) {
    const callee = withoutParentheses(node.expression);
    // A call result in the chain (`items.map(...).sort()`) is a copy, and the root lookup finds no state behind it.
    return isMutatingCall(callee, checker) && ts.isPropertyAccessExpression(callee)
      ? stateSymbolOfRoot(callee.expression, checker, aliases)
      : undefined;
  }
  if (ts.isBinaryExpression(node) && isAssignmentOperator(node.operatorToken.kind)) {
    const target = withoutParentheses(node.left);
    return isAccess(target) ? stateSymbolOfRoot(target, checker, aliases) : undefined;
  }
  if (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) {
    const isStep = node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken;
    const target = withoutParentheses(node.operand);
    return isStep && isAccess(target) ? stateSymbolOfRoot(target, checker, aliases) : undefined;
  }
}

// `const alias = items` makes `alias` another name for the same state value.
function recordAlias(node: Node, checker: CheckerAdapter, aliases: Map<object, object>) {
  if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name) || !node.initializer) return;
  const source = stateSymbolOfRoot(node.initializer, checker, aliases);
  const initializer = withoutParentheses(node.initializer);
  const aliasSymbol = checker.getSymbolAtLocation(node.name);
  if (source && aliasSymbol && ts.isIdentifier(initializer)) aliases.set(aliasSymbol, source);
}

function isCallbackArgument(node: Node): boolean {
  return (
    (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) &&
    ts.isCallExpression(node.parent) &&
    node.parent.arguments.some((argument) => argument === node)
  );
}

// Callbacks passed straight to a call (`items.forEach(...)`) run as part of the function; a nested helper that is
// only declared does not, and is checked as a function of its own.
function walkRunningCode(root: Node, visit: (node: Node) => void) {
  (function walk(node: Node): void {
    if (node !== root && ts.isFunctionLike(node) && !isCallbackArgument(node)) return;
    visit(node);
    ts.forEachChild(node, walk);
  })(root);
}

function checkStateMutations(sourceFile: SourceFile, file: string, checker: CheckerAdapter, findings: Finding[]) {
  // A call sits inside every function that encloses it, so each is reported once.
  const reported = new Set<Node>();
  walkNodes(sourceFile, (node: Node) => {
    if (!ts.isFunctionLike(node) || !('body' in node) || !node.body) return;
    const mutated = new Set<object>();
    const aliases = new Map<object, object>();
    const setterCalls: { call: CallExpression; setter: StateSetter }[] = [];
    // Source order puts the mutation before the setter call it feeds; a mutation after the call is another update.
    walkRunningCode(node.body, (inner: Node) => {
      recordAlias(inner, checker, aliases);
      const symbol = mutatedSymbolOf(inner, checker, aliases);
      if (symbol) mutated.add(symbol);
      if (!ts.isCallExpression(inner)) return;
      const setter = stateSetterCalledBy(inner, checker);
      const argument = inner.arguments[0] && withoutParentheses(inner.arguments[0]);
      if (!setter?.stateSymbol || !argument || !ts.isIdentifier(argument)) return;
      if (checker.getSymbolAtLocation(argument) === setter.stateSymbol && mutated.has(setter.stateSymbol))
        setterCalls.push({ call: inner, setter });
    });
    for (const { call } of setterCalls) {
      if (reported.has(call)) continue;
      reported.add(call);
      findings.push(
        findingAt(
          sourceFile,
          file,
          call,
          'react-state-mutated-in-place',
          'This state value is changed in place and then passed back to its own setter. React compares by reference, sees the same object and skips the re-render. Set a copy instead, such as `setItems([...items, item])`.',
        ),
      );
    }
  });
}

// --- react-list-missing-key ---

function jsxAttributes(element: Expression) {
  if (ts.isJsxSelfClosingElement(element)) return element.attributes.properties;
  return ts.isJsxElement(element) ? element.openingElement.attributes.properties : undefined;
}

function hasKeyOrSpread(element: Expression): boolean {
  const attributes = jsxAttributes(element);
  return Boolean(
    attributes?.some(
      (attribute) =>
        ts.isJsxSpreadAttribute(attribute) || (ts.isIdentifier(attribute.name) && attribute.name.text === 'key'),
    ),
  );
}

function renderedRoots(expression: Expression): Expression[] {
  const value = withoutParentheses(expression);
  if (ts.isConditionalExpression(value)) return [...renderedRoots(value.whenTrue), ...renderedRoots(value.whenFalse)];
  if (ts.isBinaryExpression(value) && value.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken)
    return renderedRoots(value.right);
  return [value];
}

function returnedFrom(callback: FunctionWithBody): Expression[] {
  if (!ts.isBlock(callback.body)) return renderedRoots(callback.body);
  const returned: Expression[] = [];
  walkSkippingFunctions(callback.body, (node: Node) => {
    if (ts.isReturnStatement(node) && node.expression) returned.push(...renderedRoots(node.expression));
  });
  return returned;
}

function isJsxItem(expression: Expression): boolean {
  return ts.isJsxElement(expression) || ts.isJsxSelfClosingElement(expression) || ts.isJsxFragment(expression);
}

function isReactChildrenHelper(receiver: Expression): boolean {
  const target = withoutParentheses(receiver);
  const name = ts.isPropertyAccessExpression(target) ? target.name : target;
  return ts.isIdentifier(name) && name.text === 'Children';
}

// Known non-array receivers (immutable collections, observables) are left alone; an unresolved type is trusted.
function mayBeArray(receiver: Expression, checker: CheckerAdapter): boolean {
  const type = checker.getNonNullableType(checker.getTypeAtLocation(receiver));
  if (type.flags & ts.TypeFlags.Any) return true;
  const members = type.isUnion() && type.types ? type.types : [type];
  return members.every((member) => checker.isArrayType(member));
}

function checkListKeys(sourceFile: SourceFile, file: string, checker: CheckerAdapter, findings: Finding[]) {
  walkNodes(sourceFile, (node: Node) => {
    if (!ts.isCallExpression(node)) return;
    const callee = withoutParentheses(node.expression);
    if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== 'map') return;
    if (isReactChildrenHelper(callee.expression) || !mayBeArray(callee.expression, checker)) return;
    const callback = functionBodyOf(node.arguments[0], checker);
    if (!callback) return;
    for (const item of returnedFrom(callback)) {
      if (!isJsxItem(item) || hasKeyOrSpread(item)) continue;
      findings.push(
        findingAt(
          sourceFile,
          file,
          item,
          'react-list-missing-key',
          ts.isJsxFragment(item)
            ? 'This list item is a `<>...</>` fragment, which cannot take a key, so React cannot tell the items apart when the list changes. Use `<Fragment key={...}>` instead.'
            : 'This list item has no `key` prop, so React cannot tell the items apart and can reuse the wrong state or DOM when the list changes. Add a stable `key` from the item.',
        ),
      );
    }
  });
}

// A `@jsxImportSource` pragma wins over the project setting, and either can name a runtime without keys.
function usesKeylessJsx(sourceFile: SourceFile, projectJsxImportSource: string | undefined): boolean {
  const runtime = jsxImportSourcePragma.exec(sourceFile.text)?.[1] ?? projectJsxImportSource;
  return Boolean(runtime && keylessJsxModules.test(runtime)) || importsKeylessJsx(sourceFile);
}

function importsKeylessJsx(sourceFile: SourceFile): boolean {
  return sourceFile.statements.some(
    (statement) =>
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      keylessJsxModules.test(statement.moduleSpecifier.text),
  );
}

// --- next-server-env-in-client ---

function isClientComponent(sourceFile: SourceFile): boolean {
  for (const statement of sourceFile.statements) {
    if (!ts.isExpressionStatement(statement) || !ts.isStringLiteral(statement.expression)) return false;
    if (statement.expression.text === clientDirective) return true;
  }
  return false;
}

function isProcessEnv(expression: Expression): boolean {
  const target = withoutParentheses(expression);
  if (!ts.isPropertyAccessExpression(target) || target.name.text !== 'env') return false;
  const owner = withoutParentheses(target.expression);
  return ts.isIdentifier(owner) && owner.text === 'process';
}

interface EnvironmentRead {
  // Undefined for a computed key, which Next.js cannot inline whatever the name.
  name: string | undefined;
  at: Node;
}

function environmentReadsIn(node: Node): EnvironmentRead[] {
  if (ts.isPropertyAccessExpression(node) && isProcessEnv(node.expression)) return [{ name: node.name.text, at: node }];
  if (ts.isElementAccessExpression(node) && isProcessEnv(node.expression)) {
    const key = withoutParentheses(node.argumentExpression);
    return [{ name: ts.isStringLiteralLike(key) ? key.text : undefined, at: node }];
  }
  // `const { API_SECRET } = process.env` reads each listed name.
  if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name) && node.initializer) {
    if (!isProcessEnv(node.initializer)) return [];
    return node.name.elements
      .filter((element) => !element.dotDotDotToken)
      .map((element) => {
        const key = element.propertyName ?? element.name;
        const isNamed = ts.isIdentifier(key) || ts.isStringLiteralLike(key);
        return { name: isNamed ? key.text : undefined, at: element };
      });
  }
  return [];
}

function isServerTypeofCheck(operand: Expression): boolean {
  const target = withoutParentheses(operand);
  const subject = ts.isTypeOfExpression(target) ? withoutParentheses(target.expression) : undefined;
  return subject !== undefined && ts.isIdentifier(subject) && serverGlobals.has(subject.text);
}

function isUndefinedLiteral(operand: Expression): boolean {
  const target = withoutParentheses(operand);
  return ts.isStringLiteralLike(target) && target.text === 'undefined';
}

function flipped(branch: ServerBranch | undefined): ServerBranch | undefined {
  if (!branch) return;
  return branch === 'whenTrue' ? 'whenFalse' : 'whenTrue';
}

// Which branch of `condition` only runs on the server (`typeof window === 'undefined'` is true there, `!==` is false).
function serverBranchOf(condition: Expression): ServerBranch | undefined {
  const target = withoutParentheses(condition);
  if (ts.isPrefixUnaryExpression(target) && target.operator === ts.SyntaxKind.ExclamationToken)
    return flipped(serverBranchOf(target.operand));
  if (ts.isBinaryExpression(target)) {
    const kind = target.operatorToken.kind;
    const isEquals = kind === ts.SyntaxKind.EqualsEqualsEqualsToken || kind === ts.SyntaxKind.EqualsEqualsToken;
    const isNotEquals =
      kind === ts.SyntaxKind.ExclamationEqualsEqualsToken || kind === ts.SyntaxKind.ExclamationEqualsToken;
    const comparesTypeof =
      (isServerTypeofCheck(target.left) && isUndefinedLiteral(target.right)) ||
      (isServerTypeofCheck(target.right) && isUndefinedLiteral(target.left));
    if (!comparesTypeof) return;
    if (isEquals) return 'whenTrue';
    return isNotEquals ? 'whenFalse' : undefined;
  }
  const flag = ts.isPropertyAccessExpression(target) ? target.name : target;
  const isServerFlag = ts.isIdentifier(flag) && flag.text === 'isServer';
  return isServerFlag || target.getText() === 'import.meta.env.SSR' ? 'whenTrue' : undefined;
}

function branchTaken(ancestor: Node, child: Node): { condition: Expression; branch: ServerBranch } | undefined {
  if (ts.isIfStatement(ancestor)) {
    if (child === ancestor.thenStatement) return { condition: ancestor.expression, branch: 'whenTrue' };
    if (child === ancestor.elseStatement) return { condition: ancestor.expression, branch: 'whenFalse' };
  }
  if (ts.isConditionalExpression(ancestor)) {
    if (child === ancestor.whenTrue) return { condition: ancestor.condition, branch: 'whenTrue' };
    if (child === ancestor.whenFalse) return { condition: ancestor.condition, branch: 'whenFalse' };
  }
}

// Server-only branches legitimately read secrets; the other branch of the same guard runs in the browser.
function isGuardedForServer(node: Node): boolean {
  let child = node;
  for (let ancestor = node.parent; ancestor; ancestor = ancestor.parent) {
    const taken = branchTaken(ancestor, child);
    if (taken && serverBranchOf(taken.condition) === taken.branch) return true;
    child = ancestor;
  }
  return false;
}

function checkClientEnvironment(sourceFile: SourceFile, file: string, findings: Finding[]) {
  if (!isClientComponent(sourceFile) || !sourceFile.text.includes('process.env')) return;
  walkNodes(sourceFile, (node: Node) => {
    for (const read of environmentReadsIn(node)) {
      if (read.name !== undefined && browserSafeEnvironmentName.test(read.name)) continue;
      if (isGuardedForServer(read.at)) continue;
      findings.push(
        findingAt(
          sourceFile,
          file,
          read.at,
          'next-server-env-in-client',
          read.name === undefined
            ? "`process.env` is read with a computed key in a 'use client' file, and Next.js inlines only literal NEXT_PUBLIC_ names into the browser bundle, so the value is undefined there. Read it on the server and pass only a non-sensitive derived value to the Client Component, never the raw value."
            : `\`process.env.${read.name}\` is read in a 'use client' file, but Next.js only exposes variables prefixed with NEXT_PUBLIC_ to the browser, so it is undefined there. Read it on the server and pass only a non-sensitive derived value to the Client Component, never the raw value. Rename it with the NEXT_PUBLIC_ prefix only if it is safe to publish.`,
        ),
      );
    }
  });
}

function checkReactBugs(
  sourceFile: SourceFile,
  file: string,
  checker: CheckerAdapter,
  projectJsxImportSource?: string,
): Finding[] {
  if (isIgnoredSource(sourceFile, file)) return [];
  const findings: Finding[] = [];
  checkClientEnvironment(sourceFile, file, findings);
  const isScript = /\.[cm]?js$/.test(file) && sourceFile.text.includes('.map(');
  const mentionsReact = sourceFile.text.includes('react') || /\.[jt]sx$/.test(file) || isScript;
  if (!mentionsReact) return findings;
  const effects: CallExpression[] = [];
  const isReactSource = sourceFile.text.includes('useEffect') || sourceFile.text.includes('useLayoutEffect');
  if (isReactSource)
    walkNodes(sourceFile, (node: Node) => {
      const effect = reactEffectCall(node, checker);
      if (effect) effects.push(effect);
    });
  checkAsyncEffects(effects, sourceFile, file, checker, findings);
  checkEffectLoops(effects, sourceFile, file, checker, findings);
  if (sourceFile.text.includes('useState')) checkStateMutations(sourceFile, file, checker, findings);
  // Plain .js files are parsed with JSX too, so components in them need the same check.
  if (/\.(?:[jt]sx|[cm]?js)$/.test(file) && !usesKeylessJsx(sourceFile, projectJsxImportSource))
    checkListKeys(sourceFile, file, checker, findings);
  return findings;
}

export { checkReactBugs };
