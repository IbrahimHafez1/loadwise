// jsx-javascript-url: an untrusted value at the start of a JSX link, form action or frame source
// decides its scheme, so a `javascript:` URL runs script. Only React 18 and older and Preact render
// these URLs as written; react-version.ts reads which one the project uses.
import { ts } from '../../performance/compiler.js';
import { rendersJavaScriptUrls } from './react-version.js';
import {
  MAX_DEPTH,
  declarationsOf,
  declaredInDefaultLibrary,
  declaredInitializer,
  memberChain,
  moduleOfDeclaration,
  originModule,
  untrustedMemberLabel,
  unwrap,
} from './frontend-security.js';
import type {
  BinaryExpression,
  CallExpression,
  ConditionalExpression,
  Expression,
  JsxAttribute,
  NewExpression,
  Node,
  TemplateExpression,
} from 'typescript';
import type { SecurityRuleContext } from '../../shared/types.js';

const LOCATION_BASES = ['location', 'window.location', 'self.location', 'document.location'];
const SCHEME_SAFE_PATHS = new Set([
  ...LOCATION_BASES.flatMap((base) =>
    ['href', 'pathname', 'origin', 'host', 'hostname'].map((member) => `${base}.${member}`),
  ),
  'document.URL',
  'document.documentURI',
  'document.referrer',
]);
// A host name cannot hold a scheme, so even a slice of it stays safe; a slice of the full address or
// path can (`/javascript:alert(1)`.slice(1)).
const HOST_MEMBERS = new Set(['origin', 'host', 'hostname']);
// `?q=1` and `#x` are relative URLs; only a slice or parse of them can start with a scheme.
const RELATIVE_PART_MEMBERS = new Set(['search', 'hash']);
// These keep what their input starts with: a decoded, case-converted or `String`-converted `#x`
// still starts with `#`, and `new URL(x)` keeps the scheme of `x`.
const PREFIX_PRESERVING_CALLS = new Set([
  'decodeURI',
  'decodeURIComponent',
  'unescape',
  'encodeURI',
  'String',
  'URL',
  'toLowerCase',
  'toUpperCase',
  'toLocaleLowerCase',
  'toLocaleUpperCase',
]);
// These escape `:`, so their output can never be read as a scheme unless a decoder around them
// restores it.
const SCHEME_ESCAPING_CALLS = new Set(['encodeURIComponent', 'escape']);
const COLON_DECODING_CALLS = new Set(['decodeURIComponent', 'unescape']);
// These can drop a constant start: `('/' + value).slice(1)` starts with `value`.
const PREFIX_CUTTING_METHODS = new Set(['slice', 'substring', 'substr', 'split']);
const SUBSTRING_METHODS = new Set(['slice', 'substring', 'substr']);
// The elements on which each attribute loads or navigates to its URL.
const URL_ATTRIBUTE_TAGS = new Map([
  ['href', new Set(['a', 'area'])],
  ['xlinkHref', new Set(['a'])],
  ['action', new Set(['form'])],
  ['formAction', new Set(['button', 'input'])],
  ['src', new Set(['iframe', 'frame', 'embed'])],
]);
const SEARCH_PARAM_READERS = new Set(['get', 'getAll']);
const SEARCH_PARAMS_MODULES = new Set(['next/navigation', 'react-router', 'react-router-dom']);
const NEXT_ROUTER_MODULE = 'next/router';
const NEXT_LINK_MODULE = 'next/link';
const URL_STRIPPED_CODE_POINT_LIMIT = 0x20;
const JAVASCRIPT_SCHEME = 'javascript:';
// URL parsing removes tabs and newlines anywhere in the input.
const URL_REMOVED_CHARACTERS = /[\t\n\r]/g;

const isIntrinsicTag = (tagName: string) => /^[a-z]/.test(tagName);

// Whether a constant start leaves the scheme open to what follows: `' '` is dropped by URL parsing,
// and `'java'` can still become `javascript:`. `/`, `#`, `?` or `https://` settle it.
function leavesSchemeOpen(text: string) {
  const firstKept = [...text].findIndex((character) => (character.codePointAt(0) ?? 0) > URL_STRIPPED_CODE_POINT_LIMIT);
  if (firstKept === -1) return true;
  const start = [...text].slice(firstKept).join('').replaceAll(URL_REMOVED_CHARACTERS, '').toLowerCase();
  return JAVASCRIPT_SCHEME.startsWith(start);
}

// Only a value at the start of a URL picks its scheme: `/search?q=${query}` can never become
// `javascript:`. The page's own address and referrer are always http(s) URLs, and an untouched
// `location.hash` or `location.search` starts with `#` or `?`.
// `transformed`: a call may have cut off the safe start of the page's own address. `prefixCut`: a
// call may have dropped a constant start, so the parts after it can lead. `decoded`: a decoder
// encloses the value and undoes an encoder's escaped `:`.
type TraceState = { transformed: boolean; prefixCut: boolean; decoded: boolean };

const untouched: TraceState = { transformed: false, prefixCut: false, decoded: false };

