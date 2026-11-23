'use strict';

// DOM and bundle-size performance rules for browser code:
// - dom-layout-thrashing
// - dom-listener-without-cleanup
// - dom-unthrottled-scroll-resize
// - frontend-barrel-heavy-import
// Every rule rests on the lib.dom declaration behind a name (or on the import it comes from), never on the name alone.
const { syntax: ts } = require('./compiler.cjs');
const { initializerOf, objectProperty, resolvedSymbol } = require('./schema/ts-helpers.cjs');
const {
  ANGULAR_MODULES,
  REACT_EFFECTS,
  REACT_MODULES,
  VUE_MODULES,
  calleeName,
  declaredInDomLibrary,
  domSymbolOf,
  importedName,
  isBrowserGlobal,
  isGlobalEventTarget,
  isVueImport,
  ownerNameOf,
  walkAll,
  walkSkippingFunctions,
} = require('./frontend-helpers.cjs');

const CLIENT_FRAMEWORK_MODULES = new Set([...REACT_MODULES, ...VUE_MODULES, ...ANGULAR_MODULES, 'svelte', 'solid-js']);

const HEAVY_CLIENT_BARRELS = new Map([
  ['lodash', "Import individual functions (e.g. `import debounce from 'lodash/debounce'`) or use `lodash-es`."],
  ['moment', 'Switch to `date-fns`, `dayjs`, or native `Intl.DateTimeFormat` to avoid shipping all locales.'],
]);

const FONTAWESOME_ICON_PACKAGE = /^@fortawesome\/[^/]+-svg-icons$/;
const FONTAWESOME_NAMESPACE_ADVICE =
  'Import icons by name; a namespace import with dynamic lookups keeps every icon in the bundle.';
const MUI_ICONS_ROOT = '@mui/icons-material';
const MUI_ICONS_ADVICE = "Use path imports (e.g. `import Delete from '@mui/icons-material/Delete'`).";
const MUI_ICONS_NAMED_REASON =
  'Dev builds and some bundler setups load every icon module behind the root import, so prefer path imports.';

const HIGH_FREQ_EVENTS = new Set(['scroll', 'resize', 'mousemove', 'wheel', 'touchmove', 'touchstart']);
const BLOCKING_TOUCH_EVENTS = new Set(['wheel', 'touchmove', 'touchstart']);
const LAYOUT_READ_PROPS = new Set([
  'offsetTop',
  'offsetLeft',
  'offsetWidth',
  'offsetHeight',
  'clientTop',
  'clientLeft',
  'clientWidth',
  'clientHeight',
  'scrollTop',
  'scrollLeft',
  'scrollWidth',
  'scrollHeight',
]);
const COMPUTED_STYLE_GEOMETRY_PROP =
  /^(?:width|height|top|left|right|bottom|transform|margin(?:Top|Right|Bottom|Left)?|padding(?:Top|Right|Bottom|Left)?|border(?:Top|Right|Bottom|Left)?Width)$/;
const LAYOUT_READ_METHODS = new Set(['getBoundingClientRect', 'getClientRects']);
const DOM_WRITE_METHODS = new Set([
  'setAttribute',
  'add',
  'remove',
  'toggle',
  'replace',
  'appendChild',
  'insertBefore',
  'removeChild',
  'append',
  'prepend',
]);
// Newer lib.dom versions declare style properties on CSSStyleProperties instead of CSSStyleDeclaration.
const CSS_STYLE_OWNER = /^CSSStyle(?:Declaration|Properties)$/;
const DOM_WRITE_PROPS = new Set(['className', 'innerHTML', 'textContent']);
// Location.replace navigates away and is not a DOM mutation, so methods only count on these owners.
const DOM_MUTATION_OWNERS = new Set(['Element', 'Node', 'DOMTokenList', 'ChildNode', 'ParentNode']);
const SCHEDULING_CALLS = new Set(['requestAnimationFrame', 'setTimeout', 'clearTimeout']);

