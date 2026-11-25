import {
  ts,
  ancestor,
  calleeCall,
  freshName,
  indentationAt,
  isPlainReference,
  requireReview,
  textOf,
} from './helpers.js';
import type { CallExpression, Node, PropertyAccessExpression, PropertyAssignment } from 'typescript';
import type { FixResult, SiteFixInput } from '../../shared/types.js';

// The generated field and helper names, each free in the file.
interface LookupNames {
  cache: string;
  ttl: string;
  limit: string;
  loader: string;
}

const CACHE_TTL_SECONDS = 30;
// Written into the generated field as is, digit separator included.
const MAX_CACHED_LOOKUPS = '10_000';
const typedExtensions = /\.[cm]?tsx?$/i;
// A guard that enforces revocation, roles or account state must see changes at once; a cached row
// would keep a revoked token or a removed role working until the TTL ends.
const accessStateWords = /revok|role|permission|tokenVersion|banned|blocked|suspend|disabled|isActive|deactivat/i;

const literalKinds = new Set([ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword, ts.SyntaxKind.NullKeyword]);

function isLiteral(node: Node): boolean {
  return ts.isStringLiteralLike(node) || ts.isNumericLiteral(node) || literalKinds.has(node.kind);
}

// A value that names the row: a variable or property chain, or a literal.
function isKeyPart(node: Node): boolean {
  return isPlainReference(node) || isLiteral(node);
}

// The variable values, which tell lookups apart; literals are the same on every request.
function variableParts(values: Node[]): Node[] | undefined {
  if (!values.every(isKeyPart)) return;
  const parts = values.filter((value) => !isLiteral(value));
  return parts.length ? parts : undefined;
}

// Option text without variables, such as `select: { id: true }`, means the same thing on every
// request.
function isConstant(node: Node): boolean {
  let constant = true;
  (function visit(child: Node): void {
    if (!constant) return;
    if (ts.isIdentifier(child)) {
      const parent = child.parent;
      const isName =
        (ts.isPropertyAssignment(parent) && parent.name === child) ||
        (ts.isPropertyAccessExpression(parent) && parent.name === child);
      if (!isName && child.text !== 'undefined') constant = false;
      return;
    }
    if (child.kind === ts.SyntaxKind.ThisKeyword || ts.isCallExpression(child)) constant = false;
    else ts.forEachChild(child, visit);
  })(node);
  return constant;
}

// The values that identify the looked-up row, or undefined when the query depends on anything else.
function keyParts(where: Node): Node[] | undefined {
  if (!ts.isObjectLiteralExpression(where) || !where.properties.length) return;
  const values: Node[] = [];
  for (const property of where.properties) {
    if (ts.isShorthandPropertyAssignment(property)) values.push(property.name);
    else if (ts.isPropertyAssignment(property)) values.push(ts.skipOuterExpressions(property.initializer));
    else return;
  }
  return variableParts(values);
}

function lookupKey(call: CallExpression, access: PropertyAccessExpression): Node[] | undefined {
  const method = access.name.text;
  const [first, ...rest] = call.arguments;
  if (!first) return;
  if (method === 'query') {
    const values = rest[0];
    if (!ts.isStringLiteralLike(first) || rest.length !== 1 || !ts.isArrayLiteralExpression(values)) return;
    return variableParts([...values.elements]);
  }
  const options = ts.skipOuterExpressions(first);
  if (rest.length || !ts.isObjectLiteralExpression(options)) return;
  if (method.endsWith('By')) return keyParts(options);
  const whereProperty = options.properties.find(
    (property): property is PropertyAssignment =>
      ts.isPropertyAssignment(property) && textOf(property.name) === 'where',
  );
  if (!whereProperty) return;
  const others = options.properties.filter((property) => property !== whereProperty);
  if (!others.every((property) => ts.isPropertyAssignment(property) && isConstant(property.initializer))) return;
  return keyParts(ts.skipOuterExpressions(whereProperty.initializer));
}

function receiverLabel(access: PropertyAccessExpression): string | undefined {
  const receiver = access.expression;
  const name = ts.isPropertyAccessExpression(receiver) ? receiver.name.text : textOf(receiver);
  return /^\w+$/.test(name) ? name : undefined;
}

function capitalized(name: string): string {
  return name[0].toUpperCase() + name.slice(1);
}

