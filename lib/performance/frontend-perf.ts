// Frontend performance rules covering React, Angular and Vue; the DOM and bundle-size rules live in
// frontend-dom-perf.cjs and the shared helpers in frontend-helpers.cjs:
// - react-missing-cleanup
// - react-index-as-key
// - react-fetch-in-effect-no-abort
// - react-inline-object-in-jsx-prop
// - angular-subscribe-without-cleanup
// - angular-default-change-detection
// - vue-watch-missing-cleanup
// - vue-v-for-missing-key
// Every rule rests on where a name comes from (its import), never on the name alone.
import { ts } from './compiler.js';
import { isTestSource } from './review-context.js';
import { declaredInPackage, initializerOf, packageOf, propertyName } from './schema/ts-helpers.js';
import { checkAddEventListener, checkHeavyBarrelImport, checkLayoutThrashing, isLoop } from './frontend-dom-perf.js';
import {
  ANGULAR_MODULES,
  REACT_MODULES,
  VUE_MODULES,
  calleeName,
  containsReturnValue,
  effectCallback,
  importedName,
  isBrowserGlobal,
  isGlobalEventTarget,
  isVueImport,
  walkAll,
  walkSkippingFunctions,
} from './frontend-helpers.js';
import type {
  ArrowFunction,
  CallExpression,
  ClassDeclaration,
  Decorator,
  Expression,
  FunctionExpression,
  JsxAttributeLike,
  JsxOpeningLikeElement,
  JsxTagNameExpression,
  MethodDeclaration,
  Node,
  NewExpression,
  ObjectLiteralExpression,
  SourceFile,
} from 'typescript';
import type { CheckerAdapter, PerformanceRuleContext } from '../shared/types.js';

const RXJS_OPERATOR_MODULES = ['rxjs', 'rxjs/operators', '@angular/core/rxjs-interop'];

const DEFINITE_LEAK_CONSTRUCTORS = new Set(['WebSocket', 'EventSource']);
const OBSERVER_CONSTRUCTORS = new Set(['ResizeObserver', 'IntersectionObserver', 'MutationObserver']);
const ENDLESS_RXJS_CREATORS = new Set(['interval', 'fromEvent', 'fromEventPattern']);
const COMPLETING_OPERATORS = new Set([
  'takeUntil',
  'takeUntilDestroyed',
  'take',
  'takeWhile',
  'takeLast',
  'first',
  'last',
  'single',
  'elementAt',
]);
const ENDLESS_PACKAGES = ['@ngrx/store', '@angular/forms'];
const COMPLETING_PACKAGES = ['@angular/common'];

const SUBSCRIBE_MAY_COMPLETE_REASON =
  'The source may complete on its own (route params, single-emission or finite observables); dismiss if it does.';
const FETCH_STATIC_DEPS_REASON =
  'With an empty dependency array the request runs once per mount, so only an unmount before the response matters.';
const INDEX_KEY_REASON = 'Index keys are fine for lists that never reorder, insert, or delete items.';
const INLINE_OBJECT_REASON =
  'Matters only when the memoised child re-renders often enough for the extra renders to show.';
const OBSERVER_REASON =
  'An observer attached to an element the component owns is collected with that element; it leaks when attached to document-level targets.';
const ON_PUSH_REASON =
  'OnPush skips checks for @Input objects that are mutated in place, so confirm the inputs are immutable or signal-driven first; zoneless apps do not need it.';

type SubscriptionKind = 'endless' | 'unknown';

interface Leak {
  label: string;
  reason?: string;
}

// --- RxJS subscriptions
// -------------------------------------------------------------------------------------

// `source.pipe(a(), b()).asObservable()` -> the source expression plus the imported operator names
// applied to it.
function unwrapPipes(expression: Expression, checker: CheckerAdapter): { source: Expression; operatorNames: string[] } {
  const operatorNames: string[] = [];
  let source = ts.skipOuterExpressions(expression);
  while (ts.isCallExpression(source) && ts.isPropertyAccessExpression(source.expression)) {
    const method = source.expression.name.text;
    if (method === 'pipe') operatorNames.push(...importedOperatorNames(source.arguments, checker));
    else if (method !== 'asObservable') break;
    source = ts.skipOuterExpressions(source.expression.expression);
  }
  return { source, operatorNames };
}