const LISTENER_REASON =
  'Fine when this runs once for the lifetime of the app (bootstrap code); a leak when the function runs per component or per navigation.';
const CHEAP_HANDLER_REASON =
  'The handler measures no layout, so it may be cheap enough to run on every event; dismiss it if it is.';
const UNKNOWN_HANDLER_REASON = 'The handler body is not visible here, so its cost could not be judged.';
const LODASH_NAMED_REASON =
  'A build-time plugin (babel-plugin-lodash, lodash-webpack-plugin) can rewrite named imports.';

// --- DOM -----------------------------------------------------------------------------------------------------

function isComputedStyleCall(node, checker) {
  const call = ts.skipOuterExpressions(node);
  return (
    ts.isCallExpression(call) && calleeName(call) === 'getComputedStyle' && isBrowserGlobal(call.expression, checker)
  );
}

// `getComputedStyle(el).width` and `getComputedStyle(el).getPropertyValue(...)`; the bare call reads nothing.
function computedStyleReadOf(node, checker) {
  if (ts.isPropertyAccessExpression(node)) {
    const isGeometry = COMPUTED_STYLE_GEOMETRY_PROP.test(node.name.text);
    return isGeometry && isComputedStyleCall(node.expression, checker) ? node : undefined;
  }
  const callee = ts.isCallExpression(node) && ts.skipOuterExpressions(node.expression);
  const isValueLookup = callee && ts.isPropertyAccessExpression(callee) && callee.name.text === 'getPropertyValue';
  return isValueLookup && isComputedStyleCall(callee.expression, checker) ? node : undefined;
}

function layoutReadOf(node, checker) {
  const computedStyleRead = computedStyleReadOf(node, checker);
  if (computedStyleRead) return computedStyleRead;
  if (ts.isPropertyAccessExpression(node) && LAYOUT_READ_PROPS.has(node.name.text)) {
    return declaredInDomLibrary(domSymbolOf(node, checker)) ? node : undefined;
  }
  const callee = ts.isCallExpression(node) && ts.skipOuterExpressions(node.expression);
  const isLayoutMethod = callee && ts.isPropertyAccessExpression(callee) && LAYOUT_READ_METHODS.has(callee.name.text);
  return isLayoutMethod && declaredInDomLibrary(domSymbolOf(callee, checker)) ? node : undefined;
}

function isDomWrite(node, checker) {
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
    const target = ts.skipOuterExpressions(node.left);
    if (!ts.isPropertyAccessExpression(target)) return false;
    const symbol = domSymbolOf(target, checker);
    return (
      declaredInDomLibrary(symbol) &&
      (CSS_STYLE_OWNER.test(ownerNameOf(symbol) ?? '') || DOM_WRITE_PROPS.has(target.name.text))
    );
  }
  const callee = ts.isCallExpression(node) && ts.skipOuterExpressions(node.expression);
  if (!callee || !ts.isPropertyAccessExpression(callee) || !DOM_WRITE_METHODS.has(callee.name.text)) return false;
  const symbol = domSymbolOf(callee, checker);
  return declaredInDomLibrary(symbol) && DOM_MUTATION_OWNERS.has(ownerNameOf(symbol));
}

function isLoop(node) {
  return ts.isForStatement(node) || ts.isForOfStatement(node) || ts.isForInStatement(node) || ts.isWhileStatement(node);
}

// The outer loop's walk already covers inner loops, so reporting both would duplicate the finding.
function hasEnclosingLoop(loopNode) {
  for (let current = loopNode.parent; current && !ts.isFunctionLike(current); current = current.parent) {
    if (isLoop(current)) return true;
  }
  return false;
}