function isOwnAddress(node: Expression, context: SecurityRuleContext, transformed: boolean) {
  const chain = memberChain(node);
  if (!chain || !declaredInDefaultLibrary(chain.root, context)) return false;
  const member = ts.isPropertyAccessExpression(node) ? node.name.text : '';
  if (SCHEME_SAFE_PATHS.has(chain.path)) return !transformed || HOST_MEMBERS.has(member);
  return !transformed && RELATIVE_PART_MEMBERS.has(member);
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

// `' '`, `' ' + '\t'`: the text of a string built only from literals.
function literalText(node: Expression): string | undefined {
  const value = unwrap(node);
  if (ts.isStringLiteralLike(value)) return value.text;
  if (!ts.isBinaryExpression(value) || value.operatorToken.kind !== ts.SyntaxKind.PlusToken) return;
  const left = literalText(value.left);
  const right = left === undefined ? undefined : literalText(value.right);
  return left === undefined || right === undefined ? undefined : left + right;
}

// The bindings whose URL protocol a condition reads: `target` in
// `new URL(target, location.origin).protocol === 'https:'`.
function protocolCheckedBindings(condition: Expression, context: SecurityRuleContext) {
  const bindings = new Set<Node>();
  const visit = (node: Node) => {
    if (ts.isPropertyAccessExpression(node) && node.name.text === 'protocol') {
      const parsed = unwrap(node.expression);
      const input =
        ts.isNewExpression(parsed) && isGlobalUrl(parsed.expression, context) ? parsed.arguments?.[0] : undefined;
      const binding = input && ts.isIdentifier(unwrap(input)) ? declarationsOf(unwrap(input), context)[0] : undefined;
      if (binding) bindings.add(binding);
    }
    ts.forEachChild(node, visit);
  };
  visit(condition);
  return bindings;
}

function isGlobalUrl(callee: Expression, context: SecurityRuleContext) {
  const name = unwrap(callee);
  return ts.isIdentifier(name) && name.text === 'URL' && declaredInDefaultLibrary(name, context);
}

// A branch that renders the very binding the condition checked the protocol of is guarded.
function conditionalLeadSource(
  node: ConditionalExpression,
  context: SecurityRuleContext,
  next: (part: Expression) => string | undefined,
) {
  const checked = protocolCheckedBindings(node.condition, context);
  const unguarded = (branch: Expression) => {
    const value = unwrap(branch);
    return !(ts.isIdentifier(value) && checked.has(declarationsOf(value, context)[0]));
  };
  const whenTrue = unguarded(node.whenTrue) ? next(node.whenTrue) : undefined;
  return whenTrue ?? (unguarded(node.whenFalse) ? next(node.whenFalse) : undefined);
}

function templateLeadSource(
  node: TemplateExpression,
  state: TraceState,
  next: (part: Expression) => string | undefined,
) {
  if (!state.prefixCut) return leavesSchemeOpen(node.head.text) ? next(node.templateSpans[0].expression) : undefined;
  for (const span of node.templateSpans) {
    const source = next(span.expression);
    if (source) return source;
  }
}

// The part of a template, conditional or operator expression that starts the value.
function compoundLeadSource(
  node: TemplateExpression | ConditionalExpression | BinaryExpression,
  context: SecurityRuleContext,
  state: TraceState,
  next: (part: Expression) => string | undefined,
) {
  if (ts.isTemplateExpression(node)) return templateLeadSource(node, state, next);
  if (ts.isConditionalExpression(node)) return conditionalLeadSource(node, context, next);
  const operator = node.operatorToken.kind;
  if (operator === ts.SyntaxKind.PlusToken) {
    const left = unwrap(node.left);
    if (state.prefixCut) return next(left) ?? next(node.right);
    const prefix = literalText(left);
    if (prefix === undefined) return next(left);
    return leavesSchemeOpen(prefix) ? next(node.right) : undefined;
  }
  // `a && b` yields `b` whenever `a` is truthy; a falsy `a` cannot hold a scheme.
  if (operator === ts.SyntaxKind.AmpersandAmpersandToken) return next(node.right);
  const fallback = operator === ts.SyntaxKind.QuestionQuestionToken || operator === ts.SyntaxKind.BarBarToken;
  return fallback ? (next(node.left) ?? next(node.right)) : undefined;
}

// The untrusted source that decides a URL's scheme, or undefined when the value starts with a
// constant, is opaque or comes from the app itself. Only untrusted sources are reported: a prop or
// fetched link is how most apps render links.
function urlLeadSource(
  expression: Expression,
  context: SecurityRuleContext,
  depth = 0,
  state: TraceState = untouched,
): string | undefined {
  const node = unwrap(expression);
  if (!node || depth > MAX_DEPTH || isOwnAddress(node, context, state.transformed)) return;
  const next = (part: Expression) => urlLeadSource(part, context, depth + 1, state);
  if (ts.isTemplateExpression(node) || ts.isConditionalExpression(node) || ts.isBinaryExpression(node))
    return compoundLeadSource(node, context, state, next);
  const routerLabel = routerQueryLabel(node, context);
  if (routerLabel) return routerLabel;
  if (ts.isCallExpression(node) || ts.isNewExpression(node)) return leadOfLibraryCall(node, context, depth, state);
  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
    if (isParsedUrlHost(node, context)) return;
    const label = ts.isPropertyAccessExpression(node) ? untrustedMemberLabel(node, context) : undefined;
    return label ?? next(node.expression);
  }
  if (!ts.isIdentifier(node) || declaredInDefaultLibrary(node, context)) return;
  const initializer = declaredInitializer(node, context);
  return initializer && next(initializer);
}