function importedOperatorNames(pipeArguments: readonly Expression[], checker: CheckerAdapter): string[] {
  const names: string[] = [];
  for (const argument of pipeArguments) {
    const operator = ts.skipOuterExpressions(argument);
    const name = ts.isCallExpression(operator) && importedName(operator.expression, checker, RXJS_OPERATOR_MODULES);
    if (name) names.push(name);
  }
  return names;
}

function isRxjsSubject(source: Expression, checker: CheckerAdapter) {
  const symbol = checker.getTypeAtLocation(source).getSymbol();
  if (!symbol || !symbol.name.endsWith('Subject')) return false;
  return (symbol.declarations ?? []).every((declaration: Node) => packageOf(declaration) === 'rxjs');
}

function isEndlessCreator(callee: Expression, checker: CheckerAdapter): boolean {
  const name = importedName(callee, checker, ['rxjs']);
  return name !== undefined && ENDLESS_RXJS_CREATORS.has(name);
}

// 'completing' sources finish after one response (HttpClient); 'endless' ones keep emitting until
// unsubscribed.
function classifySource(source: Expression, checker: CheckerAdapter): 'completing' | SubscriptionKind {
  if (ts.isCallExpression(source)) {
    if (isEndlessCreator(source.expression, checker)) return 'endless';
    if (declaredInPackage(source.expression, checker, COMPLETING_PACKAGES)) return 'completing';
    if (declaredInPackage(source.expression, checker, ENDLESS_PACKAGES)) return 'endless';
    return 'unknown';
  }
  if (isRxjsSubject(source, checker) || declaredInPackage(source, checker, ENDLESS_PACKAGES)) return 'endless';
  return 'unknown';
}

// undefined: not an RxJS subscription, or one that ends on its own. Otherwise 'endless' or
// 'unknown'.
function unmanagedSubscription(call: CallExpression, checker: CheckerAdapter): SubscriptionKind | undefined {
  const callee = ts.skipOuterExpressions(call.expression);
  if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== 'subscribe') return;
  if (!declaredInPackage(callee, checker, ['rxjs'])) return;
  const { source, operatorNames } = unwrapPipes(callee.expression, checker);
  if (operatorNames.some((name) => COMPLETING_OPERATORS.has(name))) return;
  const kind = classifySource(source, checker);
  return kind === 'completing' ? undefined : kind;
}

// --- React
// ---------------------------------------------------------------------------------------------------

function leakedEffectResource(body: Node, checker: CheckerAdapter): Leak | undefined {
  let leak: Leak | undefined;
  walkSkippingFunctions(body, (node: Node) => {
    leak ??= leakOfNode(node, checker);
  });
  return leak;
}

function leakOfNode(node: Node, checker: CheckerAdapter): Leak | undefined {
  if (ts.isNewExpression(node)) return leakOfConstructor(node, checker);
  if (!ts.isCallExpression(node)) return;
  const name = calleeName(node);
  if (name === 'setInterval' && isBrowserGlobal(node.expression, checker)) return { label: 'setInterval()' };
  const callee = ts.skipOuterExpressions(node.expression);
  if (
    name === 'addEventListener' &&
    ts.isPropertyAccessExpression(callee) &&
    isGlobalEventTarget(callee.expression, checker)
  ) {
    return { label: 'addEventListener()' };
  }
  const kind = unmanagedSubscription(node, checker);
  if (kind) return { label: 'subscribe()', reason: kind === 'unknown' ? SUBSCRIBE_MAY_COMPLETE_REASON : undefined };
}

function leakOfConstructor(node: NewExpression, checker: CheckerAdapter): Leak | undefined {
  if (!ts.isIdentifier(node.expression) || !isBrowserGlobal(node.expression, checker)) return;
  const name = node.expression.text;
  if (DEFINITE_LEAK_CONSTRUCTORS.has(name)) return { label: `new ${name}()` };
  if (OBSERVER_CONSTRUCTORS.has(name)) return { label: `new ${name}()`, reason: OBSERVER_REASON };
}

