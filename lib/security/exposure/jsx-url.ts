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
import type { CallExpression, Expression, JsxAttribute, NewExpression } from 'typescript';
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
// These keep what their input starts with: a decoded or `String`-converted `#x` still starts with
// `#`, and `new URL(x)` keeps the scheme of `x`.
const PREFIX_PRESERVING_CALLS = new Set(['decodeURI', 'decodeURIComponent', 'encodeURI', 'String', 'URL']);
// These escape `:`, so their output can never be read as a scheme.
const SCHEME_ESCAPING_CALLS = new Set(['encodeURIComponent', 'escape']);
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

const isIntrinsicTag = (tagName: string) => /^[a-z]/.test(tagName);

// URL parsing drops leading spaces and control characters, so `' ' + value` still starts with `value`.
function isStrippedUrlPrefix(text: string) {
  return [...text].every((character) => (character.codePointAt(0) ?? 0) <= URL_STRIPPED_CODE_POINT_LIMIT);
}

// Only a value at the start of a URL picks its scheme: `/search?q=${query}` can never become
// `javascript:`. The page's own address and referrer are always http(s) URLs, and an untouched
// `location.hash` or `location.search` starts with `#` or `?`.
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

// The untrusted source that decides a URL's scheme, or undefined when the value starts with a
// constant, is opaque or comes from the app itself. Only untrusted sources are reported: a prop or
// fetched link is how most apps render links. `transformed` records a call that may have cut off
// the safe start of the page's own address.
function urlLeadSource(
  expression: Expression,
  context: SecurityRuleContext,
  depth = 0,
  transformed = false,
): string | undefined {
  const node = unwrap(expression);
  if (!node || depth > MAX_DEPTH || isOwnAddress(node, context, transformed)) return;
  const next = (part: Expression) => urlLeadSource(part, context, depth + 1, transformed);
  if (ts.isTemplateExpression(node))
    return isStrippedUrlPrefix(node.head.text) ? next(node.templateSpans[0].expression) : undefined;
  if (ts.isConditionalExpression(node)) return next(node.whenTrue) ?? next(node.whenFalse);
  if (ts.isBinaryExpression(node)) {
    const operator = node.operatorToken.kind;
    if (operator === ts.SyntaxKind.PlusToken) {
      const left = unwrap(node.left);
      return ts.isStringLiteralLike(left) && isStrippedUrlPrefix(left.text) ? next(node.right) : next(left);
    }
    const fallback = operator === ts.SyntaxKind.QuestionQuestionToken || operator === ts.SyntaxKind.BarBarToken;
    return fallback ? (next(node.left) ?? next(node.right)) : undefined;
  }
  const routerLabel = routerQueryLabel(node, context);
  if (routerLabel) return routerLabel;
  if (ts.isCallExpression(node) || ts.isNewExpression(node))
    return leadOfLibraryCall(node, context, depth, transformed);
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
function leadOfLibraryCall(
  call: CallExpression | NewExpression,
  context: SecurityRuleContext,
  depth: number,
  transformed: boolean,
) {
  const callee = unwrap(call.expression);
  const nameNode = ts.isPropertyAccessExpression(callee) ? callee.name : callee;
  if (!ts.isIdentifier(nameNode) || !declaredInDefaultLibrary(nameNode, context)) return;
  if (SCHEME_ESCAPING_CALLS.has(nameNode.text)) return;
  const input = ts.isPropertyAccessExpression(callee) ? callee.expression : call.arguments?.[0];
  const keepsPrefix = PREFIX_PRESERVING_CALLS.has(nameNode.text);
  return input && urlLeadSource(input, context, depth + 1, transformed || !keepsPrefix);
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
