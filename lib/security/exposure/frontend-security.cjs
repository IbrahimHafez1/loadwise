'use strict';

// Frontend security rules covering React, Angular, Vue and vanilla DOM code:
// - dom-xss-sink
// - react-dangerously-set-inner-html
// - angular-bypass-security-trust
// - vue-v-html-unsanitized
// - frontend-storage-secret-token
// - postmessage-missing-origin-check
// Receivers are recognised by their DOM library types or imports, never by variable names. The browser has no
// request object, so a value counts as untrusted when it traces to the URL, the referrer, cookies, a postMessage
// payload or a form field; other dynamic values are contextual.
const { syntax: ts, isDefaultLibrary } = require('../../performance/compiler.cjs');
const { moduleName } = require('../bindings.cjs');
const { calleeName } = require('../../performance/schema/ts-helpers.cjs');

const MAX_DEPTH = 4;
const DOM_HTML_PROPS = new Set(['innerHTML', 'outerHTML']);
const HTML_HOLDER_INTERFACES = new Set(['Element', 'InnerHTML', 'ShadowRoot']);
const DOM_HTML_METHODS = new Map([
  ['write', { interfaces: new Set(['Document']), htmlArgument: 0 }],
  ['writeln', { interfaces: new Set(['Document']), htmlArgument: 0 }],
  ['insertAdjacentHTML', { interfaces: new Set(['Element']), htmlArgument: 1 }],
  ['createContextualFragment', { interfaces: new Set(['Range']), htmlArgument: 0 }],
]);
const ANGULAR_BYPASS_METHODS = new Set([
  'bypassSecurityTrustHtml',
  'bypassSecurityTrustScript',
  'bypassSecurityTrustUrl',
  'bypassSecurityTrustResourceUrl',
  'bypassSecurityTrustStyle',
]);
const ANGULAR_SANITIZER_MODULE = '@angular/platform-browser';
const FORM_FIELD_INTERFACES = new Set(['HTMLInputElement', 'HTMLTextAreaElement', 'HTMLSelectElement']);
const WINDOW_INTERFACES = new Set(['Window']);
const STORAGE_INTERFACES = new Set(['Storage']);
// Calls into these modules return escaped, sanitized or translated text.
const SAFE_OUTPUT_MODULES = new Set([
  'dompurify',
  'isomorphic-dompurify',
  'sanitize-html',
  'xss',
  'escape-html',
  'html-escaper',
  'lodash/escape',
  'lodash.escape',
  'i18next',
  'react-i18next',
  'vue-i18n',
  '@ngx-translate/core',
  'next-intl',
  'react-intl',
]);
const ESCAPING_MODULES = new Set(['lodash', 'he', 'validator', ANGULAR_SANITIZER_MODULE]);
const ESCAPE_METHODS = new Set(['escape', 'encode', 'sanitize']);
const REMOTE_MODULES = new Set(['axios', 'ky', 'ofetch', 'node-fetch', 'cross-fetch', '@angular/common/http']);
// Global members whose value an attacker can set through a link, a referrer or another page.
const URL_CONTROLLED_PATHS = [
  ...['location', 'window.location', 'self.location', 'document.location'].flatMap((base) =>
    ['search', 'hash', 'href', 'pathname'].map((member) => `${base}.${member}`),
  ),
  'document.URL',
  'document.documentURI',
  'document.referrer',
  'document.cookie',
  'window.name',
];
const REACT_PACKAGES = ['react', 'preact'];
const REACT_TYPES_PATH = /\/node_modules\/(?:@types\/)?(?:react|preact)\//;
const SENSITIVE_KEY_WORDS =
  /(?:^|[^a-z0-9])(?:token|jwt|secret|password|passwd|api_?key|credentials?|bearer|private_?key)(?:$|[^a-z0-9])/;
const NON_SECRET_KEY_WORDS = /csrf|xsrf|cursor|page|theme|design|consent|device|analytics/;
const STORAGE_ADVICE =
  'Store session credentials in `HttpOnly`, `Secure`, `SameSite` cookies instead, so scripts on the page cannot read them.';
const REMOTE_REASON =
  'Fetched data is usually trusted when it comes from your own backend; confirm it cannot carry user-supplied markup.';
const UNKNOWN_REASON = 'The value is built at runtime; confirm it cannot contain untrusted input.';
const WILDCARD_REASON =
  "Posting to '*' is harmless for public data; confirm the message carries nothing sensitive, or name the recipient origin.";

