// React and Next.js bugs that break an app at runtime without a build error: an effect that re-renders forever, an
// async effect callback, state mutated in place, list items without a key, and server-only environment variables read
// in a client component. Hooks are recognised by their import from react, never by name alone.
import { ts } from '../performance/compiler.js';
import { REACT_EFFECTS, REACT_MODULES, importedName, walkSkippingFunctions } from '../performance/frontend-helpers.js';
import { walkNodes } from './walk.js';
import { isAccess, isIgnoredSource, withoutParentheses } from './source-helpers.js';
import type { ArrowFunction, CallExpression, Expression, FunctionExpression, Node, SourceFile } from 'typescript';
import type { CheckerAdapter, Finding } from '../shared/types.js';

type FunctionWithBody = ArrowFunction | FunctionExpression;

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
// Calls that always hand back a new array, so a setter given one gets a new value on every render.
const freshArrayMethods = new Set(['map', 'filter', 'slice', 'concat', 'flat', 'flatMap', 'toSorted', 'toReversed']);
// JSX runtimes where list items are not reconciled by `key`.
const keylessJsxModules = /^(?:solid-js|@solidjs\/|vue|@vue\/|@builder\.io\/qwik|@stencil\/core)/;
const clientDirective = 'use client';
// Next.js inlines these into the browser bundle.
const browserSafeEnvironmentName = /^(?:NEXT_PUBLIC_|NODE_ENV$|NEXT_RUNTIME$)/;
const serverOnlyGuard =
  /typeof\s+window\s*[!=]==?\s*['"]undefined['"]|typeof\s+document\s*[!=]==?\s*['"]undefined['"]|isServer|import\.meta\.env\.SSR/;

function findingAt(sourceFile: SourceFile, file: string, node: Node, ruleId: string, message: string): Finding {
  const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return { file, line: position.line + 1, column: position.character + 1, ruleId, message };
}

function functionBodyOf(node: Expression | undefined): FunctionWithBody | undefined {
  const target = node && withoutParentheses(node);
  return target && (ts.isArrowFunction(target) || ts.isFunctionExpression(target)) ? target : undefined;
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

function checkAsyncEffects(effects: CallExpression[], sourceFile: SourceFile, file: string, findings: Finding[]) {
  for (const effect of effects) {
    const callback = functionBodyOf(effect.arguments[0]);
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

function returnsOrThrows(statement: Node): boolean {
  let exits = false;
  walkSkippingFunctions(statement, (node: Node) => {
    if (ts.isReturnStatement(node) || ts.isThrowStatement(node)) exits = true;
  });
  return exits;
}

// A setter given the value it already holds bails out of the re-render, so only arguments that are a new object,
// array or computed number each time keep the loop going.
function isFreshValue(argument: Expression): boolean {
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
  const updater = functionBodyOf(value);
  if (!updater || updater.parameters.length === 0) return false;
  const result = ts.isBlock(updater.body) ? undefined : withoutParentheses(updater.body);
  // `prev => prev` and a literal result are no change; `prev + 1` and `[...prev, x]` always are.
  return Boolean(
    result &&
    (ts.isBinaryExpression(result) || ts.isArrayLiteralExpression(result) || ts.isObjectLiteralExpression(result)),
  );
}

function unconditionalSetterCall(body: Node, checker: CheckerAdapter): CallExpression | undefined {
  if (!ts.isBlock(body)) return;
  for (const statement of body.statements) {
    // A guard before the call (an early return, a thrown error) makes the update conditional.
    if (returnsOrThrows(statement) && !ts.isExpressionStatement(statement)) return;
    if (!ts.isExpressionStatement(statement)) continue;
    const call = withoutParentheses(statement.expression);
    if (!ts.isCallExpression(call) || !stateSetterCalledBy(call, checker)) continue;
    if (call.arguments[0] && isFreshValue(call.arguments[0])) return call;
  }
}

function checkEffectLoops(
  effects: CallExpression[],
  sourceFile: SourceFile,
  file: string,
  checker: CheckerAdapter,
  findings: Finding[],
) {
  for (const effect of effects) {
    if (effect.arguments.length !== 1) continue;
    const callback = functionBodyOf(effect.arguments[0]);
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

function stateSymbolOfRoot(expression: Expression, checker: CheckerAdapter): object | undefined {
  let current = withoutParentheses(expression);
  while (isAccess(current)) current = withoutParentheses(current.expression);
  return ts.isIdentifier(current) ? checker.getSymbolAtLocation(current) : undefined;
}

function mutatedSymbolOf(node: Node, checker: CheckerAdapter): object | undefined {
  if (ts.isCallExpression(node)) {
    const callee = withoutParentheses(node.expression);
    // Only the state value itself, so `items.sort()` counts but `items.map(...).sort()` (a copy) does not.
    const isDirect = ts.isPropertyAccessExpression(callee) && ts.isIdentifier(withoutParentheses(callee.expression));
    if (!isDirect || !mutatingArrayMethods.has(callee.name.text)) return;
    return stateSymbolOfRoot(callee.expression, checker);
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
    const target = withoutParentheses(node.left);
    return isAccess(target) ? stateSymbolOfRoot(target, checker) : undefined;
  }
}

function checkStateMutations(sourceFile: SourceFile, file: string, checker: CheckerAdapter, findings: Finding[]) {
  // A call sits inside every function that encloses it, so each is reported once.
  const reported = new Set<Node>();
  walkNodes(sourceFile, (node: Node) => {
    if (!ts.isFunctionLike(node) || !('body' in node) || !node.body) return;
    const mutated = new Set<object>();
    const setterCalls: { call: CallExpression; setter: StateSetter }[] = [];
    // Source order puts the mutation before the setter call it feeds; a mutation after the call is another update.
    walkNodes(node.body, (inner: Node) => {
      const symbol = mutatedSymbolOf(inner, checker);
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
  return Boolean(type.flags & ts.TypeFlags.Any) || checker.isArrayType(type);
}

function checkListKeys(sourceFile: SourceFile, file: string, checker: CheckerAdapter, findings: Finding[]) {
  walkNodes(sourceFile, (node: Node) => {
    if (!ts.isCallExpression(node)) return;
    const callee = withoutParentheses(node.expression);
    if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== 'map') return;
    if (isReactChildrenHelper(callee.expression) || !mayBeArray(callee.expression, checker)) return;
    const callback = functionBodyOf(node.arguments[0]);
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

function environmentNameRead(node: Node): { name: string; at: Node } | undefined {
  if (ts.isPropertyAccessExpression(node) && isProcessEnv(node.expression)) return { name: node.name.text, at: node };
  if (ts.isElementAccessExpression(node) && isProcessEnv(node.expression)) {
    const key = withoutParentheses(node.argumentExpression);
    return ts.isStringLiteralLike(key) ? { name: key.text, at: node } : undefined;
  }
}

// Server-only branches (`typeof window === 'undefined'`) legitimately read secrets.
function guardOf(ancestor: Node): Node | undefined {
  if (ts.isIfStatement(ancestor)) return ancestor.expression;
  return ts.isConditionalExpression(ancestor) ? ancestor.condition : undefined;
}

function isGuardedForServer(node: Node): boolean {
  for (let ancestor = node.parent; ancestor; ancestor = ancestor.parent) {
    const guard = guardOf(ancestor);
    // The read must sit in a branch, not inside the condition itself.
    if (guard && node.pos > guard.end && serverOnlyGuard.test(guard.getText())) return true;
  }
  return false;
}

function checkClientEnvironment(sourceFile: SourceFile, file: string, findings: Finding[]) {
  if (!isClientComponent(sourceFile) || !sourceFile.text.includes('process.env')) return;
  walkNodes(sourceFile, (node: Node) => {
    const read = environmentNameRead(node);
    if (!read || browserSafeEnvironmentName.test(read.name) || isGuardedForServer(node)) return;
    findings.push(
      findingAt(
        sourceFile,
        file,
        read.at,
        'next-server-env-in-client',
        `\`process.env.${read.name}\` is read in a 'use client' file, but Next.js only exposes variables prefixed with NEXT_PUBLIC_ to the browser, so it is undefined there. Read it on the server and pass it down, or rename it with the prefix if it is safe to publish.`,
      ),
    );
  });
}

function checkReactBugs(sourceFile: SourceFile, file: string, checker: CheckerAdapter): Finding[] {
  if (isIgnoredSource(sourceFile, file)) return [];
  const findings: Finding[] = [];
  checkClientEnvironment(sourceFile, file, findings);
  const mentionsReact = sourceFile.text.includes('react') || /\.[jt]sx$/.test(file);
  if (!mentionsReact) return findings;
  const effects: CallExpression[] = [];
  const isReactSource = sourceFile.text.includes('useEffect') || sourceFile.text.includes('useLayoutEffect');
  if (isReactSource)
    walkNodes(sourceFile, (node: Node) => {
      const effect = reactEffectCall(node, checker);
      if (effect) effects.push(effect);
    });
  checkAsyncEffects(effects, sourceFile, file, findings);
  checkEffectLoops(effects, sourceFile, file, checker, findings);
  if (sourceFile.text.includes('useState')) checkStateMutations(sourceFile, file, checker, findings);
  if (/\.[jt]sx$/.test(file) && !importsKeylessJsx(sourceFile)) checkListKeys(sourceFile, file, checker, findings);
  return findings;
}

export { checkReactBugs };