function findFetchWithoutAbort(body: Node, checker: CheckerAdapter): CallExpression | undefined {
  let fetchCall: CallExpression | undefined;
  let hasAbort = false;
  walkAll(body, (node: Node) => {
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'AbortController') {
      hasAbort = true;
    } else if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'fetch') {
      if (isBrowserGlobal(node.expression, checker) && !passesSignal(node)) fetchCall ??= node;
    }
  });
  return hasAbort ? undefined : fetchCall;
}

function passesSignal(fetchCall: CallExpression): boolean {
  const options = fetchCall.arguments[1] && ts.skipOuterExpressions(fetchCall.arguments[1]);
  return Boolean(
    options && ts.isObjectLiteralExpression(options) && options.properties.some((p) => propertyName(p) === 'signal'),
  );
}

function hasNonEmptyDependencies(effectCall: CallExpression): boolean {
  const dependencies = effectCall.arguments[1] && ts.skipOuterExpressions(effectCall.arguments[1]);
  if (!dependencies) return true;
  return !ts.isArrayLiteralExpression(dependencies) || dependencies.elements.length > 0;
}

function isFireAndForgetMutation(fetchCall: CallExpression): boolean {
  const options = fetchCall.arguments[1] && ts.skipOuterExpressions(fetchCall.arguments[1]);
  if (!options || !ts.isObjectLiteralExpression(options)) return false;
  const isMutation = options.properties.some(
    (p) =>
      ts.isPropertyAssignment(p) &&
      propertyName(p) === 'method' &&
      ts.isStringLiteralLike(p.initializer) &&
      /^(?:POST|PUT|PATCH|DELETE)$/i.test(p.initializer.text),
  );
  if (!isMutation) return false;
  const parent = fetchCall.parent;
  if (ts.isVoidExpression(parent) || ts.isExpressionStatement(parent)) return true;
  if (
    ts.isPropertyAccessExpression(parent) &&
    parent.name.text === 'catch' &&
    ts.isCallExpression(parent.parent) &&
    ts.isExpressionStatement(parent.parent.parent)
  ) {
    return true;
  }
  return false;
}

function checkReactEffect(call: CallExpression, context: PerformanceRuleContext) {
  const effect = effectCallback(call, context.checker);
  if (!effect || containsReturnValue(effect.body)) return;
  const leak = leakedEffectResource(effect.body, context.checker);
  if (leak) {
    context.report(
      call,
      'react-missing-cleanup',
      `\`${effect.hook}\` allocates \`${leak.label}\` without returning a cleanup function, leaking listeners, timers, or subscriptions across remounts. Return a cleanup callback that disposes it.`,
      leak.reason,
    );
  }
  const fetchCall = findFetchWithoutAbort(effect.body, context.checker);
  if (!fetchCall) return;
  const reason = isFireAndForgetMutation(fetchCall)
    ? 'Fire-and-forget mutating request whose response is unused.'
    : hasNonEmptyDependencies(call)
      ? undefined
      : FETCH_STATIC_DEPS_REASON;
  context.report(
    fetchCall,
    'react-fetch-in-effect-no-abort',
    `\`fetch()\` inside \`${effect.hook}\` has no \`AbortController\` cleanup, so fast navigation or dependency changes can trigger race conditions and stale state updates. Pass \`signal: controller.signal\` and call \`controller.abort()\` in the cleanup function.`,
    reason,
  );
}

function isArrayMapCall(call: CallExpression, checker: CheckerAdapter) {
  const callee = ts.skipOuterExpressions(call.expression);
  if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== 'map') return false;
  const type = checker.getNonNullableType(checker.getTypeAtLocation(callee.expression));
  const name = type.getSymbol()?.name;
  return name === 'Array' || name === 'ReadonlyArray';
}

function mapCallback(call: CallExpression) {
  const callback = call.arguments[0] && ts.skipOuterExpressions(call.arguments[0]);
  return callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) ? callback : undefined;
}