const untrustedValue = (label) => ({ rank: 0, label });
const remoteValue = (label) => ({ rank: 1, label, reason: REMOTE_REASON });
const unknownValue = { rank: 2, label: 'A runtime value', reason: UNKNOWN_REASON };

function strongest(values) {
  return values.filter(Boolean).sort((left, right) => left.rank - right.rank)[0];
}

function declarationsOf(node, context) {
  const symbol = ts.isShorthandPropertyAssignment(node.parent)
    ? context.checker.getShorthandAssignmentValueSymbol(node.parent)
    : context.checker.getSymbolAtLocation(node);
  return symbol?.declarations ?? [];
}

function declaredInDefaultLibrary(node, context) {
  return declarationsOf(node, context).some((declaration) =>
    isDefaultLibrary(context.checker, declaration.getSourceFile()),
  );
}

// `innerHTML` or `postMessage` resolved to one of the DOM library interfaces: a real DOM receiver, whatever it is named.
function declaredInDomInterface(nameNode, context, interfaces) {
  return declarationsOf(nameNode, context).some(
    (declaration) =>
      isDefaultLibrary(context.checker, declaration.getSourceFile()) && interfaces.has(declaration.parent?.name?.text),
  );
}

function declaredInitializer(identifier, context) {
  const declaration = declarationsOf(identifier, context)[0];
  const variable =
    declaration && ts.isBindingElement(declaration)
      ? ts.findAncestor(declaration, ts.isVariableDeclaration)
      : declaration;
  return variable && ts.isVariableDeclaration(variable) ? variable.initializer : undefined;
}

// Parentheses, `as`, `!` and `await` removed. bindings.cjs offers the same, but its type-assertion check is missing
// from the native syntax, which would skip every file this module reads.
function unwrap(expression) {
  let value = expression && ts.skipOuterExpressions(expression);
  while (value && ts.isAwaitExpression(value)) value = ts.skipOuterExpressions(value.expression);
  return value;
}

function requiredModule(initializer) {
  const call = initializer && unwrap(initializer);
  const isRequire =
    call &&
    ts.isCallExpression(call) &&
    ts.isIdentifier(call.expression) &&
    call.expression.text === 'require' &&
    call.arguments.length === 1 &&
    ts.isStringLiteralLike(call.arguments[0]);
  return isRequire ? moduleName(call.arguments[0].text) : undefined;
}

// The package an import or require binding comes from, read from the project's own syntax.
function moduleOfDeclaration(declaration) {
  if (!declaration) return;
  if (ts.isImportSpecifier(declaration) || ts.isImportClause(declaration) || ts.isNamespaceImport(declaration)) {
    const statement = ts.findAncestor(declaration, ts.isImportDeclaration);
    return statement && ts.isStringLiteral(statement.moduleSpecifier)
      ? moduleName(statement.moduleSpecifier.text)
      : undefined;
  }
  if (ts.isVariableDeclaration(declaration)) return requiredModule(declaration.initializer);
  if (!ts.isBindingElement(declaration)) return;
  const variable = declaration.parent.parent;
  return ts.isVariableDeclaration(variable) ? requiredModule(variable.initializer) : undefined;
}

// `private sanitizer: DomSanitizer` -> the module `DomSanitizer` is imported from, for `sanitizer` and `this.sanitizer`.
function annotatedModule(node, context) {
  const isMemberOfThis = ts.isPropertyAccessExpression(node) && node.expression.kind === ts.SyntaxKind.ThisKeyword;
  if (!ts.isIdentifier(node) && !isMemberOfThis) return;
  const declaration = declarationsOf(isMemberOfThis ? node.name : node, context)[0];
  const typeName =
    declaration?.type && ts.isTypeReferenceNode(declaration.type) ? declaration.type.typeName : undefined;
  return typeName && ts.isIdentifier(typeName) ? moduleOfDeclaration(declarationsOf(typeName, context)[0]) : undefined;
}

function hasScalarType(node, checker) {
  const scalarFlags =
    ts.TypeFlags.NumberLike |
    ts.TypeFlags.BooleanLike |
    ts.TypeFlags.BigIntLike |
    ts.TypeFlags.StringLiteral |
    ts.TypeFlags.Null |
    ts.TypeFlags.Undefined;
  const isScalar = (type) => (type.isUnion() ? type.types.every(isScalar) : Boolean(type.flags & scalarFlags));
  return isScalar(checker.getTypeAtLocation(node));
}

