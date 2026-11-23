'use strict';

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
const { syntax: ts } = require('./compiler.cjs');
const { isTestSource } = require('./review-context.cjs');
const { declaredInPackage, initializerOf, packageOf, propertyName } = require('./schema/ts-helpers.cjs');
const {
  checkAddEventListener,
  checkHeavyBarrelImport,
  checkLayoutThrashing,
  isLoop,
} = require('./frontend-dom-perf.cjs');
const {
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
} = require('./frontend-helpers.cjs');

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

// --- RxJS subscriptions -------------------------------------------------------------------------------------

// `source.pipe(a(), b()).asObservable()` -> the source expression plus the imported operator names applied to it.
function unwrapPipes(expression, checker) {
  const operatorNames = [];
  let source = ts.skipOuterExpressions(expression);
  while (ts.isCallExpression(source) && ts.isPropertyAccessExpression(source.expression)) {
    const method = source.expression.name.text;
    if (method === 'pipe') operatorNames.push(...importedOperatorNames(source.arguments, checker));
    else if (method !== 'asObservable') break;
    source = ts.skipOuterExpressions(source.expression.expression);
  }
  return { source, operatorNames };
}

function importedOperatorNames(pipeArguments, checker) {
  const names = [];
  for (const argument of pipeArguments) {
    const operator = ts.skipOuterExpressions(argument);
    const name = ts.isCallExpression(operator) && importedName(operator.expression, checker, RXJS_OPERATOR_MODULES);
    if (name) names.push(name);
  }
  return names;
}

function isRxjsSubject(source, checker) {
  const symbol = checker.getTypeAtLocation(source).getSymbol();
  if (!symbol || !symbol.name.endsWith('Subject')) return false;
  return symbol.declarations.every((declaration) => packageOf(declaration) === 'rxjs');
}

function isEndlessCreator(callee, checker) {
  const name = importedName(callee, checker, ['rxjs']);
  return Boolean(name) && ENDLESS_RXJS_CREATORS.has(name);
}

// 'completing' sources finish after one response (HttpClient); 'endless' ones keep emitting until unsubscribed.
function classifySource(source, checker) {
  if (ts.isCallExpression(source)) {
    if (isEndlessCreator(source.expression, checker)) return 'endless';
    if (declaredInPackage(source.expression, checker, COMPLETING_PACKAGES)) return 'completing';
    if (declaredInPackage(source.expression, checker, ENDLESS_PACKAGES)) return 'endless';
    return 'unknown';
  }
  if (isRxjsSubject(source, checker) || declaredInPackage(source, checker, ENDLESS_PACKAGES)) return 'endless';
  return 'unknown';
}

// undefined: not an RxJS subscription, or one that ends on its own. Otherwise 'endless' or 'unknown'.
function unmanagedSubscription(call, checker) {
  const callee = ts.skipOuterExpressions(call.expression);
  if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== 'subscribe') return;
  if (!declaredInPackage(callee, checker, ['rxjs'])) return;
  const { source, operatorNames } = unwrapPipes(callee.expression, checker);
  if (operatorNames.some((name) => COMPLETING_OPERATORS.has(name))) return;
  const kind = classifySource(source, checker);
  return kind === 'completing' ? undefined : kind;
}

// --- React ---------------------------------------------------------------------------------------------------

function leakedEffectResource(body, checker) {
  let leak;
  walkSkippingFunctions(body, (node) => {
    leak ??= leakOfNode(node, checker);
  });
  return leak;
}

function leakOfNode(node, checker) {
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

function leakOfConstructor(node, checker) {
  if (!ts.isIdentifier(node.expression) || !isBrowserGlobal(node.expression, checker)) return;
  const name = node.expression.text;
  if (DEFINITE_LEAK_CONSTRUCTORS.has(name)) return { label: `new ${name}()` };
  if (OBSERVER_CONSTRUCTORS.has(name)) return { label: `new ${name}()`, reason: OBSERVER_REASON };
}

function findFetchWithoutAbort(body, checker) {
  let fetchCall;
  let hasAbort = false;
  walkAll(body, (node) => {
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'AbortController') {
      hasAbort = true;
    } else if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'fetch') {
      if (isBrowserGlobal(node.expression, checker) && !passesSignal(node)) fetchCall ??= node;
    }
  });
  return hasAbort ? undefined : fetchCall;
}

function passesSignal(fetchCall) {
  const options = fetchCall.arguments[1] && ts.skipOuterExpressions(fetchCall.arguments[1]);
  return Boolean(
    options && ts.isObjectLiteralExpression(options) && options.properties.some((p) => propertyName(p) === 'signal'),
  );
}