// A list written out in the source never changes order, so index keys or missing keys cost nothing
// there.
function isStaticList(call: CallExpression, checker: CheckerAdapter): boolean {
  const callee = ts.skipOuterExpressions(call.expression);
  if (!ts.isPropertyAccessExpression(callee) && !ts.isElementAccessExpression(callee)) return false;
  const receiver = callee.expression;
  const target = ts.skipOuterExpressions(receiver);
  if (ts.isArrayLiteralExpression(target)) return true;
  const initializer = ts.isIdentifier(target) ? initializerOf(target, checker) : undefined;
  return initializer !== undefined && ts.isArrayLiteralExpression(ts.skipOuterExpressions(initializer));
}

// The expressions a callback returns, which are the list items it renders.
function returnedExpressions(callback: ArrowFunction | FunctionExpression): Expression[] {
  if (!ts.isBlock(callback.body)) return [ts.skipOuterExpressions(callback.body)];
  const returned: Expression[] = [];
  walkSkippingFunctions(callback.body, (node: Node) => {
    if (ts.isReturnStatement(node) && node.expression) returned.push(ts.skipOuterExpressions(node.expression));
  });
  return returned;
}

function jsxAttributesOf(element: Expression): readonly JsxAttributeLike[] {
  if (ts.isJsxSelfClosingElement(element)) return element.attributes.properties;
  return ts.isJsxElement(element) ? element.openingElement.attributes.properties : [];
}

function indexKeyAttribute(element: Expression, indexName: string): JsxAttributeLike | undefined {
  return jsxAttributesOf(element).find((attribute) => {
    if (!ts.isJsxAttribute(attribute) || !ts.isIdentifier(attribute.name) || attribute.name.text !== 'key')
      return false;
    const value = attribute.initializer;
    const expression =
      value && ts.isJsxExpression(value) && value.expression && ts.skipOuterExpressions(value.expression);
    return Boolean(expression && ts.isIdentifier(expression) && expression.text === indexName);
  });
}

function checkReactIndexKey(call: CallExpression, context: PerformanceRuleContext) {
  if (!isArrayMapCall(call, context.checker)) return;
  const callback = mapCallback(call);
  const indexParameter = callback?.parameters[1]?.name;
  if (!indexParameter || !ts.isIdentifier(indexParameter)) return;
  if (isStaticList(call, context.checker)) return;
  for (const item of returnedExpressions(callback)) {
    const attribute = indexKeyAttribute(item, indexParameter.text);
    if (!attribute) continue;
    context.report(
      attribute,
      'react-index-as-key',
      `Using the array index \`${indexParameter.text}\` as a React JSX \`key\` breaks reconciliation and component state when items are inserted, deleted, or reordered. Use a stable unique identifier from the item instead.`,
      INDEX_KEY_REASON,
    );
  }
}

// A fresh object only defeats React.memo when the child is memoised, so the tag must resolve to a
// memo() call.
function isMemoComponent(tagName: JsxTagNameExpression, checker: CheckerAdapter) {
  if (!ts.isIdentifier(tagName)) return false;
  const initializer = initializerOf(tagName, checker);
  return (
    initializer !== undefined &&
    ts.isCallExpression(initializer) &&
    importedName(initializer.expression, checker, REACT_MODULES) === 'memo'
  );
}

function checkInlineObjectProps(element: JsxOpeningLikeElement, context: PerformanceRuleContext) {
  const tagName = element.tagName;
  if (!ts.isIdentifier(tagName) || !isMemoComponent(tagName, context.checker)) return;
  for (const attribute of element.attributes.properties) {
    const value = ts.isJsxAttribute(attribute) && attribute.initializer;
    const expression =
      value && ts.isJsxExpression(value) && value.expression && ts.skipOuterExpressions(value.expression);
    if (!expression || !ts.isObjectLiteralExpression(expression)) continue;
    context.report(
      attribute,
      'react-inline-object-in-jsx-prop',
      `Passing an inline object literal to \`<${tagName.text} ${attribute.name.getText()}={{ ... }}>\` creates a new reference on every render, defeating the \`memo()\` wrapper of the child. Hoist static objects to module scope or memoise with \`useMemo\`.`,
      INLINE_OBJECT_REASON,
    );
  }
}

// --- Angular
// -------------------------------------------------------------------------------------------------

