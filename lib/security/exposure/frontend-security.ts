// Frontend security rules covering React, Angular, Vue and vanilla DOM code:
// - dom-xss-sink
// - react-dangerously-set-inner-html
// - angular-bypass-security-trust
// - vue-v-html-unsanitized
// - frontend-storage-secret-token
// - postmessage-missing-origin-check
// - jsx-javascript-url Receivers are recognised by their DOM library types or
// imports, never by variable names. The browser has no request object, so a value counts as
// untrusted when it traces to the URL, the referrer, cookies, a postMessage payload or a form
// field; other dynamic values are contextual.
import { ts, isDefaultLibrary } from '../../performance/compiler.js';
import { moduleName } from '../bindings.js';
import { calleeName } from '../../performance/schema/ts-helpers.js';
import { bodyOf, declaredNameOf, typeAnnotationOf } from '../declarations.js';
import type {
  BinaryExpression,
  CallExpression,
  ConditionalExpression,
  ElementAccessExpression,
  Expression,
  Identifier,
  JsxAttribute,
  NewExpression,
  Node,
  ObjectBindingPattern,
  ObjectLiteralElementLike,
  ObjectLiteralExpression,
  ParameterDeclaration,
  PropertyAccessExpression,
  PropertyAssignment,
  ShorthandPropertyAssignment,
  SignatureDeclaration,
  SourceFile,
  TemplateExpression,
} from 'typescript';
import type { CheckerAdapter, SecurityRuleContext, TypeAdapter } from '../../shared/types.js';

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
const SCHEME_SAFE_PATHS = new Set([
  ...['location', 'window.location', 'self.location', 'document.location'].flatMap((base) =>
    ['href', 'pathname', 'origin', 'host', 'hostname'].map((member) => `${base}.${member}`),
  ),
  'document.URL',
  'document.documentURI',
  'document.referrer',
]);
// `?q=1` and `#x` are relative URLs; only a slice or parse of them can start with a scheme.
const RELATIVE_PART_MEMBERS = new Set(['search', 'hash']);
const URL_ATTRIBUTES = new Set(['href', 'action', 'formAction', 'xlinkHref']);
const FRAME_TAGS = new Set(['iframe', 'frame', 'embed']);
const SEARCH_PARAM_READERS = new Set(['get', 'getAll']);
const SEARCH_PARAMS_MODULES = new Set(['next/navigation', 'react-router', 'react-router-dom']);
const NEXT_ROUTER_MODULE = 'next/router';
const NEXT_LINK_MODULE = 'next/link';
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

// How far a value is from a trusted one: rank 0 is untrusted, 1 remote and 2 unknown; a reason
// makes it contextual.
interface Assessment {
  rank: number;
  label: string;
  reason?: string;
}

const untrustedValue = (label: string): Assessment => ({ rank: 0, label });
const remoteValue = (label: string): Assessment => ({ rank: 1, label, reason: REMOTE_REASON });
const unknownValue: Assessment = { rank: 2, label: 'A runtime value', reason: UNKNOWN_REASON };

function strongest(values: (Assessment | undefined)[]): Assessment | undefined {
  return values
    .filter((value): value is Assessment => value !== undefined)
    .sort((left, right) => left.rank - right.rank)[0];
}

function declarationsOf(node: Node, context: SecurityRuleContext): readonly Node[] {
  const symbol = ts.isShorthandPropertyAssignment(node.parent)
    ? context.checker.getShorthandAssignmentValueSymbol(node.parent)
    : context.checker.getSymbolAtLocation(node);
  return symbol?.declarations ?? [];
}

function declaredInDefaultLibrary(node: Node, context: SecurityRuleContext) {
  return declarationsOf(node, context).some((declaration) =>
    isDefaultLibrary(context.checker, declaration.getSourceFile()),
  );
}

// `innerHTML` or `postMessage` resolved to one of the DOM library interfaces: a real DOM receiver,
// whatever it is named.
function declaredInDomInterface(nameNode: Node, context: SecurityRuleContext, interfaces: ReadonlySet<string>) {
  return declarationsOf(nameNode, context).some((declaration) => {
    const ownerName = declaredNameOf(declaration.parent);
    return (
      isDefaultLibrary(context.checker, declaration.getSourceFile()) &&
      ownerName !== undefined &&
      interfaces.has(ownerName)
    );
  });
}