function hasNonEmptyDependencies(effectCall) {
  const dependencies = effectCall.arguments[1] && ts.skipOuterExpressions(effectCall.arguments[1]);
  if (!dependencies) return true;
  return !ts.isArrayLiteralExpression(dependencies) || dependencies.elements.length > 0;
}

function checkReactEffect(call, context) {
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
  context.report(
    fetchCall,
    'react-fetch-in-effect-no-abort',
    `\`fetch()\` inside \`${effect.hook}\` has no \`AbortController\` cleanup, so fast navigation or dependency changes can trigger race conditions and stale state updates. Pass \`signal: controller.signal\` and call \`controller.abort()\` in the cleanup function.`,
    hasNonEmptyDependencies(call) ? undefined : FETCH_STATIC_DEPS_REASON,
  );
}

function isArrayMapCall(call, checker) {
  const callee = ts.skipOuterExpressions(call.expression);
  if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== 'map') return false;
  const type = checker.getNonNullableType(checker.getTypeAtLocation(callee.expression));
  const name = type.getSymbol()?.name;
  return name === 'Array' || name === 'ReadonlyArray';
}

function mapCallback(call) {
  const callback = call.arguments[0] && ts.skipOuterExpressions(call.arguments[0]);
  return callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) ? callback : undefined;
}

// A list written out in the source never changes order, so index keys or missing keys cost nothing there.
function isStaticList(call, checker) {
  const receiver = ts.skipOuterExpressions(call.expression).expression;
  const target = ts.skipOuterExpressions(receiver);
  if (ts.isArrayLiteralExpression(target)) return true;
  const initializer = ts.isIdentifier(target) ? initializerOf(target, checker) : undefined;
  return Boolean(initializer) && ts.isArrayLiteralExpression(ts.skipOuterExpressions(initializer));
}

// The expressions a callback returns, which are the list items it renders.
function returnedExpressions(callback) {
  if (!ts.isBlock(callback.body)) return [ts.skipOuterExpressions(callback.body)];
  const returned = [];
  walkSkippingFunctions(callback.body, (node) => {
    if (ts.isReturnStatement(node) && node.expression) returned.push(ts.skipOuterExpressions(node.expression));
  });
  return returned;
}

function jsxAttributesOf(element) {
  if (ts.isJsxSelfClosingElement(element)) return element.attributes.properties;
  return ts.isJsxElement(element) ? element.openingElement.attributes.properties : [];
}

function indexKeyAttribute(element, indexName) {
  return jsxAttributesOf(element).find((attribute) => {
    if (!ts.isJsxAttribute(attribute) || !ts.isIdentifier(attribute.name) || attribute.name.text !== 'key')
      return false;
    const value = attribute.initializer;
    const expression =
      value && ts.isJsxExpression(value) && value.expression && ts.skipOuterExpressions(value.expression);
    return Boolean(expression) && ts.isIdentifier(expression) && expression.text === indexName;
  });
}