// The module a value comes from: `DOMPurify.sanitize(x)`, `const { t } = useTranslation(); t('key')`,
// `this.sanitizer.sanitize(...)` with an injected `DomSanitizer`.
function originModule(expression, context, depth = 0) {
  const node = unwrap(expression);
  if (!node || depth > MAX_DEPTH) return;
  if (ts.isCallExpression(node)) return originModule(node.expression, context, depth + 1);
  if (ts.isPropertyAccessExpression(node))
    return annotatedModule(node, context) ?? originModule(node.expression, context, depth + 1);
  if (!ts.isIdentifier(node)) return;
  const bound = moduleOfDeclaration(declarationsOf(node, context)[0]) ?? annotatedModule(node, context);
  if (bound) return bound;
  const initializer = declaredInitializer(node, context);
  return initializer && originModule(initializer, context, depth + 1);
}

function isSafeOutputCall(call, context) {
  const module = originModule(call.expression, context);
  if (!module) return false;
  return SAFE_OUTPUT_MODULES.has(module) || (ESCAPING_MODULES.has(module) && ESCAPE_METHODS.has(calleeName(call)));
}

// `value.replace(/</g, '&lt;')`: a replacement whose pattern targets markup characters.
function isMarkupEscapingReplace(call) {
  const name = calleeName(call);
  if (name !== 'replace' && name !== 'replaceAll') return false;
  const pattern = call.arguments[0];
  return Boolean(pattern) && /[<&]/.test(pattern.getText());
}

// `window.location.hash` -> { root: <window identifier>, path: 'window.location.hash' }.
function memberChain(node) {
  const names = [];
  let current = unwrap(node);
  while (ts.isPropertyAccessExpression(current)) {
    names.unshift(current.name.text);
    current = unwrap(current.expression);
  }
  return ts.isIdentifier(current) ? { root: current, path: [current.text, ...names].join('.') } : undefined;
}

function urlControlledLabel(node, context) {
  const chain = memberChain(node);
  if (!chain || !declaredInDefaultLibrary(chain.root, context)) return;
  const matches = URL_CONTROLLED_PATHS.some((source) => chain.path === source || chain.path.startsWith(`${source}.`));
  return matches ? `\`${chain.path}\`` : undefined;
}

function isMessageEventData(node, context) {
  if (node.name.text !== 'data') return false;
  const typeName = context.checker.getTypeAtLocation(node.expression).getSymbol()?.name;
  return typeName === 'MessageEvent';
}

function assessMember(node, context, depth) {
  if (ts.isPropertyAccessExpression(node)) {
    const urlLabel = urlControlledLabel(node, context);
    if (urlLabel) return untrustedValue(urlLabel);
    if (isMessageEventData(node, context)) return untrustedValue('The `postMessage` payload');
    if (node.name.text === 'value' && declaredInDomInterface(node.name, context, FORM_FIELD_INTERFACES))
      return untrustedValue('A form field value');
  }
  return assess(node.expression, context, depth + 1);
}

function assessIdentifier(identifier, context, depth) {
  const declarations = declarationsOf(identifier, context);
  if (declarations.length === 0) return unknownValue;
  if (declaredInDefaultLibrary(identifier, context))
    return identifier.text === 'location' ? untrustedValue('`location`') : undefined;
  const initializer = declaredInitializer(identifier, context);
  return initializer ? assess(initializer, context, depth + 1) : unknownValue;
}

function isRemoteCall(call, context) {
  const callee = unwrap(call.expression);
  if (ts.isIdentifier(callee) && callee.text === 'fetch') return declaredInDefaultLibrary(callee, context);
  return REMOTE_MODULES.has(originModule(callee, context));
}

// Standard library calls (`decodeURIComponent`, `slice`, `JSON.parse`) pass their inputs through; project functions
// are opaque, so they are never traced.
function assessCall(call, context, depth) {
  if (isSafeOutputCall(call, context) || isMarkupEscapingReplace(call)) return;
  if (isRemoteCall(call, context)) return remoteValue('Fetched data');
  const callee = unwrap(call.expression);
  const nameNode = ts.isPropertyAccessExpression(callee) ? callee.name : callee;
  if (!ts.isIdentifier(nameNode) || !declaredInDefaultLibrary(nameNode, context)) return unknownValue;
  const inputs = ts.isPropertyAccessExpression(callee) ? [callee.expression, ...call.arguments] : [...call.arguments];
  return strongest(inputs.map((input) => assess(input, context, depth + 1)));
}