function checkLayoutThrashing(loopNode, context) {
  if (hasEnclosingLoop(loopNode)) return;
  let layoutRead;
  let domWrite = false;
  walkSkippingFunctions(loopNode.statement, (node) => {
    layoutRead ??= layoutReadOf(node, context.checker);
    domWrite ||= isDomWrite(node, context.checker);
  });
  if (!layoutRead || !domWrite) return;
  context.report(
    layoutRead,
    'dom-layout-thrashing',
    `Reading layout metric \`${layoutRead.getText()}\` inside a loop that also mutates DOM styles/classes forces synchronous layout recalculation (reflow) on every iteration. Batch all DOM reads before DOM writes.`,
  );
}

function optionsOf(call) {
  const options = call.arguments[2] && ts.skipOuterExpressions(call.arguments[2]);
  return options && ts.isObjectLiteralExpression(options) ? options : undefined;
}

function isPassive(call) {
  return objectProperty(optionsOf(call), 'passive')?.kind === ts.SyntaxKind.TrueKeyword;
}

// The function a handler expression runs, 'wrapped' when it is already a debounce/throttle call, else undefined.
function resolveHandler(handler, checker) {
  const target = ts.skipOuterExpressions(handler);
  if (ts.isArrowFunction(target) || ts.isFunctionExpression(target)) return target;
  if (ts.isCallExpression(target)) return 'wrapped';
  if (!ts.isIdentifier(target)) return;
  const initializer = initializerOf(target, checker);
  if (initializer) return ts.isCallExpression(initializer) ? 'wrapped' : functionOrUndefined(initializer);
  return functionOrUndefined(resolvedSymbol(target, checker)?.valueDeclaration);
}

function functionOrUndefined(node) {
  return node && ts.isFunctionLike(node) && node.body ? node : undefined;
}

function handlerSchedulesWork(handler, checker) {
  let schedules = false;
  walkAll(handler.body, (node) => {
    const isScheduling = ts.isCallExpression(node) && SCHEDULING_CALLS.has(calleeName(node));
    if (isScheduling && isBrowserGlobal(node.expression, checker)) schedules = true;
  });
  return schedules;
}

function handlerMeasuresLayout(handler, checker) {
  let measures = false;
  walkAll(handler.body, (node) => {
    if (layoutReadOf(node, checker)) measures = true;
  });
  return measures;
}

// undefined: nothing to report. Otherwise the contextual reason ('' when the finding is a firm one).
function unthrottledHandlerReason(call, checker) {
  const handler = resolveHandler(call.arguments[1], checker);
  if (handler === 'wrapped') return;
  if (!handler) return UNKNOWN_HANDLER_REASON;
  if (handlerSchedulesWork(handler, checker)) return;
  return handlerMeasuresLayout(handler, checker) ? '' : CHEAP_HANDLER_REASON;
}

function checkUnthrottledListener(call, eventName, context) {
  if (!HIGH_FREQ_EVENTS.has(eventName)) return;
  if (BLOCKING_TOUCH_EVENTS.has(eventName) && isPassive(call)) return;
  const reason = unthrottledHandlerReason(call, context.checker);
  if (reason === undefined) return;
  const advice = BLOCKING_TOUCH_EVENTS.has(eventName)
    ? 'Pass `{ passive: true }` so the browser can scroll immediately without waiting for JS, and throttle heavy work with `requestAnimationFrame`.'
    : `Throttle or debounce the \`${eventName}\` handler (or schedule DOM work inside \`requestAnimationFrame\`) to avoid jank.`;
  context.report(
    call,
    'dom-unthrottled-scroll-resize',
    `Attaching an unthrottled \`${eventName}\` listener directly on the main thread can cause frame drops and scroll jank. ${advice}`,
    reason || undefined,
  );
}

function insideComponentLifecycle(node, checker) {
  for (let current = node.parent; current; current = current.parent) {
    if (!ts.isCallExpression(current)) continue;
    if (REACT_EFFECTS.has(importedName(current.expression, checker, REACT_MODULES))) return true;
    if (isVueImport(current.expression, checker, 'onMounted')) return true;
  }
  return false;
}