function checkReactIndexKey(call, context) {
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

// A fresh object only defeats React.memo when the child is memoised, so the tag must resolve to a memo() call.
function isMemoComponent(tagName, checker) {
  if (!ts.isIdentifier(tagName)) return false;
  const initializer = initializerOf(tagName, checker);
  return (
    Boolean(initializer) &&
    ts.isCallExpression(initializer) &&
    importedName(initializer.expression, checker, REACT_MODULES) === 'memo'
  );
}

function checkInlineObjectProps(element, context) {
  if (!isMemoComponent(element.tagName, context.checker)) return;
  for (const attribute of element.attributes.properties) {
    const value = ts.isJsxAttribute(attribute) && attribute.initializer;
    const expression =
      value && ts.isJsxExpression(value) && value.expression && ts.skipOuterExpressions(value.expression);
    if (!expression || !ts.isObjectLiteralExpression(expression)) continue;
    context.report(
      attribute,
      'react-inline-object-in-jsx-prop',
      `Passing an inline object literal to \`<${element.tagName.text} ${attribute.name.getText()}={{ ... }}>\` creates a new reference on every render, defeating the \`memo()\` wrapper of the child. Hoist static objects to module scope or memoise with \`useMemo\`.`,
      INLINE_OBJECT_REASON,
    );
  }
}

// --- Angular -------------------------------------------------------------------------------------------------

function isAngularComponentOrDirective(classNode, checker) {
  const decorators = ts.canHaveDecorators(classNode) ? (ts.getDecorators(classNode) ?? []) : [];
  return decorators.some((decorator) => {
    if (!ts.isCallExpression(decorator.expression)) return false;
    const name = importedName(decorator.expression.expression, checker, ANGULAR_MODULES);
    return name === 'Component' || name === 'Directive';
  });
}

function componentMetadata(classNode, checker) {
  const decorators = ts.canHaveDecorators(classNode) ? (ts.getDecorators(classNode) ?? []) : [];
  for (const decorator of decorators) {
    const call = decorator.expression;
    if (!ts.isCallExpression(call) || importedName(call.expression, checker, ANGULAR_MODULES) !== 'Component') continue;
    const metadata = call.arguments[0] && ts.skipOuterExpressions(call.arguments[0]);
    if (metadata && ts.isObjectLiteralExpression(metadata)) return { decorator, metadata };
  }
}

// Zoneless apps do not re-check on every browser event, so OnPush buys little there.
function mentionsZonelessProvider(sourceFile) {
  return sourceFile.text.includes('ZonelessChangeDetection');
}

function checkAngularChangeDetection(classNode, context) {
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

function destroyHookReleases(classNode) {
  const hook = classNode.members.find(
    (member) => ts.isMethodDeclaration(member) && ts.isIdentifier(member.name) && member.name.text === 'ngOnDestroy',
  );
  if (!hook?.body) return false;
  let releases = false;
  walkAll(hook.body, (node) => {
    if (ts.isCallExpression(node) && ['unsubscribe', 'next', 'complete'].includes(calleeName(node))) releases = true;
  });
  return releases;
}

function checkAngularClass(classNode, context) {
  checkAngularChangeDetection(classNode, context);
  if (!isAngularComponentOrDirective(classNode, context.checker)) return;
  if (destroyHookReleases(classNode)) return;
  walkAll(classNode, (node) => {
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

// --- Vue -----------------------------------------------------------------------------------------------------

function enclosingScope(node) {
  let current = node.parent;
  while (current && !ts.isFunctionLike(current) && !ts.isSourceFile(current)) current = current.parent;
  return current;
}

function scopeRegistersUnmount(scope, checker) {
  let registers = false;
  walkAll(scope, (node) => {
    if (!ts.isCallExpression(node)) return;
    const name = importedName(node.expression, checker, VUE_MODULES);
    if (name === 'onUnmounted' || name === 'onBeforeUnmount' || name === 'onScopeDispose') registers = true;
  });
  return registers;
}

function vueLeakInCallback(callback, checker) {
  let leak;
  walkAll(callback, (node) => {
    leak ??= leakOfNode(node, checker);
  });
  return leak;
}

function checkVueMounted(call, context) {
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

function hasKeyProperty(propsArgument) {
  const props = ts.skipOuterExpressions(propsArgument);
  if (!ts.isObjectLiteralExpression(props)) return false;
  return props.properties.some((property) => ts.isSpreadAssignment(property) || propertyName(property) === 'key');
}

// A props argument that is a variable could hold a key, so only a missing or literal props object counts.
function lacksKnownKey(hCall, checker) {
  const propsArgument = hCall.arguments[1];
  if (!propsArgument) return true;
  const props = ts.skipOuterExpressions(propsArgument);
  const isReference = ts.isIdentifier(props) || ts.isCallExpression(props) || ts.isPropertyAccessExpression(props);
  if (isReference) return isChildrenArgument(props, checker);
  return !hasKeyProperty(propsArgument);
}

// `h('li', row)` passes text or an array as the second argument, which Vue reads as children rather than props.
function isChildrenArgument(expression, checker) {
  const type = checker.getNonNullableType(checker.getTypeAtLocation(expression));
  return Boolean(type.flags & (ts.TypeFlags.StringLike | ts.TypeFlags.NumberLike)) || checker.isArrayType?.(type);
}

function checkVueListKey(call, context) {
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

function checkCall(call, context) {
  checkReactEffect(call, context);
  checkReactIndexKey(call, context);
  checkVueMounted(call, context);
  checkVueListKey(call, context);
  checkAddEventListener(call, context);
}

function checkNode(node, context) {
  if (ts.isImportDeclaration(node)) checkHeavyBarrelImport(node, context);
  else if (ts.isCallExpression(node)) checkCall(node, context);
  else if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) checkInlineObjectProps(node, context);
  else if (ts.isClassDeclaration(node)) checkAngularClass(node, context);
  else if (isLoop(node)) checkLayoutThrashing(node, context);
}

// Called once per source file; every rule needs `context.checker` and `context.report`.
function checkFrontendFile(sourceFile, context) {
  if (isTestSource(sourceFile.fileName)) return;
  walkAll(sourceFile, (node) => checkNode(node, context));
}

module.exports = { checkFrontendFile };