// `new URL(x).origin` is `"null"` for a `javascript:` URL, and no host holds a scheme.
function isParsedUrlHost(node: Expression, context: SecurityRuleContext) {
  if (!ts.isPropertyAccessExpression(node) || !HOST_MEMBERS.has(node.name.text)) return false;
  return context.checker.getTypeAtLocation(node.expression).getSymbol()?.name === 'URL';
}

// A method such as `x.slice(1)` reads its receiver; a global function, even reached through
// `window.String(x)`, reads its first argument.
function callInput(call: CallExpression | NewExpression, nameNode: Node, context: SecurityRuleContext) {
  const callee = unwrap(call.expression);
  const isMethod =
    ts.isPropertyAccessExpression(callee) &&
    declarationsOf(nameNode, context).some(
      (declaration) => ts.isMethodSignature(declaration) || ts.isMethodDeclaration(declaration),
    );
  return isMethod ? callee.expression : call.arguments?.[0];
}

// `decodeURIComponent(x)`, `x.slice(1)`, `new URL(x)`: standard library calls pass their first
// input through; project functions (a `safeUrl` helper) are opaque.
function leadOfLibraryCall(
  call: CallExpression | NewExpression,
  context: SecurityRuleContext,
  depth: number,
  state: TraceState,
) {
  const callee = unwrap(call.expression);
  const nameNode = ts.isPropertyAccessExpression(callee) ? callee.name : callee;
  if (!ts.isIdentifier(nameNode) || !declaredInDefaultLibrary(nameNode, context)) return;
  const name = nameNode.text;
  const escapesColon = SCHEME_ESCAPING_CALLS.has(name);
  // `encodeURI` keeps `:` but escapes `%`, so an outer decoder only undoes this layer.
  const escapesPercent = name === 'encodeURI';
  if (escapesColon && !state.decoded) return;
  const input = callInput(call, nameNode, context);
  if (!input) return;
  const cutsStart = cutsPrefix(call, name);
  // `location.hash.slice(0, 80)` still starts with `#`.
  const keepsStart = SUBSTRING_METHODS.has(name) && !cutsStart;
  const keepsPrefix = escapesColon || keepsStart || PREFIX_PRESERVING_CALLS.has(name);
  return urlLeadSource(input, context, depth + 1, {
    transformed: state.transformed || !keepsPrefix,
    prefixCut: state.prefixCut || cutsStart,
    decoded: escapesColon || escapesPercent ? false : state.decoded || COLON_DECODING_CALLS.has(name),
  });
}

// `slice(1)` cuts; `slice(0, n)` keeps the start.
function cutsPrefix(call: CallExpression | NewExpression, name: string) {
  if (!PREFIX_CUTTING_METHODS.has(name) || !ts.isPropertyAccessExpression(unwrap(call.expression))) return false;
  const start = call.arguments?.[0];
  return !(start && ts.isNumericLiteral(start) && Number(start.text) === 0);
}

function urlAttributeOf(attribute: JsxAttribute) {
  if (!ts.isIdentifier(attribute.name)) return;
  const tagName = attribute.parent.parent.tagName;
  if (!ts.isIdentifier(tagName)) return;
  const name = attribute.name.text;
  if (!isIntrinsicTag(tagName.text)) return name === 'href' ? name : undefined;
  return URL_ATTRIBUTE_TAGS.get(name)?.has(tagName.text) ? name : undefined;
}

// Component links count only when they render a plain anchor: `<Link>` from next/link.
function isUrlSink(attribute: JsxAttribute, context: SecurityRuleContext) {
  const tagName = attribute.parent.parent.tagName;
  if (ts.isIdentifier(tagName) && isIntrinsicTag(tagName.text)) return true;
  return moduleOfDeclaration(declarationsOf(tagName, context)[0]) === NEXT_LINK_MODULE;
}

function checkJsxUrlAttribute(attribute: JsxAttribute, context: SecurityRuleContext) {
  const name = urlAttributeOf(attribute);
  const initializer = attribute.initializer;
  if (context.fileContext.isTestSource || !name || !initializer) return;
  if (!ts.isJsxExpression(initializer) || !initializer.expression) return;
  if (!isUrlSink(attribute, context)) return;
  const source = urlLeadSource(initializer.expression, context);
  if (!source || !rendersJavaScriptUrls(context.sourceFile.fileName)) return;
  context.report(
    attribute,
    'jsx-javascript-url',
    `${source} decides the scheme of \`${name}\`, so a \`javascript:\` URL runs script when the link or form is used (XSS). Allow only http(s) or relative URLs, for example \`new URL(value, location.origin).protocol === 'https:'\`, before rendering it.`,
  );
}

export { checkJsxUrlAttribute };