function optionReleasesListener(call) {
  const options = optionsOf(call);
  return (
    Boolean(options) &&
    (Boolean(objectProperty(options, 'signal')) || objectProperty(options, 'once')?.kind === ts.SyntaxKind.TrueKeyword)
  );
}

function checkListenerCleanup(call, eventName, context) {
  const callee = ts.skipOuterExpressions(call.expression);
  const handler = ts.skipOuterExpressions(call.arguments[1]);
  if (!ts.isArrowFunction(handler) && !ts.isFunctionExpression(handler)) return;
  if (!isGlobalEventTarget(callee.expression, context.checker) || !enclosingFunction(call)) return;
  if (call.arguments[2] && !optionsOf(call)) return;
  if (optionReleasesListener(call) || insideComponentLifecycle(call, context.checker)) return;
  context.report(
    call,
    'dom-listener-without-cleanup',
    `\`${callee.expression.getText()}.addEventListener('${eventName}', ...)\` uses an inline anonymous function with no \`AbortSignal\` or \`{ once: true }\`, so it can never be removed with \`removeEventListener\`. Pass an \`AbortController\` \`signal\` or a named function reference and clean it up on teardown.`,
    LISTENER_REASON,
  );
}

function enclosingFunction(node) {
  for (let current = node.parent; current; current = current.parent) if (ts.isFunctionLike(current)) return current;
}

function checkAddEventListener(call, context) {
  const callee = ts.skipOuterExpressions(call.expression);
  if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== 'addEventListener') return;
  if (!declaredInDomLibrary(domSymbolOf(callee, context.checker))) return;
  const eventArg = call.arguments[0] && ts.skipOuterExpressions(call.arguments[0]);
  if (!eventArg || !ts.isStringLiteralLike(eventArg) || !call.arguments[1]) return;
  checkUnthrottledListener(call, eventArg.text, context);
  checkListenerCleanup(call, eventArg.text, context);
}

// --- Bundle size ---------------------------------------------------------------------------------------------

function isClientModule(sourceFile) {
  if (/\.[jt]sx$/i.test(sourceFile.fileName)) return true;
  return sourceFile.statements.some(
    (statement) =>
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteralLike(statement.moduleSpecifier) &&
      CLIENT_FRAMEWORK_MODULES.has(statement.moduleSpecifier.text),
  );
}

// { advice, reason } for an import that drags in a heavy barrel; reason is set when the finding is contextual.
function heavyBarrelOf(moduleName, clause) {
  const isNamedOnly = !clause.name && clause.namedBindings && ts.isNamedImports(clause.namedBindings);
  if (FONTAWESOME_ICON_PACKAGE.test(moduleName)) {
    const isNamespace = clause.namedBindings && ts.isNamespaceImport(clause.namedBindings);
    return isNamespace ? { advice: FONTAWESOME_NAMESPACE_ADVICE } : undefined;
  }
  if (moduleName === MUI_ICONS_ROOT) {
    return isNamedOnly ? { advice: MUI_ICONS_ADVICE, reason: MUI_ICONS_NAMED_REASON } : undefined;
  }
  const advice = HEAVY_CLIENT_BARRELS.get(moduleName);
  return advice && { advice, reason: isNamedOnly ? LODASH_NAMED_REASON : undefined };
}

function checkHeavyBarrelImport(node, context) {
  const clause = node.importClause;
  if (!clause || clause.isTypeOnly || !ts.isStringLiteralLike(node.moduleSpecifier)) return;
  const barrel = heavyBarrelOf(node.moduleSpecifier.text, clause);
  if (!barrel || !isClientModule(node.getSourceFile())) return;
  context.report(
    node,
    'frontend-barrel-heavy-import',
    `Importing the root of \`${node.moduleSpecifier.text}\` pulls a large module graph into the client bundle and defeats tree-shaking. ${barrel.advice}`,
    barrel.reason,
  );
}

module.exports = { checkAddEventListener, checkHeavyBarrelImport, checkLayoutThrashing, isLoop };