function assessCompound(node, context, depth) {
  const parts = ts.isTemplateExpression(node)
    ? node.templateSpans.map((span) => span.expression)
    : ts.isConditionalExpression(node)
      ? [node.whenTrue, node.whenFalse]
      : [node.left, node.right];
  return strongest(parts.map((part) => assess(part, context, depth + 1)));
}

// undefined when the value is safe; otherwise { rank, label, reason? }: untrusted (no reason), remote or unknown.
function assess(expression, context, depth = 0) {
  const node = unwrap(expression);
  if (!node || depth > MAX_DEPTH) return unknownValue;
  if (ts.isStringLiteralLike(node) || ts.isFunctionLike(node) || hasScalarType(node, context.checker)) return;
  if (ts.isTemplateExpression(node) || ts.isConditionalExpression(node) || ts.isBinaryExpression(node))
    return assessCompound(node, context, depth);
  if (ts.isCallExpression(node)) return assessCall(node, context, depth);
  if (ts.isNewExpression(node))
    return strongest([...(node.arguments ?? [])].map((argument) => assess(argument, context, depth + 1)));
  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node))
    return assessMember(node, context, depth);
  return ts.isIdentifier(node) ? assessIdentifier(node, context, depth) : unknownValue;
}

function reportDynamicValue(node, context, { ruleId, sink, value, advice }) {
  const assessment = assess(value, context);
  if (!assessment) return;
  context.report(
    node,
    ruleId,
    `${assessment.label} reaches ${sink} unsanitized, which allows XSS if it holds attacker-controlled input. ${advice}`,
    assessment.reason,
  );
}

function assignedText(assignment) {
  const operator = assignment.operatorToken.kind;
  return operator === ts.SyntaxKind.EqualsToken || operator === ts.SyntaxKind.PlusEqualsToken;
}

function checkAssignment(node, context) {
  if (context.fileContext.isTestSource || !assignedText(node)) return;
  const left = unwrap(node.left);
  if (!ts.isPropertyAccessExpression(left) || !DOM_HTML_PROPS.has(left.name.text)) return;
  if (!declaredInDomInterface(left.name, context, HTML_HOLDER_INTERFACES)) return;
  reportDynamicValue(node, context, {
    ruleId: 'dom-xss-sink',
    sink: `\`${left.name.text}\``,
    value: node.right,
    advice: 'Use `textContent` for plain text, or sanitize HTML with `DOMPurify.sanitize(...)` first.',
  });
}

function checkDomHtmlMethod(call, callee, context) {
  const method = DOM_HTML_METHODS.get(callee.name.text);
  if (!declaredInDomInterface(callee.name, context, method.interfaces)) return;
  const html = call.arguments[method.htmlArgument];
  if (!html) return;
  reportDynamicValue(call, context, {
    ruleId: 'dom-xss-sink',
    sink: `\`${callee.name.text}()\``,
    value: html,
    advice: 'Build DOM nodes safely or sanitize with `DOMPurify.sanitize(...)` first.',
  });
}

function checkAngularBypass(call, callee, context) {
  if (originModule(call.expression, context) !== ANGULAR_SANITIZER_MODULE || !call.arguments[0]) return;
  reportDynamicValue(call, context, {
    ruleId: 'angular-bypass-security-trust',
    sink: `\`${callee.name.text}()\``,
    value: call.arguments[0],
    advice:
      "This disables Angular's built-in sanitization: sanitize the value with `DOMPurify.sanitize(...)` or avoid bypassing `DomSanitizer`.",
  });
}

function literalKeyText(node, checker) {
  const value = unwrap(node);
  if (ts.isTemplateExpression(value))
    return [value.head.text, ...value.templateSpans.map((span) => span.literal.text)].join('_');
  const type = checker.getTypeAtLocation(value);
  return type.flags & ts.TypeFlags.StringLiteral ? type.value : undefined;
}

// `authToken` -> `auth_token`, so the words of a camelCase key can be matched.
function isSensitiveKey(key) {
  const normalized = key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
  return SENSITIVE_KEY_WORDS.test(normalized) && !NON_SECRET_KEY_WORDS.test(normalized);
}

function checkStorage(call, callee, context) {
  if (!declaredInDomInterface(callee.name, context, STORAGE_INTERFACES) || !call.arguments[0]) return;
  const key = literalKeyText(call.arguments[0], context.checker);
  if (!key || !isSensitiveKey(key)) return;
  context.report(
    call,
    'frontend-storage-secret-token',
    `Storing a credential under \`${key}\` in web storage exposes it to any script running on the page (XSS exfiltration). ${STORAGE_ADVICE}`,
  );
}