function declaredInitializer(identifier: Identifier, context: SecurityRuleContext): Expression | undefined {
  const declaration = declarationsOf(identifier, context)[0];
  const variable =
    declaration && ts.isBindingElement(declaration)
      ? ts.findAncestor(declaration, ts.isVariableDeclaration)
      : declaration;
  return variable && ts.isVariableDeclaration(variable) ? variable.initializer : undefined;
}

// Parentheses, `as`, `!` and `await` removed. bindings.cjs offers the same, but its type-assertion
// check is missing from the native syntax, which would skip every file this module reads.
function unwrap(expression: Expression): Expression;
function unwrap(expression: Expression | undefined): Expression | undefined;
function unwrap(expression: Expression | undefined): Expression | undefined {
  let value = expression && ts.skipOuterExpressions(expression);
  while (value && ts.isAwaitExpression(value)) value = ts.skipOuterExpressions(value.expression);
  return value;
}

function requiredModule(initializer: Expression | undefined): string | undefined {
  const call = initializer && unwrap(initializer);
  if (!call || !ts.isCallExpression(call) || !ts.isIdentifier(call.expression)) return;
  if (call.expression.text !== 'require' || call.arguments.length !== 1) return;
  const [specifier] = call.arguments;
  return ts.isStringLiteralLike(specifier) ? moduleName(specifier.text) : undefined;
}