function isAngularComponentOrDirective(classNode: ClassDeclaration, checker: CheckerAdapter) {
  const decorators = ts.canHaveDecorators(classNode) ? (ts.getDecorators(classNode) ?? []) : [];
  return decorators.some((decorator: Decorator) => {
    if (!ts.isCallExpression(decorator.expression)) return false;
    const name = importedName(decorator.expression.expression, checker, ANGULAR_MODULES);
    return name === 'Component' || name === 'Directive';
  });
}

function componentMetadata(
  classNode: ClassDeclaration,
  checker: CheckerAdapter,
): { decorator: Decorator; metadata: ObjectLiteralExpression } | undefined {
  const decorators = ts.canHaveDecorators(classNode) ? (ts.getDecorators(classNode) ?? []) : [];
  for (const decorator of decorators) {
    const call = decorator.expression;
    if (!ts.isCallExpression(call) || importedName(call.expression, checker, ANGULAR_MODULES) !== 'Component') continue;
    const metadata = call.arguments[0] && ts.skipOuterExpressions(call.arguments[0]);
    if (metadata && ts.isObjectLiteralExpression(metadata)) return { decorator, metadata };
  }
}

// Zoneless apps do not re-check on every browser event, so OnPush buys little there.
function mentionsZonelessProvider(sourceFile: SourceFile) {
  return sourceFile.text.includes('ZonelessChangeDetection');
}

function checkAngularChangeDetection(classNode: ClassDeclaration, context: PerformanceRuleContext) {
  const component = componentMetadata(classNode, context.checker);
  if (!component || mentionsZonelessProvider(classNode.getSourceFile())) return;
  if (component.metadata.properties.some((property) => propertyName(property) === 'changeDetection')) return;
  context.report(
    component.decorator,
    'angular-default-change-detection',
    'This Angular `@Component` uses the default change detection strategy, re-checking the entire component subtree on every browser event. Set `changeDetection: ChangeDetectionStrategy.OnPush` where inputs are immutable or driven by observables/signals.',
    ON_PUSH_REASON,
  );
}

function destroyHookReleases(classNode: ClassDeclaration): boolean {
  const hook = classNode.members.find(
    (member): member is MethodDeclaration =>
      ts.isMethodDeclaration(member) && ts.isIdentifier(member.name) && member.name.text === 'ngOnDestroy',
  );
  if (!hook?.body) return false;
  let releases = false;
  walkAll(hook.body, (node: Node) => {
    if (ts.isCallExpression(node)) {
      const name = calleeName(node);
      if (name !== undefined && ['unsubscribe', 'next', 'complete'].includes(name)) releases = true;
    }
  });
  return releases;
}

function checkAngularClass(classNode: ClassDeclaration, context: PerformanceRuleContext) {
  checkAngularChangeDetection(classNode, context);
  if (!isAngularComponentOrDirective(classNode, context.checker)) return;
  if (destroyHookReleases(classNode)) return;
  walkAll(classNode, (node: Node) => {
    if (!ts.isCallExpression(node)) return;
    const kind = unmanagedSubscription(node, context.checker);
    if (!kind) return;
    context.report(
      node,
      'angular-subscribe-without-cleanup',
      'This RxJS `.subscribe()` inside an Angular component/directive has no `takeUntil` / `takeUntilDestroyed` operator and no `ngOnDestroy` unsubscribe, leaking memory and running callbacks after the component is destroyed. Prefer the `async` pipe, `toSignal()`, or `takeUntilDestroyed()`.',
      kind === 'unknown' ? SUBSCRIBE_MAY_COMPLETE_REASON : undefined,
    );
  });
}

// --- Vue
// -----------------------------------------------------------------------------------------------------

function enclosingScope(node: Node) {
  let current = node.parent;
  while (current && !ts.isFunctionLike(current) && !ts.isSourceFile(current)) current = current.parent;
  return current;
}

function scopeRegistersUnmount(scope: Node | undefined, checker: CheckerAdapter): boolean {
  if (!scope) return false;
  let registers = false;
  walkAll(scope, (node: Node) => {
    if (!ts.isCallExpression(node)) return;
    const name = importedName(node.expression, checker, VUE_MODULES);
    if (name === 'onUnmounted' || name === 'onBeforeUnmount' || name === 'onScopeDispose') registers = true;
  });
  return registers;
}

