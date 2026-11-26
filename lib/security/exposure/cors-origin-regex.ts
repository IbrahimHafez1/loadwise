// cors-origin-regex-unanchored: a CORS origin regex that a look-alike host also passes.
import { ts } from '../../performance/compiler.js';
import { unwrap, findProperty, isTrue, methodName } from './literals.js';
import type { CallExpression, Expression, Node, ObjectLiteralExpression } from 'typescript';
import type { FixResult, SecurityRuleContext, SiteFixInput } from '../../shared/types.js';

const ruleId = 'cors-origin-regex-unanchored';
const message =
  'This CORS origin regex is not tied to the whole host, so a look-alike origin such as evilexample.com or example.com.evil.com also passes. Anchor the pattern and escape its dots, or compare against an exact list of origins.';
const withoutCredentialsReason =
  'Credentials are not allowed, so a matching foreign origin only reads what it could fetch without cookies.';
const fixNote =
  'Anchors the host so only the listed domain and its subdomains match, and escapes its dots. Check that every origin you serve still matches, including ports.';
// Host labels joined by `\.`, `[.]` or an unescaped `.` that is not a wildcard, ending in a
// top-level domain.
const hostPattern = /(?:[a-z0-9-]+(?:\\\.|\[\.\]|\.(?![*+?{])))+[a-z][a-z0-9-]*/gi;
// What may follow the host before `$`: a port, a trailing slash and group closings.
const portSuffixPattern = /^(?:[():?]|\\d|\[0-9\]|[+*]|\{\d+(?:,\d*)?\}|\\\/|\\:)*$/;
// What may precede the host: a scheme separator, a subdomain dot or a group such as `(www\.)?` or
// `(^|\.)`.
const boundaryBeforeHost = /(?:\^|\\\/\\\/|\/\/|\\\.|\[\.\]|\)[?*+]?)$/;
const subdomainBoundary = '(?:\\/\\/|\\.)';
const originNamePattern = /^(?:req(?:uest)?)?origin$/i;
const originHeaderPattern = /headers(?:\.origin|\[\s*['"]origin['"]\s*\])|\.(?:get|header)\(\s*['"]origin['"]\s*\)/i;
// A `new RegExp(...)` argument named like a pattern is meant to be a regex, so its author owns the
// anchoring.
const intentionalPatternName = /regex|regexp|pattern/i;

// Splits a regex source on `|` outside groups and character classes.
function topLevelBranches(source: string): string[] {
  const branches: string[] = [];
  let depth = 0;
  let inClass = false;
  let start = 0;
  for (let index = 0; index < source.length; index++) {
    const character = source[index];
    if (character === '\\') index++;
    else if (inClass) inClass = character !== ']';
    else if (character === '[') inClass = true;
    else if (character === '(') depth++;
    else if (character === ')') depth--;
    else if (character === '|' && depth === 0) {
      branches.push(source.slice(start, index));
      start = index + 1;
    }
  }
  branches.push(source.slice(start));
  return branches;
}

function hostsOf(branch: string) {
  return [...branch.matchAll(hostPattern)].filter((match) => branch[match.index - 1] !== '\\');
}

const hasUnescapedDot = (host: string) => /(?:^|[^\\])\.(?![*+?{])/.test(host);

interface BranchFlaws {
  dots: boolean;
  start: boolean;
  end: boolean;
  startFixable: boolean;
  endFixable: boolean;
}

// The flaws of one alternative: { dots, start, end } with fixable flags, or undefined when it names
// no host.
function branchFlaws(branch: string): BranchFlaws | undefined {
  const hosts = hostsOf(branch);
  if (!hosts.length) return;
  const first = hosts[0];
  const last = hosts[hosts.length - 1];
  const prefix = branch.slice(0, first.index);
  const suffix = branch.slice(last.index + last[0].length);
  const anchoredEnd = suffix.endsWith('$') && portSuffixPattern.test(suffix.slice(0, -1));
  return {
    dots: hosts.some((host) => hasUnescapedDot(host[0])),
    start: !boundaryBeforeHost.test(prefix),
    end: !anchoredEnd,
    startFixable: prefix === '',
    endFixable: !suffix.endsWith('$') && portSuffixPattern.test(suffix),
  };
}

function patternFlaws(source: string) {
  const flaws = topLevelBranches(source)
    .map(branchFlaws)
    .filter((flaw): flaw is BranchFlaws => flaw !== undefined);
  return flaws.some((flaw) => flaw.dots || flaw.start || flaw.end) ? flaws : undefined;
}

const regexParts = (literalText: string) => {
  const closing = literalText.lastIndexOf('/');
  return { source: literalText.slice(1, closing), flags: literalText.slice(closing + 1) };
};

function isFlawedRegexLiteral(node: Node) {
  return ts.isRegularExpressionLiteral(node) && patternFlaws(regexParts(node.text).source) !== undefined;
}

// The fixed literal when every flaw has one reading; undefined otherwise.
function fixedRegexLiteral(literalText: string): string | undefined {
  const { source, flags } = regexParts(literalText);
  const branches = topLevelBranches(source);
  const [flaws] = branches.map(branchFlaws);
  if (branches.length !== 1 || !flaws) return;
  if ((flaws.start && !flaws.startFixable) || (flaws.end && !flaws.endFixable)) return;
  const escaped = source.replaceAll(hostPattern, (host: string, offset: number) =>
    source[offset - 1] === '\\' ? host : host.replaceAll(/(^|[^\\])\.(?![*+?{])/g, '$1\\.'),
  );
  const anchored = `${flaws.start ? subdomainBoundary : ''}${escaped}${flaws.end ? '$' : ''}`;
  return anchored === source ? undefined : `/${anchored}/${flags}`;
}

// Site-fix builder: rewrites the flagged regex literal.
function buildFix({ node, sourceFile }: SiteFixInput): FixResult | undefined {
  const text = node?.getText(sourceFile);
  if (!node || !text?.startsWith('/')) return;
  const fixed = fixedRegexLiteral(text);
  if (!fixed) return;
  return {
    edits: [{ start: node.getStart(sourceFile), end: node.end, text: fixed }],
    note: fixNote,
    requiresReview: true,
  };
}

// The initializer of a `const` the identifier names, in this file.
function constInitializer(node: Node, context: SecurityRuleContext): Expression | undefined {
  if (!ts.isIdentifier(node)) return;
  const declaration = context.checker.getSymbolAtLocation(node)?.valueDeclaration;
  if (!declaration || !ts.isVariableDeclaration(declaration) || !(declaration.parent.flags & ts.NodeFlags.Const))
    return;
  if (declaration.getSourceFile() !== context.sourceFile) return;
  return unwrap(declaration.initializer);
}

// `origin: /re/`, `origin: [/re/, 'https://a.example.com']` or a `const` holding either.
function checkOriginOption(options: ObjectLiteralExpression, context: SecurityRuleContext) {
  const origin = findProperty(options, 'origin');
  if (!origin) return;
  const value = unwrap(origin.value);
  const resolved = (value && constInitializer(value, context)) ?? value;
  if (!resolved) return;
  const candidates = ts.isArrayLiteralExpression(resolved)
    ? resolved.elements.map((element) => unwrap(element))
    : [resolved];
  const credentials = findProperty(options, 'credentials');
  const hasSpread = options.properties.some(ts.isSpreadAssignment);
  const reason = isTrue(credentials?.value) || hasSpread ? undefined : withoutCredentialsReason;
  for (const candidate of candidates)
    if (isFlawedRegexLiteral(candidate)) context.report(candidate, ruleId, message, reason);
}

function isRequestOrigin(expression: Expression, context: SecurityRuleContext) {
  const node = unwrap(expression);
  if (!node) return false;
  if (ts.isIdentifier(node) && originNamePattern.test(node.text)) return true;
  const initializer = ts.isIdentifier(node) ? constInitializer(node, context) : node;
  return !!initializer && originHeaderPattern.test(initializer.getText());
}

// `new RegExp(process.env.FRONT_BASE_URL)`: a URL used as a pattern, unescaped and unanchored.
function isUnescapedDynamicPattern(node: Node) {
  if (!ts.isNewExpression(node) || !ts.isIdentifier(node.expression) || node.expression.text !== 'RegExp') return false;
  const [pattern] = node.arguments ?? [];
  if (!pattern) return false;
  const value = unwrap(pattern);
  if (ts.isStringLiteralLike(value) || ts.isCallExpression(value) || ts.isTemplateExpression(value)) return false;
  return !intentionalPatternName.test(value.getText());
}

// `/re/.test(origin)`, `allowed.test(req.headers.origin)` where `const allowed = /re/` or `new
// RegExp(url)`.
function checkTestCall(call: CallExpression, context: SecurityRuleContext) {
  if (methodName(call) !== 'test' || call.arguments.length !== 1) return;
  const callee = unwrap(call.expression);
  if (!ts.isPropertyAccessExpression(callee) || !isRequestOrigin(call.arguments[0], context)) return;
  const receiver = unwrap(callee.expression);
  const pattern = ts.isRegularExpressionLiteral(receiver) ? receiver : constInitializer(receiver, context);
  if (!pattern) return;
  if (isFlawedRegexLiteral(pattern) || isUnescapedDynamicPattern(pattern)) context.report(pattern, ruleId, message);
}

export { checkOriginOption, checkTestCall, buildFix, fixedRegexLiteral };