// The package an import or require binding comes from, read from the project's own syntax.
function moduleOfDeclaration(declaration: Node | undefined): string | undefined {
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

// `private sanitizer: DomSanitizer` -> the module `DomSanitizer` is imported from, for `sanitizer`
// and `this.sanitizer`.
function annotatedModule(node: Node, context: SecurityRuleContext): string | undefined {
  const memberOfThis =
    ts.isPropertyAccessExpression(node) && node.expression.kind === ts.SyntaxKind.ThisKeyword ? node : undefined;
  if (!ts.isIdentifier(node) && !memberOfThis) return;
  const declaration = declarationsOf(memberOfThis ? memberOfThis.name : node, context)[0];
  const annotation = declaration && typeAnnotationOf(declaration);
  const typeName = annotation && ts.isTypeReferenceNode(annotation) ? annotation.typeName : undefined;
  return typeName && ts.isIdentifier(typeName) ? moduleOfDeclaration(declarationsOf(typeName, context)[0]) : undefined;
}

function hasScalarType(node: Node, checker: CheckerAdapter) {
  const scalarFlags =
    ts.TypeFlags.NumberLike |
    ts.TypeFlags.BooleanLike |
    ts.TypeFlags.BigIntLike |
    ts.TypeFlags.StringLiteral |
    ts.TypeFlags.Null |
    ts.TypeFlags.Undefined;
  const isScalar = (type: TypeAdapter): boolean =>
    type.isUnion() ? (type.types ?? []).every(isScalar) : Boolean(type.flags & scalarFlags);
  return isScalar(checker.getTypeAtLocation(node));
}

// The module a value comes from: `DOMPurify.sanitize(x)`, `const { t } = useTranslation();
// t('key')`,
// `this.sanitizer.sanitize(...)` with an injected `DomSanitizer`.
function originModule(expression: Expression, context: SecurityRuleContext, depth = 0): string | undefined {
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

function isSafeOutputCall(call: CallExpression, context: SecurityRuleContext) {
  const module = originModule(call.expression, context);
  if (!module) return false;
  const method = calleeName(call);
  return (
    SAFE_OUTPUT_MODULES.has(module) ||
    (ESCAPING_MODULES.has(module) && method !== undefined && ESCAPE_METHODS.has(method))
  );
}

// `value.replace(/</g, '&lt;')`: a replacement whose pattern targets markup characters.
function isMarkupEscapingReplace(call: CallExpression) {
  const name = calleeName(call);
  if (name !== 'replace' && name !== 'replaceAll') return false;
  const pattern = call.arguments[0];
  return Boolean(pattern) && /[<&]/.test(pattern.getText());
}

// `window.location.hash` -> { root: <window identifier>, path: 'window.location.hash' }.
function memberChain(node: Expression) {
  const names: string[] = [];
  let current = unwrap(node);
  while (ts.isPropertyAccessExpression(current)) {
    names.unshift(current.name.text);
    current = unwrap(current.expression);
  }
  return ts.isIdentifier(current) ? { root: current, path: [current.text, ...names].join('.') } : undefined;
}

function urlControlledLabel(node: Expression, context: SecurityRuleContext) {
  const chain = memberChain(node);
  if (!chain || !declaredInDefaultLibrary(chain.root, context)) return;
  const matches = URL_CONTROLLED_PATHS.some((source) => chain.path === source || chain.path.startsWith(`${source}.`));
  return matches ? `\`${chain.path}\`` : undefined;
}

function isMessageEventData(node: PropertyAccessExpression, context: SecurityRuleContext) {
  if (node.name.text !== 'data') return false;
  const typeName = context.checker.getTypeAtLocation(node.expression).getSymbol()?.name;
  return typeName === 'MessageEvent';
}

function assessMember(
  node: PropertyAccessExpression | ElementAccessExpression,
  context: SecurityRuleContext,
  depth: number,
): Assessment | undefined {
  const label = ts.isPropertyAccessExpression(node) ? untrustedMemberLabel(node, context) : undefined;
  return label ? untrustedValue(label) : assess(node.expression, context, depth + 1);
}

function untrustedMemberLabel(node: PropertyAccessExpression, context: SecurityRuleContext) {
  const urlLabel = urlControlledLabel(node, context);
  if (urlLabel) return urlLabel;
  if (isMessageEventData(node, context)) return 'The `postMessage` payload';
  if (node.name.text === 'value' && declaredInDomInterface(node.name, context, FORM_FIELD_INTERFACES))
    return 'A form field value';
}

function assessIdentifier(identifier: Identifier, context: SecurityRuleContext, depth: number): Assessment | undefined {
  const declarations = declarationsOf(identifier, context);
  if (declarations.length === 0) return unknownValue;
  if (declaredInDefaultLibrary(identifier, context))
    return identifier.text === 'location' ? untrustedValue('`location`') : undefined;
  const initializer = declaredInitializer(identifier, context);
  return initializer ? assess(initializer, context, depth + 1) : unknownValue;
}

function isRemoteCall(call: CallExpression, context: SecurityRuleContext) {
  const callee = unwrap(call.expression);
  if (ts.isIdentifier(callee) && callee.text === 'fetch') return declaredInDefaultLibrary(callee, context);
  const module = originModule(callee, context);
  return module !== undefined && REMOTE_MODULES.has(module);
}

// Standard library calls (`decodeURIComponent`, `slice`, `JSON.parse`) pass their inputs through;
// project functions are opaque, so they are never traced.
function assessCall(call: CallExpression, context: SecurityRuleContext, depth: number): Assessment | undefined {
  if (isSafeOutputCall(call, context) || isMarkupEscapingReplace(call)) return;
  if (isRemoteCall(call, context)) return remoteValue('Fetched data');
  const callee = unwrap(call.expression);
  const nameNode = ts.isPropertyAccessExpression(callee) ? callee.name : callee;
  if (!ts.isIdentifier(nameNode) || !declaredInDefaultLibrary(nameNode, context)) return unknownValue;
  const inputs: Expression[] = ts.isPropertyAccessExpression(callee)
    ? [callee.expression, ...call.arguments]
    : [...call.arguments];
  return strongest(inputs.map((input) => assess(input, context, depth + 1)));
}

function assessCompound(
  node: TemplateExpression | ConditionalExpression | BinaryExpression,
  context: SecurityRuleContext,
  depth: number,
): Assessment | undefined {
  const parts: Expression[] = ts.isTemplateExpression(node)
    ? node.templateSpans.map((span) => span.expression)
    : ts.isConditionalExpression(node)
      ? [node.whenTrue, node.whenFalse]
      : [node.left, node.right];
  return strongest(parts.map((part) => assess(part, context, depth + 1)));
}

// undefined when the value is safe; otherwise { rank, label, reason? }: untrusted (no reason),
// remote or unknown.
function assess(expression: Expression, context: SecurityRuleContext, depth = 0): Assessment | undefined {
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

interface DynamicValueReport {
  ruleId: string;
  sink: string;
  value: Expression;
  advice: string;
}

function reportDynamicValue(
  node: Node,
  context: SecurityRuleContext,
  { ruleId, sink, value, advice }: DynamicValueReport,
) {
  const assessment = assess(value, context);
  if (!assessment) return;
  context.report(
    node,
    ruleId,
    `${assessment.label} reaches ${sink} unsanitized, which allows XSS if it holds attacker-controlled input. ${advice}`,
    assessment.reason,
  );
}

function assignedText(assignment: BinaryExpression) {
  const operator = assignment.operatorToken.kind;
  return operator === ts.SyntaxKind.EqualsToken || operator === ts.SyntaxKind.PlusEqualsToken;
}

function checkAssignment(node: BinaryExpression, context: SecurityRuleContext) {
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

function checkDomHtmlMethod(call: CallExpression, callee: PropertyAccessExpression, context: SecurityRuleContext) {
  const method = DOM_HTML_METHODS.get(callee.name.text);
  if (!method || !declaredInDomInterface(callee.name, context, method.interfaces)) return;
  const html = call.arguments[method.htmlArgument];
  if (!html) return;
  reportDynamicValue(call, context, {
    ruleId: 'dom-xss-sink',
    sink: `\`${callee.name.text}()\``,
    value: html,
    advice: 'Build DOM nodes safely or sanitize with `DOMPurify.sanitize(...)` first.',
  });
}

function checkAngularBypass(call: CallExpression, callee: PropertyAccessExpression, context: SecurityRuleContext) {
  if (originModule(call.expression, context) !== ANGULAR_SANITIZER_MODULE || !call.arguments[0]) return;
  reportDynamicValue(call, context, {
    ruleId: 'angular-bypass-security-trust',
    sink: `\`${callee.name.text}()\``,
    value: call.arguments[0],
    advice:
      "This disables Angular's built-in sanitization: sanitize the value with `DOMPurify.sanitize(...)` or avoid bypassing `DomSanitizer`.",
  });
}

function literalKeyText(node: Expression, checker: CheckerAdapter): string | undefined {
  const value = unwrap(node);
  if (ts.isTemplateExpression(value))
    return [value.head.text, ...value.templateSpans.map((span) => span.literal.text)].join('_');
  const type = checker.getTypeAtLocation(value);
  return type.flags & ts.TypeFlags.StringLiteral && typeof type.value === 'string' ? type.value : undefined;
}

// `authToken` -> `auth_token`, so the words of a camelCase key can be matched.
function isSensitiveKey(key: string) {
  const normalized = key.replaceAll(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
  return SENSITIVE_KEY_WORDS.test(normalized) && !NON_SECRET_KEY_WORDS.test(normalized);
}

function checkStorage(call: CallExpression, callee: PropertyAccessExpression, context: SecurityRuleContext) {
  if (!declaredInDomInterface(callee.name, context, STORAGE_INTERFACES) || !call.arguments[0]) return;
  const key = literalKeyText(call.arguments[0], context.checker);
  if (!key || !isSensitiveKey(key)) return;
  context.report(
    call,
    'frontend-storage-secret-token',
    `Storing a credential under \`${key}\` in web storage exposes it to any script running on the page (XSS exfiltration). ${STORAGE_ADVICE}`,
  );
}

function propertyKey(property: ObjectLiteralElementLike): string | undefined {
  const name = property.name;
  return name && (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) ? name.text : undefined;
}

function wildcardTargetOrigin(call: CallExpression) {
  const argument = call.arguments[1] && unwrap(call.arguments[1]);
  if (!argument) return false;
  if (ts.isStringLiteralLike(argument)) return argument.text === '*';
  if (!ts.isObjectLiteralExpression(argument)) return false;
  const targetOrigin = argument.properties.find(
    (property): property is PropertyAssignment =>
      ts.isPropertyAssignment(property) && propertyKey(property) === 'targetOrigin',
  );
  const value = targetOrigin && unwrap(targetOrigin.initializer);
  return !!value && ts.isStringLiteralLike(value) && value.text === '*';
}

function carriesSensitiveKey(message: Expression | undefined) {
  const payload = message && unwrap(message);
  if (!payload || !ts.isObjectLiteralExpression(payload)) return false;
  return payload.properties.some((property) => {
    const key = property.name && propertyKey(property);
    return key !== undefined && isSensitiveKey(key);
  });
}

function checkPostMessageSender(call: CallExpression, callee: PropertyAccessExpression, context: SecurityRuleContext) {
  if (!declaredInDomInterface(callee.name, context, WINDOW_INTERFACES) || !wildcardTargetOrigin(call)) return;
  context.report(
    call,
    'postmessage-missing-origin-check',
    "Calling `postMessage(..., '*')` delivers the message to whatever origin currently occupies the target window. Name the exact recipient origin instead of `'*'`.",
    carriesSensitiveKey(call.arguments[0]) ? undefined : WILDCARD_REASON,
  );
}

function messageHandler(expression: Expression, context: SecurityRuleContext): SignatureDeclaration | undefined {
  const node = unwrap(expression);
  if (ts.isFunctionLike(node)) return node;
  const symbolNode = ts.isPropertyAccessExpression(node) ? node.name : node;
  const declaration = context.checker.getSymbolAtLocation(symbolNode)?.valueDeclaration;
  if (!declaration) return;
  const handler = ts.isVariableDeclaration(declaration) ? unwrap(declaration.initializer) : declaration;
  return handler && ts.isFunctionLike(handler) ? handler : undefined;
}

// Members read from the event at one use, or undefined when the event itself escapes (passed on or
// aliased).
function membersUsed(use: Node): string[] | undefined {
  const parent = use.parent;
  if (ts.isPropertyAccessExpression(parent) && parent.expression === use) return [parent.name.text];
  if (ts.isVariableDeclaration(parent) && ts.isObjectBindingPattern(parent.name)) return bindingMembers(parent.name);
}

function bindingMembers(pattern: ObjectBindingPattern) {
  return pattern.elements.map((element) => (element.propertyName ?? element.name).getText());
}

function eventUses(handler: SignatureDeclaration, parameter: ParameterDeclaration, context: SecurityRuleContext) {
  const parameterSymbol = context.checker.getSymbolAtLocation(parameter.name);
  const uses: Identifier[] = [];
  const body = bodyOf(handler);
  if (!body) return uses;
  (function visit(node: Node): void {
    if (ts.isIdentifier(node) && context.checker.getSymbolAtLocation(node) === parameterSymbol) uses.push(node);
    ts.forEachChild(node, visit);
  })(body);
  return uses.filter((use) => use !== parameter.name);
}

function eventMembers(
  handler: SignatureDeclaration,
  context: SecurityRuleContext,
): { members: string[]; escapes: boolean } {
  const [parameter] = handler.parameters;
  if (!parameter) return { members: [], escapes: false };
  if (ts.isObjectBindingPattern(parameter.name)) return { members: bindingMembers(parameter.name), escapes: false };
  const usedMembers = eventUses(handler, parameter, context).map(membersUsed);
  return { members: usedMembers.flatMap((members) => members ?? []), escapes: usedMembers.includes(undefined) };
}

// A handler passes when it checks who sent the message (`origin` or `source`) or hands the event to
// another function.
function readsMessageWithoutSenderCheck(handler: SignatureDeclaration, context: SecurityRuleContext) {
  if (!bodyOf(handler)) return false;
  const { members, escapes } = eventMembers(handler, context);
  return members.includes('data') && !escapes && !members.includes('origin') && !members.includes('source');
}

// `self` is the worker scope in worker files, which have no page to spoof; only a page's own window
// is checked.
function listensOnWindow(callee: PropertyAccessExpression, context: SecurityRuleContext) {
  const receiver = unwrap(callee.expression);
  if (ts.isIdentifier(receiver) && receiver.text === 'self') return false;
  return declaredInDomInterface(callee.name, context, WINDOW_INTERFACES);
}

function checkMessageListener(call: CallExpression, callee: PropertyAccessExpression, context: SecurityRuleContext) {
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

type CallHandler = (call: CallExpression, callee: PropertyAccessExpression, context: SecurityRuleContext) => void;

const callHandlers = new Map<string, CallHandler>([
  ...[...DOM_HTML_METHODS.keys()].map((name): [string, CallHandler] => [name, checkDomHtmlMethod]),
  ...[...ANGULAR_BYPASS_METHODS].map((name): [string, CallHandler] => [name, checkAngularBypass]),
  ['setItem', checkStorage],
  ['postMessage', checkPostMessageSender],
  ['addEventListener', checkMessageListener],
]);

function checkCall(call: CallExpression, context: SecurityRuleContext) {
  if (context.fileContext.isTestSource) return;
  const callee = unwrap(call.expression);
  if (!ts.isPropertyAccessExpression(callee)) return;
  callHandlers.get(callee.name.text)?.(call, callee, context);
}

function importedModules(sourceFile: SourceFile) {
  const modules = new Set<string>();
  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier))
      modules.add(statement.moduleSpecifier.text);
  }
  return modules;
}

function importsPackage(sourceFile: SourceFile, packages: readonly string[]) {
  return [...importedModules(sourceFile)].some((module) =>
    packages.some((name) => module === name || module.startsWith(`${name}/`)),
  );
}

function isReactAttribute(attribute: JsxAttribute, context: SecurityRuleContext) {
  const declarations = declarationsOf(attribute.name, context);
  const typedByReact = declarations.some((declaration) =>
    REACT_TYPES_PATH.test(declaration.getSourceFile().fileName.replaceAll('\\', '/')),
  );
  return typedByReact || importsPackage(attribute.getSourceFile(), REACT_PACKAGES);
}

// `<script type="application/ld+json" dangerouslySetInnerHTML=... />` carries data, not markup.
function isJsonScript(attribute: JsxAttribute) {
  const element = attribute.parent.parent;
  if (!ts.isIdentifier(element.tagName) || element.tagName.text !== 'script') return false;
  return element.attributes.properties.some(
    (property) =>
      ts.isJsxAttribute(property) &&
      ts.isIdentifier(property.name) &&
      property.name.text === 'type' &&
      !!property.initializer &&
      ts.isStringLiteral(property.initializer) &&
      property.initializer.text.includes('json'),
  );
}

function htmlProperty(object: ObjectLiteralExpression) {
  return object.properties.find(
    (property): property is PropertyAssignment | ShorthandPropertyAssignment =>
      (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) &&
      propertyKey(property) === '__html',
  );
}

function checkJsxAttribute(attribute: JsxAttribute, context: SecurityRuleContext) {
  if (
    context.fileContext.isTestSource ||
    !ts.isIdentifier(attribute.name) ||
    attribute.name.text !== 'dangerouslySetInnerHTML'
  )
    return;
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

// Only a value at the start of a URL picks its scheme: `/search?q=${query}` can never become
// `javascript:`. The page's own address and referrer are always http(s) URLs, and an untouched
// `location.hash` or `location.search` starts with `#` or `?`.
function isOwnAddress(node: Expression, context: SecurityRuleContext, transformed: boolean) {
  const chain = memberChain(node);
  if (!chain || !declaredInDefaultLibrary(chain.root, context)) return false;
  const relativePart = !transformed && ts.isPropertyAccessExpression(node) && RELATIVE_PART_MEMBERS.has(node.name.text);
  return SCHEME_SAFE_PATHS.has(chain.path) || relativePart;
}

// `searchParams.get('next')` with `useSearchParams` from next/navigation or react-router, or
// `useRouter().query` from next/router.
function routerQueryLabel(node: Expression, context: SecurityRuleContext) {
  if (ts.isCallExpression(node)) {
    const callee = unwrap(node.expression);
    const readsParam = ts.isPropertyAccessExpression(callee) && SEARCH_PARAM_READERS.has(callee.name.text);
    const module = readsParam ? originModule(callee.expression, context) : undefined;
    return module !== undefined && SEARCH_PARAMS_MODULES.has(module) ? 'A URL search parameter' : undefined;
  }
  if (!ts.isPropertyAccessExpression(node) || node.name.text !== 'query') return;
  return originModule(node.expression, context) === NEXT_ROUTER_MODULE ? 'The router query' : undefined;
}

// The untrusted source that decides a URL's scheme, or undefined when the value starts with a
// constant, is opaque or comes from the app itself. Only untrusted sources are reported: a prop or
// fetched link is how most apps render links.
function urlLeadSource(
  expression: Expression,
  context: SecurityRuleContext,
  depth = 0,
  transformed = false,
): string | undefined {
  const node = unwrap(expression);
  if (!node || depth > MAX_DEPTH || isOwnAddress(node, context, transformed)) return;
  const next = (part: Expression) => urlLeadSource(part, context, depth + 1, transformed);
  if (ts.isTemplateExpression(node)) return node.head.text === '' ? next(node.templateSpans[0].expression) : undefined;
  if (ts.isConditionalExpression(node)) return next(node.whenTrue) ?? next(node.whenFalse);
  if (ts.isBinaryExpression(node)) {
    const operator = node.operatorToken.kind;
    if (operator === ts.SyntaxKind.PlusToken) return next(node.left);
    const fallback = operator === ts.SyntaxKind.QuestionQuestionToken || operator === ts.SyntaxKind.BarBarToken;
    return fallback ? (next(node.left) ?? next(node.right)) : undefined;
  }
  const routerLabel = routerQueryLabel(node, context);
  if (routerLabel) return routerLabel;
  if (ts.isCallExpression(node) || ts.isNewExpression(node)) return leadOfLibraryCall(node, context, depth);
  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
    const label = ts.isPropertyAccessExpression(node) ? untrustedMemberLabel(node, context) : undefined;
    return label ?? next(node.expression);
  }
  if (!ts.isIdentifier(node) || declaredInDefaultLibrary(node, context)) return;
  const initializer = declaredInitializer(node, context);
  return initializer && next(initializer);
}

// `decodeURIComponent(x)`, `x.slice(1)`, `new URL(x)`: standard library calls pass their first
// input through; project functions (a `safeUrl` helper) are opaque.
function leadOfLibraryCall(call: CallExpression | NewExpression, context: SecurityRuleContext, depth: number) {
  const callee = unwrap(call.expression);
  const nameNode = ts.isPropertyAccessExpression(callee) ? callee.name : callee;
  if (!ts.isIdentifier(nameNode) || !declaredInDefaultLibrary(nameNode, context)) return;
  const input = ts.isPropertyAccessExpression(callee) ? callee.expression : call.arguments?.[0];
  return input && urlLeadSource(input, context, depth + 1, true);
}

function urlAttributeOf(attribute: JsxAttribute) {
  if (!ts.isIdentifier(attribute.name)) return;
  const element = attribute.parent.parent;
  const tagName = element.tagName;
  if (!ts.isIdentifier(tagName)) return;
  const name = attribute.name.text;
  if (/^[a-z]/.test(tagName.text)) {
    const isUrlAttribute = URL_ATTRIBUTES.has(name) || (name === 'src' && FRAME_TAGS.has(tagName.text));
    return isUrlAttribute ? name : undefined;
  }
  return name === 'href' ? name : undefined;
}

// Component links count only when they render a plain anchor: `<Link>` from next/link.
function isUrlSink(attribute: JsxAttribute, context: SecurityRuleContext) {
  const tagName = attribute.parent.parent.tagName;
  if (ts.isIdentifier(tagName) && /^[a-z]/.test(tagName.text)) return true;
  return moduleOfDeclaration(declarationsOf(tagName, context)[0]) === NEXT_LINK_MODULE;
}

function checkJsxUrlAttribute(attribute: JsxAttribute, context: SecurityRuleContext) {
  const name = urlAttributeOf(attribute);
  const initializer = attribute.initializer;
  if (context.fileContext.isTestSource || !name || !initializer) return;
  if (!ts.isJsxExpression(initializer) || !initializer.expression) return;
  if (!isUrlSink(attribute, context)) return;
  const source = urlLeadSource(initializer.expression, context);
  if (!source) return;
  context.report(
    attribute,
    'jsx-javascript-url',
    `${source} decides the scheme of \`${name}\`, so a \`javascript:\` URL runs script when the link or form is used (XSS). Allow only http(s) or relative URLs, for example \`new URL(value, location.origin).protocol === 'https:'\`, before rendering it.`,
  );
}

// `h('div', { innerHTML })` with `h` imported from vue, or the Vue 2 `domProps: { innerHTML }` form
// in a vue file.
function isVueRenderOptions(property: PropertyAssignment, context: SecurityRuleContext) {
  const owner = property.parent.parent;
  if (ts.isPropertyAssignment(owner)) {
    return propertyKey(owner) === 'domProps' && importsPackage(property.getSourceFile(), ['vue']);
  }
  const isCall = ts.isCallExpression(owner) && ts.isIdentifier(owner.expression);
  return isCall && moduleOfDeclaration(declarationsOf(owner.expression, context)[0]) === 'vue';
}

function checkProperty(property: Node, context: SecurityRuleContext) {
  if (context.fileContext.isTestSource || !ts.isPropertyAssignment(property)) return;
  if (propertyKey(property) !== 'innerHTML' || !isVueRenderOptions(property, context)) return;
  reportDynamicValue(property, context, {
    ruleId: 'vue-v-html-unsanitized',
    sink: 'a Vue render function `innerHTML`',
    value: property.initializer,
    advice: 'Sanitize the HTML with `DOMPurify.sanitize(...)` or render plain text children.',
  });
}

export { checkAssignment, checkCall, checkJsxAttribute, checkJsxUrlAttribute, checkProperty };