function vueLeakInCallback(callback: Node, checker: CheckerAdapter): Leak | undefined {
  let leak: Leak | undefined;
  walkAll(callback, (node: Node) => {
    leak ??= leakOfNode(node, checker);
  });
  return leak;
}

function checkVueMounted(call: CallExpression, context: PerformanceRuleContext) {
  if (!isVueImport(call.expression, context.checker, 'onMounted')) return;
  const callback = call.arguments[0] && ts.skipOuterExpressions(call.arguments[0]);
  if (!callback || !ts.isFunctionLike(callback)) return;
  if (scopeRegistersUnmount(enclosingScope(call), context.checker)) return;
  const leak = vueLeakInCallback(callback, context.checker);
  if (!leak) return;
  context.report(
    call,
    'vue-watch-missing-cleanup',
    `\`onMounted\` registers \`${leak.label}\` without a matching \`onUnmounted\` / \`onBeforeUnmount\` cleanup, leaking resources when the Vue component unmounts.`,
    leak.reason,
  );
}

function hasKeyProperty(propsArgument: Expression): boolean {
  const props = ts.skipOuterExpressions(propsArgument);
  if (!ts.isObjectLiteralExpression(props)) return false;
  return props.properties.some((property) => ts.isSpreadAssignment(property) || propertyName(property) === 'key');
}

// A props argument that is a variable could hold a key, so only a missing or literal props object
// counts.
function lacksKnownKey(hCall: CallExpression, checker: CheckerAdapter) {
  const propsArgument = hCall.arguments[1];
  if (!propsArgument) return true;
  const props = ts.skipOuterExpressions(propsArgument);
  const isReference = ts.isIdentifier(props) || ts.isCallExpression(props) || ts.isPropertyAccessExpression(props);
  if (isReference) return isChildrenArgument(props, checker);
  return !hasKeyProperty(propsArgument);
}

// `h('li', row)` passes text or an array as the second argument, which Vue reads as children rather
// than props.
function isChildrenArgument(expression: Expression, checker: CheckerAdapter) {
  const type = checker.getNonNullableType(checker.getTypeAtLocation(expression));
  return Boolean(type.flags & (ts.TypeFlags.StringLike | ts.TypeFlags.NumberLike)) || checker.isArrayType?.(type);
}

function checkVueListKey(call: CallExpression, context: PerformanceRuleContext) {
  if (!isArrayMapCall(call, context.checker) || isStaticList(call, context.checker)) return;
  const callback = mapCallback(call);
  if (!callback) return;
  for (const item of returnedExpressions(callback)) {
    if (!ts.isCallExpression(item) || !isVueImport(item.expression, context.checker, 'h')) continue;
    if (!lacksKnownKey(item, context.checker)) continue;
    context.report(
      item,
      'vue-v-for-missing-key',
      'Vue `h()` render list item is missing a stable `key` prop, forcing inefficient DOM patching when list items change. Pass `{ key: item.id }` in the props object.',
    );
  }
}

function checkCall(call: CallExpression, context: PerformanceRuleContext) {
  checkReactEffect(call, context);
  checkReactIndexKey(call, context);
  checkVueMounted(call, context);
  checkVueListKey(call, context);
  checkAddEventListener(call, context);
}

function checkFrontendNode(node: Node, context: PerformanceRuleContext) {
  if (ts.isImportDeclaration(node)) checkHeavyBarrelImport(node, context);
  else if (ts.isCallExpression(node)) checkCall(node, context);
  else if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) checkInlineObjectProps(node, context);
  else if (ts.isClassDeclaration(node)) checkAngularClass(node, context);
  else if (isLoop(node)) checkLayoutThrashing(node, context);
}

// Called once per source file; every rule needs `context.checker` and `context.report`.
function checkFrontendFile(sourceFile: SourceFile, context: PerformanceRuleContext) {
  if (isTestSource(sourceFile.fileName)) return;
  walkAll(sourceFile, (node: Node) => checkFrontendNode(node, context));
}

export { checkFrontendFile, checkFrontendNode };