function propertyKey(property) {
  const name = property.name;
  return name && (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) ? name.text : undefined;
}

function wildcardTargetOrigin(call) {
  const argument = call.arguments[1] && unwrap(call.arguments[1]);
  if (!argument) return false;
  if (ts.isStringLiteralLike(argument)) return argument.text === '*';
  if (!ts.isObjectLiteralExpression(argument)) return false;
  const targetOrigin = argument.properties.find(
    (property) => ts.isPropertyAssignment(property) && propertyKey(property) === 'targetOrigin',
  );
  const value = targetOrigin && unwrap(targetOrigin.initializer);
  return Boolean(value) && ts.isStringLiteralLike(value) && value.text === '*';
}

function carriesSensitiveKey(message) {
  const payload = message && unwrap(message);
  if (!payload || !ts.isObjectLiteralExpression(payload)) return false;
  return payload.properties.some((property) => {
    const key = property.name && propertyKey(property);
    return Boolean(key) && isSensitiveKey(key);
  });
}

function checkPostMessageSender(call, callee, context) {
  if (!declaredInDomInterface(callee.name, context, WINDOW_INTERFACES) || !wildcardTargetOrigin(call)) return;
  context.report(
    call,
    'postmessage-missing-origin-check',
    "Calling `postMessage(..., '*')` delivers the message to whatever origin currently occupies the target window. Name the exact recipient origin instead of `'*'`.",
    carriesSensitiveKey(call.arguments[0]) ? undefined : WILDCARD_REASON,
  );
}

function messageHandler(expression, context) {
  const node = unwrap(expression);
  if (ts.isFunctionLike(node)) return node;
  const symbolNode = ts.isPropertyAccessExpression(node) ? node.name : node;
  const declaration = context.checker.getSymbolAtLocation(symbolNode)?.valueDeclaration;
  if (!declaration) return;
  const candidate = ts.isVariableDeclaration(declaration) ? declaration.initializer : declaration;
  const handler = candidate && unwrap(candidate);
  return handler && ts.isFunctionLike(handler) ? handler : undefined;
}

// Members read from the event at one use, or undefined when the event itself escapes (passed on or aliased).
function membersUsed(use) {
  const parent = use.parent;
  if (ts.isPropertyAccessExpression(parent) && parent.expression === use) return [parent.name.text];
  if (ts.isVariableDeclaration(parent) && ts.isObjectBindingPattern(parent.name)) return bindingMembers(parent.name);
}

function bindingMembers(pattern) {
  return pattern.elements.map((element) => (element.propertyName ?? element.name).getText());
}

function eventUses(handler, parameter, context) {
  const parameterSymbol = context.checker.getSymbolAtLocation(parameter.name);
  const uses = [];
  (function visit(node) {
    if (ts.isIdentifier(node) && context.checker.getSymbolAtLocation(node) === parameterSymbol) uses.push(node);
    ts.forEachChild(node, visit);
  })(handler.body);
  return uses.filter((use) => use !== parameter.name);
}

function eventMembers(handler, context) {
  const [parameter] = handler.parameters;
  if (!parameter) return { members: [], escapes: false };
  if (ts.isObjectBindingPattern(parameter.name)) return { members: bindingMembers(parameter.name), escapes: false };
  const usedMembers = eventUses(handler, parameter, context).map(membersUsed);
  return { members: usedMembers.flatMap((members) => members ?? []), escapes: usedMembers.includes(undefined) };
}

// A handler passes when it checks who sent the message (`origin` or `source`) or hands the event to another function.
function readsMessageWithoutSenderCheck(handler, context) {
  if (!handler.body) return false;
  const { members, escapes } = eventMembers(handler, context);
  return members.includes('data') && !escapes && !members.includes('origin') && !members.includes('source');
}

// `self` is the worker scope in worker files, which have no page to spoof; only a page's own window is checked.
function listensOnWindow(callee, context) {
  const receiver = unwrap(callee.expression);
  if (ts.isIdentifier(receiver) && receiver.text === 'self') return false;
  return declaredInDomInterface(callee.name, context, WINDOW_INTERFACES);
}