function fieldLines(names: LookupNames, typed: boolean): string[] {
  const { cache, ttl, limit } = names;
  const modifiers = typed ? 'private readonly ' : '';
  const map = typed ? 'new Map<string, { expiresAt: number; value: unknown }>()' : 'new Map()';
  return [
    '// Guards run on every request, so this lookup is reused for a few seconds.',
    `${modifiers}${cache} = ${map};`,
    `${modifiers}${ttl} = ${CACHE_TTL_SECONDS}_000;`,
    `${modifiers}${limit} = ${MAX_CACHED_LOOKUPS};`,
    '',
  ];
}

function helperLines(names: LookupNames, typed: boolean): string[] {
  const { cache, ttl, limit, loader } = names;
  const signature = typed
    ? `private async ${loader}<T>(key: string, load: () => Promise<T>): Promise<T> {`
    : `async ${loader}(key, load) {`;
  return [
    '',
    signature,
    `  const cached = this.${cache}.get(key);`,
    `  if (cached && cached.expiresAt > Date.now()) return cached.value${typed ? ' as T' : ''};`,
    '  const value = await load();',
    '  if (value === null || value === undefined) return value;',
    `  if (this.${cache}.size >= this.${limit}) this.${cache}.clear();`,
    `  this.${cache}.set(key, { expiresAt: Date.now() + this.${ttl}, value });`,
    '  return value;',
    '}',
  ];
}

function guardQueryFix({ node, sourceFile, text }: SiteFixInput): FixResult | undefined {
  if (!node || !sourceFile || text === undefined) return;
  const call = calleeCall(node);
  if (!call || !ts.isPropertyAccessExpression(call.expression)) return;
  const parts = lookupKey(call, call.expression);
  const label = receiverLabel(call.expression);
  const classNode = ancestor(call, ts.isClassDeclaration);
  if (!parts || !label || !classNode || accessStateWords.test(classNode.getText(sourceFile))) return;
  const cache = freshName(sourceFile, `${label}LookupCache`);
  const ttl = freshName(sourceFile, `${label}LookupTtlMs`);
  const limit = freshName(sourceFile, `${label}LookupMaxEntries`);
  const loader = freshName(sourceFile, `getOrLoad${capitalized(label)}`);
  if (!cache || !ttl || !limit || !loader) return;
  const names: LookupNames = { cache, ttl, limit, loader };
  const typed = typedExtensions.test(sourceFile.fileName);
  const key = '`' + parts.map((part) => '${' + textOf(part) + '}').join(':') + '`';
  const classIndent = indentationAt(text, classNode.getStart(sourceFile));
  const memberIndent = classNode.members.length
    ? indentationAt(text, classNode.members[0].getStart(sourceFile))
    : classIndent + '  ';
  const openBrace = classNode.members.pos - 1;
  const afterOpenLine = text.indexOf('\n', openBrace) + 1;
  const closeLine = text.lastIndexOf('\n', classNode.end - 1) + 1;
  // New members go on lines of their own, so both braces must end and start their lines.
  if (text[openBrace] !== '{' || text.slice(openBrace + 1, afterOpenLine).trim()) return;
  if (closeLine <= afterOpenLine || text.slice(closeLine, classNode.end).trim() !== '}') return;
  const indentLines = (lines: string[]): string =>
    lines.map((line) => (line ? memberIndent + line : '') + '\n').join('');
  return {
    edits: [
      {
        start: afterOpenLine,
        end: afterOpenLine,
        text: indentLines(fieldLines(names, typed)),
      },
      { start: call.getStart(sourceFile), end: call.getStart(sourceFile), text: `this.${names.loader}(${key}, () => ` },
      { start: call.end, end: call.end, text: ')' },
      { start: closeLine, end: closeLine, text: indentLines(helperLines(names, typed)) },
    ],
    note: `Caches this lookup for ${CACHE_TTL_SECONDS} s per guard instance and per process, keyed by ${key}; missing rows are not cached. A change to the row (status, role, token version, slug) shows up only after the TTL, so clear \`this.${names.cache}\` where it changes, or lower \`${names.ttl}\`, if that delay is not acceptable. Requests share the cached object, so do not mutate it.`,
  };
}

export default {
  'guard-query-per-request': requireReview(
    'Adds a cache with a chosen TTL, so changed rows show up late.',
    guardQueryFix,
  ),
};