function checkMessageListener(call, callee, context) {
  if (call.arguments.length < 2 || !listensOnWindow(callee, context)) return;
  const eventName = unwrap(call.arguments[0]);
  if (!ts.isStringLiteralLike(eventName) || eventName.text !== 'message') return;
  const handler = messageHandler(call.arguments[1], context);
  if (!handler || !readsMessageWithoutSenderCheck(handler, context)) return;
  context.report(
    call,
    'postmessage-missing-origin-check',
    'This `message` listener reads `event.data` without checking `event.origin` or `event.source`, so any window or iframe can send it spoofed messages. Compare `event.origin` with the expected origin before using the data.',
  );
}

const callHandlers = new Map([
  ...[...DOM_HTML_METHODS.keys()].map((name) => [name, checkDomHtmlMethod]),
  ...[...ANGULAR_BYPASS_METHODS].map((name) => [name, checkAngularBypass]),
  ['setItem', checkStorage],
  ['postMessage', checkPostMessageSender],
  ['addEventListener', checkMessageListener],
]);

function checkCall(call, context) {
  if (context.fileContext.isTestSource) return;
  const callee = unwrap(call.expression);
  if (!ts.isPropertyAccessExpression(callee)) return;
  callHandlers.get(callee.name.text)?.(call, callee, context);
}

function importedModules(sourceFile) {
  const modules = new Set();
  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier))
      modules.add(statement.moduleSpecifier.text);
  }
  return modules;
}

function importsPackage(sourceFile, packages) {
  return [...importedModules(sourceFile)].some((module) =>
    packages.some((name) => module === name || module.startsWith(`${name}/`)),
  );
}

function isReactAttribute(attribute, context) {
  const declarations = declarationsOf(attribute.name, context);
  const typedByReact = declarations.some((declaration) =>
    REACT_TYPES_PATH.test(declaration.getSourceFile().fileName.replaceAll('\\', '/')),
  );
  return typedByReact || importsPackage(attribute.getSourceFile(), REACT_PACKAGES);
}

// `<script type="application/ld+json" dangerouslySetInnerHTML=... />` carries data, not markup.
function isJsonScript(attribute) {
  const element = attribute.parent.parent;
  if (!ts.isIdentifier(element.tagName) || element.tagName.text !== 'script') return false;
  return element.attributes.properties.some(
    (property) =>
      ts.isJsxAttribute(property) &&
      property.name.text === 'type' &&
      Boolean(property.initializer) &&
      ts.isStringLiteral(property.initializer) &&
      property.initializer.text.includes('json'),
  );
}

function htmlProperty(object) {
  return object.properties.find(
    (property) =>
      (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) &&
      propertyKey(property) === '__html',
  );
}

function checkJsxAttribute(attribute, context) {
  if (context.fileContext.isTestSource || attribute.name.text !== 'dangerouslySetInnerHTML') return;
  if (!attribute.initializer || !ts.isJsxExpression(attribute.initializer) || !attribute.initializer.expression) return;
  const object = unwrap(attribute.initializer.expression);
  if (!ts.isObjectLiteralExpression(object)) return;
  const property = htmlProperty(object);
  if (!property || isJsonScript(attribute) || !isReactAttribute(attribute, context)) return;
  reportDynamicValue(attribute, context, {
    ruleId: 'react-dangerously-set-inner-html',
    sink: '`dangerouslySetInnerHTML`',
    value: ts.isShorthandPropertyAssignment(property) ? property.name : property.initializer,
    advice: 'Sanitize with `DOMPurify.sanitize(...)` or render JSX elements instead.',
  });
}

// `h('div', { innerHTML })` with `h` imported from vue, or the Vue 2 `domProps: { innerHTML }` form in a vue file.
function isVueRenderOptions(property, context) {
  const owner = property.parent.parent;
  if (ts.isPropertyAssignment(owner)) {
    return propertyKey(owner) === 'domProps' && importsPackage(property.getSourceFile(), ['vue']);
  }
  const isCall = ts.isCallExpression(owner) && ts.isIdentifier(owner.expression);
  return isCall && moduleOfDeclaration(declarationsOf(owner.expression, context)[0]) === 'vue';
}

function checkProperty(property, context) {
  if (context.fileContext.isTestSource || !ts.isPropertyAssignment(property)) return;
  if (propertyKey(property) !== 'innerHTML' || !isVueRenderOptions(property, context)) return;
  reportDynamicValue(property, context, {
    ruleId: 'vue-v-html-unsanitized',
    sink: 'a Vue render function `innerHTML`',
    value: property.initializer,
    advice: 'Sanitize the HTML with `DOMPurify.sanitize(...)` or render plain text children.',
  });
}

module.exports = { checkAssignment, checkCall, checkJsxAttribute, checkProperty };
