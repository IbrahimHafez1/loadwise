import { ts } from '../performance/compiler.js';
import { walkNodes } from './walk.js';
import { isAccess, isIgnoredSource, withoutParentheses } from './source-helpers.js';
import type { AccessExpression } from './source-helpers.js';
import type {
  CallExpression,
  Expression,
  IfStatement,
  Node,
  PropertyAccessExpression,
  SourceFile,
  Statement,
} from 'typescript';
import type { CheckerAdapter, Finding, TypeAdapter } from '../shared/types.js';

type BoundarySource = 'request input' | 'parsed JSON' | 'response data';

// How far below the untyped value the first read that can throw sits: `req.body.user` is fine,
// `req.body.user.email` is the second level.
const FIRST_RISKY_DEPTH = 2;
const MAX_ALIAS_DEPTH = 3;
const requestMembers = new Set(['body', 'query', 'params']);
const contextMembers = new Set(['query', 'params']);
const requestParameterDecorators = new Set(['Body', 'Query', 'Param']);
// DOM lookups are left out: a missing element is a page-structure matter, not outside input.
const nullableLookupMethods = new Set(['find', 'get']);
// Calls that show the same receiver was checked for the value before it was looked up.
const presenceMethods = new Set(['some', 'includes']);
const assertionFunctions = new Set(['assert', 'invariant']);
// Property names that can start an untyped chain (`req.body`, `ctx.query`, `response.data`).
const untypedRootMembers = new Set([...requestMembers, ...contextMembers, 'data']);
// Tool configuration reads its own project's files.
const configFile = /\.config\.[cm]?[jt]sx?$/;
const mapTypeNames = new Set(['Map', 'WeakMap']);
const domElementType = /^(?:HTML|SVG)?\w*Element$/;

function identifierNamed(node: Node, pattern: RegExp | string): boolean {
  return ts.isIdentifier(node) && (typeof pattern === 'string' ? node.text === pattern : pattern.test(node.text));
}

function isRequestInput(node: PropertyAccessExpression): boolean {
  if (!requestMembers.has(node.name.text)) return false;
  const receiver = ts.skipOuterExpressions(node.expression);
  if (identifierNamed(receiver, /^req(?:uest)?$/)) return true;
  // Koa keeps the request one level down: `ctx.request.body`.
  return (
    ts.isPropertyAccessExpression(receiver) &&
    receiver.name.text === 'request' &&
    identifierNamed(receiver.expression, /^(?:ctx|context)$/)
  );
}

function isKoaContextInput(node: PropertyAccessExpression): boolean {
  return (
    contextMembers.has(node.name.text) && identifierNamed(ts.skipOuterExpressions(node.expression), /^(?:ctx|context)$/)
  );
}

// A project reading its own manifest controls that file; it is not outside input.
const ownManifest = /package\.json/;

function isJsonParse(call: CallExpression): boolean {
  const callee = call.expression;
  return (
    ts.isPropertyAccessExpression(callee) &&
    identifierNamed(callee.expression, 'JSON') &&
    callee.name.text === 'parse' &&
    !ownManifest.test(call.getText())
  );
}

// `await response.json()`: the body of a fetch or Request is untyped until validated.
function isAwaitedJson(node: Expression): boolean {
  if (!ts.isAwaitExpression(node)) return false;
  const call = ts.skipOuterExpressions(node.expression);
  return (
    ts.isCallExpression(call) &&
    call.arguments.length === 0 &&
    ts.isPropertyAccessExpression(call.expression) &&
    call.expression.name.text === 'json'
  );
}

const axiosImportByFile = new WeakMap<SourceFile, boolean>();

// Cached because every `.data` read in the file asks.
function importsAxios(sourceFile: SourceFile): boolean {
  const cached = axiosImportByFile.get(sourceFile);
  if (cached !== undefined) return cached;
  const imports = /['"]axios['"]/.test(sourceFile.text);
  axiosImportByFile.set(sourceFile, imports);
  return imports;
}

function constInitializerOf(declaration: Node | undefined): Expression | undefined {
  if (!declaration || !ts.isVariableDeclaration(declaration) || !declaration.initializer) return;
  // The native compiler has no getCombinedNodeFlags; a const declaration's list carries the flag.
  const declarationList = declaration.parent;
  if (!ts.isIdentifier(declaration.name) || !(declarationList.flags & ts.NodeFlags.Const)) return;
  return declaration.initializer;
}

function constInitializer(node: Node, checker: CheckerAdapter): Expression | undefined {
  return constInitializerOf(checker.getSymbolAtLocation(node)?.valueDeclaration);
}

// axios resolves `await axios.get(url)` to a response whose `data` is `any`.
function isAxiosData(node: PropertyAccessExpression, checker: CheckerAdapter): boolean {
  if (node.name.text !== 'data' || !importsAxios(node.getSourceFile())) return false;
  const receiver = ts.skipOuterExpressions(node.expression);
  const awaited = ts.isIdentifier(receiver) ? constInitializer(receiver, checker) : receiver;
  return awaited !== undefined && ts.isAwaitExpression(ts.skipOuterExpressions(awaited));
}

function isImportDeclaration(declaration: Node): boolean {
  return (
    ts.isImportSpecifier(declaration) ||
    ts.isImportClause(declaration) ||
    ts.isNamespaceImport(declaration) ||
    ts.isImportEqualsDeclaration(declaration)
  );
}

// `private client: AxiosInstance`: a declared type that is itself imported.
function isDeclaredWithImportedType(declaration: Node | undefined, checker: CheckerAdapter): boolean {
  if (!declaration || !(ts.isPropertyDeclaration(declaration) || ts.isParameter(declaration))) return false;
  const typeNode = declaration.type;
  if (!typeNode || !ts.isTypeReferenceNode(typeNode)) return false;
  const typeName = ts.isIdentifier(typeNode.typeName) ? typeNode.typeName : typeNode.typeName.right;
  return Boolean(checker.getSymbolAtLocation(typeName)?.declarations?.some(isImportDeclaration));
}

// Whether the value is read from an import, directly or through `const` locals (`const response = await client.get()`).
function derivesFromImport(expression: Node, checker: CheckerAdapter, aliasDepth = 0): boolean {
  const current = ts.isExpression(expression) ? ts.skipOuterExpressions(expression) : expression;
  if (ts.isIdentifier(current)) {
    const symbol = checker.getSymbolAtLocation(current);
    if (symbol?.declarations?.some(isImportDeclaration)) return true;
    if (isDeclaredWithImportedType(symbol?.valueDeclaration, checker)) return true;
    const initializer = constInitializerOf(symbol?.valueDeclaration);
    return (
      aliasDepth < MAX_ALIAS_DEPTH &&
      initializer !== undefined &&
      derivesFromImport(initializer, checker, aliasDepth + 1)
    );
  }
  if (
    ts.isPropertyAccessExpression(current) &&
    isDeclaredWithImportedType(checker.getSymbolAtLocation(current.name)?.valueDeclaration, checker)
  )
    return true;
  if (ts.isAwaitExpression(current) || ts.isCallExpression(current) || isAccess(current))
    return derivesFromImport(current.expression, checker, aliasDepth);
  return false;
}

// A receiver typed `any` that comes from an import is most likely a module that did not resolve, so what it holds is
// unknown rather than known to be untyped outside input.
function hasUnknownReceiver(node: PropertyAccessExpression, checker: CheckerAdapter): boolean {
  return (
    Boolean(checker.getTypeAtLocation(node.expression).flags & ts.TypeFlags.Any) &&
    derivesFromImport(node.expression, checker)
  );
}

function rootSource(node: Node, checker: CheckerAdapter): BoundarySource | undefined {
  if (ts.isCallExpression(node) && isJsonParse(node)) return 'parsed JSON';
  if (ts.isAwaitExpression(node) && isAwaitedJson(node)) return 'parsed JSON';
  if (!ts.isPropertyAccessExpression(node) || hasUnknownReceiver(node, checker)) return;
  if (isRequestInput(node) || isKoaContextInput(node)) return 'request input';
  if (isAxiosData(node, checker)) return 'response data';
}

function hasRequestDecorator(declaration: Node): boolean {
  if (!ts.isParameter(declaration)) return false;
  return (ts.getDecorators(declaration) ?? []).some((decorator) => {
    const expression = ts.isCallExpression(decorator.expression)
      ? decorator.expression.expression
      : decorator.expression;
    return ts.isIdentifier(expression) && requestParameterDecorators.has(expression.text);
  });
}

interface Boundary {
  depth: number;
  source: BoundarySource;
}

// How many reads below an untyped outside value `expression` sits, following `const` aliases such as
// `const body = req.body`. Optional chaining anywhere on the way means the author already guards.
function boundaryOf(expression: Expression, checker: CheckerAdapter, aliasDepth = 0): Boundary | undefined {
  const current = ts.skipOuterExpressions(expression);
  const source = rootSource(current, checker);
  if (source) return { depth: 0, source };
  if (ts.isIdentifier(current)) return aliasBoundary(current, checker, aliasDepth);
  if (!isAccess(current) || current.questionDotToken) return;
  const inner = boundaryOf(current.expression, checker, aliasDepth);
  return inner && { ...inner, depth: inner.depth + 1 };
}

function aliasBoundary(identifier: Node, checker: CheckerAdapter, aliasDepth: number): Boundary | undefined {
  if (aliasDepth >= MAX_ALIAS_DEPTH) return;
  const declaration = checker.getSymbolAtLocation(identifier)?.valueDeclaration;
  if (declaration && hasRequestDecorator(declaration)) return { depth: 0, source: 'request input' };
  const initializer = constInitializerOf(declaration);
  return initializer && boundaryOf(initializer, checker, aliasDepth + 1);
}

function isNullish(type: TypeAdapter): boolean {
  return Boolean(type.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null));
}

// Without strictNullChecks the compiler drops `undefined` from lookup results, so a result type with
// no undefined in it is one the compiler cannot warn about.
function isUnwarnedResult(type: TypeAdapter): boolean {
  if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Never)) return false;
  if (isNullish(type)) return false;
  return !(type.isUnion() && type.types?.some(isNullish));
}

function isNullableLookup(call: CallExpression, checker: CheckerAdapter): boolean {
  const callee = call.expression;
  if (!ts.isPropertyAccessExpression(callee) || !nullableLookupMethods.has(callee.name.text)) return false;
  const result = checker.getTypeAtLocation(call);
  if (!isUnwarnedResult(result)) return false;
  const receiverType = checker.getTypeAtLocation(callee.expression);
  const method = callee.name.text;
  if (method === 'find') return call.arguments.length > 0 && checker.isArrayType(receiverType);
  if (method === 'get') return mapTypeNames.has(receiverType.getSymbol()?.name ?? '') && call.arguments.length === 1;
  return domElementType.test(result.getSymbol()?.name ?? '');
}

function lookupCall(expression: Expression, checker: CheckerAdapter): CallExpression | undefined {
  const call = withoutParentheses(expression);
  return ts.isCallExpression(call) && isNullableLookup(call, checker) ? call : undefined;
}

// `arr.find(...).name`, or `const user = arr.find(...); user.name`.
function lookupSubject(access: AccessExpression, checker: CheckerAdapter): Expression | undefined {
  const receiver = withoutParentheses(access.expression);
  if (ts.isCallExpression(receiver)) return lookupCall(receiver, checker) && receiver;
  if (!ts.isIdentifier(receiver)) return;
  const initializer = constInitializer(receiver, checker);
  return initializer && lookupCall(initializer, checker) && receiver;
}

function normalized(text: string): string {
  return text.replaceAll(/\s+/g, '').replaceAll('?.', '.');
}

// What a guard has to look at: the subject's own text, and for a lookup call such as `map.get(key)` also the
// receiver and keys, because `map.has(key)` or `list.some(...)` guards it without ever repeating the call.
interface GuardSubject {
  text: string;
  lookup?: { receiver: string; keys: string };
  // For `req.body.user`: `'user' in req.body` guards it without ever repeating the read.
  member?: { receiver: string; name: string };
}

function memberOf(access: AccessExpression, sourceFile: SourceFile): GuardSubject['member'] {
  const receiver = normalized(access.expression.getText(sourceFile));
  if (ts.isPropertyAccessExpression(access)) return { receiver, name: access.name.text };
  const key = access.argumentExpression;
  return ts.isStringLiteralLike(key) ? { receiver, name: key.text } : undefined;
}

function guardSubjectOf(subject: Expression, sourceFile: SourceFile): GuardSubject {
  const text = normalized(subject.getText(sourceFile));
  const call = withoutParentheses(subject);
  if (isAccess(call)) return { text, member: memberOf(call, sourceFile) };
  if (!ts.isCallExpression(call) || !ts.isPropertyAccessExpression(call.expression)) return { text };
  return {
    text,
    lookup: {
      receiver: normalized(call.expression.expression.getText(sourceFile)),
      keys: normalizedArguments(call, sourceFile),
    },
  };
}

function normalizedArguments(call: CallExpression, sourceFile: SourceFile): string {
  return normalized(call.arguments.map((argument) => argument.getText(sourceFile)).join(','));
}

function isLookupGuardCall(
  call: CallExpression,
  lookup: NonNullable<GuardSubject['lookup']>,
  sourceFile: SourceFile,
): boolean {
  const callee = call.expression;
  if (!ts.isPropertyAccessExpression(callee)) return false;
  if (normalized(callee.expression.getText(sourceFile)) !== lookup.receiver) return false;
  if (presenceMethods.has(callee.name.text)) return true;
  return callee.name.text === 'has' && normalizedArguments(call, sourceFile) === lookup.keys;
}

function isMembershipTest(node: Node, member: NonNullable<GuardSubject['member']>, sourceFile: SourceFile): boolean {
  return (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.InKeyword &&
    ts.isStringLiteralLike(node.left) &&
    node.left.text === member.name &&
    normalized(node.right.getText(sourceFile)) === member.receiver
  );
}

function matchesSubject(node: Node, subject: GuardSubject, sourceFile: SourceFile): boolean {
  if (subject.member && isMembershipTest(node, subject.member, sourceFile)) return true;
  if (!(ts.isIdentifier(node) || isAccess(node) || ts.isCallExpression(node))) return false;
  if (normalized(node.getText(sourceFile)) === subject.text) return true;
  return (
    ts.isCallExpression(node) && subject.lookup !== undefined && isLookupGuardCall(node, subject.lookup, sourceFile)
  );
}

function mentions(root: Node, subject: GuardSubject, sourceFile: SourceFile): boolean {
  let found = false;
  walkNodes(root, (node: Node) => {
    if (!found) found = matchesSubject(node, subject, sourceFile);
  });
  return found;
}

function exitsEarly(statement: Statement): boolean {
  let found = false;
  walkNodes(statement, (node: Node) => {
    if (
      ts.isReturnStatement(node) ||
      ts.isThrowStatement(node) ||
      ts.isContinueStatement(node) ||
      ts.isBreakStatement(node)
    )
      found = true;
  });
  return found;
}

// `assert(x)`, `invariant(x)` and `assert.ok(x)` throw when the check fails.
function assertionCall(statement: Statement): CallExpression | undefined {
  if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) return;
  const callee = statement.expression.expression;
  if (ts.isIdentifier(callee) && assertionFunctions.has(callee.text)) return statement.expression;
  const isAssertOk =
    ts.isPropertyAccessExpression(callee) && identifierNamed(callee.expression, 'assert') && callee.name.text === 'ok';
  return isAssertOk ? statement.expression : undefined;
}

// Writes the subject itself (`user = {}`), or for a lookup stores under its key (`map.set(key, value)`).
function setsSubject(node: Node, subject: GuardSubject, sourceFile: SourceFile): boolean {
  if (ts.isBinaryExpression(node))
    return node.operatorToken.kind === ts.SyntaxKind.EqualsToken && matchesSubject(node.left, subject, sourceFile);
  if (!ts.isCallExpression(node) || !subject.lookup || !ts.isPropertyAccessExpression(node.expression)) return false;
  const callee = node.expression;
  const [key] = node.arguments;
  return (
    callee.name.text === 'set' &&
    key !== undefined &&
    normalized(callee.expression.getText(sourceFile)) === subject.lookup.receiver &&
    normalized(key.getText(sourceFile)) === subject.lookup.keys
  );
}

function establishes(root: Node, subject: GuardSubject, sourceFile: SourceFile): boolean {
  let found = false;
  walkNodes(root, (node: Node) => {
    if (!found) found = setsSubject(node, subject, sourceFile);
  });
  return found;
}

function isNegation(expression: Expression): boolean {
  const value = withoutParentheses(expression);
  return ts.isPrefixUnaryExpression(value) && value.operator === ts.SyntaxKind.ExclamationToken;
}

// An early exit, or the get-or-create idiom `if (!map.has(key)) map.set(key, value)`.
function ifGuards(statement: IfStatement, subject: GuardSubject, sourceFile: SourceFile): boolean {
  if (!mentions(statement.expression, subject, sourceFile)) return false;
  return (
    exitsEarly(statement.thenStatement) ||
    (isNegation(statement.expression) && establishes(statement.thenStatement, subject, sourceFile))
  );
}

// `cache.get(key) || cache.set(key, value)` and `req.body.user ??= {}` leave the subject present.
function fallbackEstablishes(expression: Expression, subject: GuardSubject, sourceFile: SourceFile): boolean {
  const value = withoutParentheses(expression);
  if (!ts.isBinaryExpression(value)) return false;
  const kind = value.operatorToken.kind;
  if (kind === ts.SyntaxKind.QuestionQuestionEqualsToken || kind === ts.SyntaxKind.BarBarEqualsToken)
    return matchesSubject(withoutParentheses(value.left), subject, sourceFile);
  const isFallback = kind === ts.SyntaxKind.BarBarToken || kind === ts.SyntaxKind.QuestionQuestionToken;
  return isFallback && mentions(value.left, subject, sourceFile) && establishes(value.right, subject, sourceFile);
}

function guardsLater(statement: Statement, subject: GuardSubject, sourceFile: SourceFile): boolean {
  if (ts.isIfStatement(statement)) return ifGuards(statement, subject, sourceFile);
  if (ts.isExpressionStatement(statement) && fallbackEstablishes(statement.expression, subject, sourceFile))
    return true;
  const assertion = assertionCall(statement);
  return assertion !== undefined && mentions(assertion, subject, sourceFile);
}

function precedingStatementGuards(parent: Node, child: Node, subject: GuardSubject, sourceFile: SourceFile): boolean {
  if (!ts.isBlock(parent) && !ts.isSourceFile(parent) && !ts.isCaseClause(parent) && !ts.isDefaultClause(parent))
    return false;
  const index = parent.statements.findIndex((statement: Statement) => statement === child);
  return parent.statements
    .slice(0, Math.max(index, 0))
    .some((statement: Statement) => guardsLater(statement, subject, sourceFile));
}

// Whether `child`, one step below `parent`, only runs when the surrounding condition has looked at
// the subject.
function conditionGuards(parent: Node, child: Node, subject: GuardSubject, sourceFile: SourceFile): boolean {
  if (ts.isIfStatement(parent) && child !== parent.expression) return mentions(parent.expression, subject, sourceFile);
  if (ts.isConditionalExpression(parent) && child !== parent.condition)
    return mentions(parent.condition, subject, sourceFile);
  if (ts.isWhileStatement(parent) && child === parent.statement)
    return mentions(parent.expression, subject, sourceFile);
  if (!ts.isBinaryExpression(parent) || child !== parent.right) return false;
  const kind = parent.operatorToken.kind;
  const isShortCircuit =
    kind === ts.SyntaxKind.AmpersandAmpersandToken ||
    kind === ts.SyntaxKind.BarBarToken ||
    kind === ts.SyntaxKind.QuestionQuestionToken;
  return isShortCircuit && mentions(parent.left, subject, sourceFile);
}

function isCaughtBy(parent: Node, child: Node): boolean {
  return ts.isTryStatement(parent) && parent.tryBlock === child && parent.catchClause !== undefined;
}

// An enclosing try/catch (inside the same function), an enclosing condition that checks the subject, or an
// earlier `if (!subject) return` keeps absent data from reaching the read.
function isGuarded(access: AccessExpression, subject: Expression, sourceFile: SourceFile): boolean {
  const guardSubject = guardSubjectOf(subject, sourceFile);
  let insideSameFunction = true;
  for (let child: Node = access, parent = access.parent; parent; child = parent, parent = parent.parent) {
    if (insideSameFunction && isCaughtBy(parent, child)) return true;
    if (conditionGuards(parent, child, guardSubject, sourceFile)) return true;
    if (precedingStatementGuards(parent, child, guardSubject, sourceFile)) return true;
    if (ts.isFunctionLike(parent)) insideSameFunction = false;
  }
  return false;
}

function isUntypedReceiver(access: AccessExpression, checker: CheckerAdapter): boolean {
  return Boolean(checker.getTypeAtLocation(access.expression).flags & ts.TypeFlags.Any);
}

interface RiskyAccess {
  subject: Expression;
  message: string;
}

const boundaryAdvice =
  ' Absent data throws a TypeError here; read it with optional chaining and handle the missing case, or validate the value first.';

function isSyntacticRoot(node: Expression): boolean {
  if (ts.isCallExpression(node)) return isJsonParse(node);
  if (ts.isAwaitExpression(node)) return isAwaitedJson(node);
  return ts.isPropertyAccessExpression(node) && untypedRootMembers.has(node.name.text);
}

// Syntax-only superset of `boundaryOf` reaching depth 2: the chain below the expression ends at an untyped root,
// or at an identifier no more than `maxReads` reads away that may be a `const` alias (only the checker can tell).
function mayReadUntypedInput(expression: Expression, maxReads: number, mayBeAlias: (name: string) => boolean): boolean {
  let current = expression;
  for (let reads = 0; ; reads++) {
    current = ts.skipOuterExpressions(current);
    if (isSyntacticRoot(current)) return true;
    if (ts.isIdentifier(current)) return reads <= maxReads && mayBeAlias(current.text);
    if (!isAccess(current) || current.questionDotToken) return false;
    current = current.expression;
  }
}

function isLookupCallSyntax(expression: Expression): boolean {
  const call = withoutParentheses(expression);
  return (
    ts.isCallExpression(call) &&
    ts.isPropertyAccessExpression(call.expression) &&
    nullableLookupMethods.has(call.expression.name.text)
  );
}

const aliasNamesByFile = new WeakMap<SourceFile, ReadonlySet<string>>();

// Names in the file that may hold an untyped outside value or a lookup result: request-decorated parameters
// and `const` names initialised from a root, a lookup call or another such name (repeated until no more join).
// Only the checker can say which are real, but a read rooted at any other name never needs it.
function aliasCandidateNames(sourceFile: SourceFile): ReadonlySet<string> {
  const cached = aliasNamesByFile.get(sourceFile);
  if (cached) return cached;
  const names = new Set<string>();
  const constants: { name: string; initializer: Expression }[] = [];
  walkNodes(sourceFile, (node: Node) => {
    if (ts.isParameter(node) && ts.isIdentifier(node.name) && hasRequestDecorator(node)) names.add(node.name.text);
    const initializer = constInitializerOf(node);
    if (initializer && ts.isVariableDeclaration(node) && ts.isIdentifier(node.name))
      constants.push({ name: node.name.text, initializer });
  });
  const isAliasName = (name: string) => names.has(name);
  for (let grew = true; grew;) {
    grew = false;
    for (const { name, initializer } of constants) {
      if (names.has(name)) continue;
      if (!isLookupCallSyntax(initializer) && !mayReadUntypedInput(initializer, Infinity, isAliasName)) continue;
      names.add(name);
      grew = true;
    }
  }
  aliasNamesByFile.set(sourceFile, names);
  return names;
}

// Syntax-only superset of `lookupSubject`: a call to a lookup method, or an identifier that may alias one.
function mayReadLookupResult(access: AccessExpression, sourceFile: SourceFile): boolean {
  const receiver = withoutParentheses(access.expression);
  if (ts.isIdentifier(receiver)) return aliasCandidateNames(sourceFile).has(receiver.text);
  return isLookupCallSyntax(receiver);
}

// Checker calls are the expensive part and most reads are neither, so rule them out by syntax first.
function mayBeRisky(access: AccessExpression, sourceFile: SourceFile): boolean {
  const mayBeAlias = (name: string) => aliasCandidateNames(sourceFile).has(name);
  return mayReadUntypedInput(access, FIRST_RISKY_DEPTH, mayBeAlias) || mayReadLookupResult(access, sourceFile);
}

function riskyAccess(
  access: AccessExpression,
  checker: CheckerAdapter,
  sourceFile: SourceFile,
): RiskyAccess | undefined {
  if (access.questionDotToken || !mayBeRisky(access, sourceFile)) return;
  const boundary = boundaryOf(access, checker);
  if (boundary?.depth === FIRST_RISKY_DEPTH && isUntypedReceiver(access, checker)) {
    return {
      subject: access.expression,
      message: `\`${access.getText()}\` reads two levels into ${boundary.source} that has no declared type, so the compiler cannot warn when \`${access.expression.getText()}\` is missing.${boundaryAdvice}`,
    };
  }
  const subject = lookupSubject(access, checker);
  if (!subject) return;
  return {
    subject,
    message: `\`${subject.getText()}\` can be missing (find, Map#get and DOM lookups return nothing when there is no match), and this file is not checked with strictNullChecks, so the compiler does not warn.${boundaryAdvice}`,
  };
}

function reportPosition(access: AccessExpression): number {
  return ts.isPropertyAccessExpression(access) ? access.name.getStart() : access.argumentExpression.getStart();
}

function checkBoundaryAccess(sourceFile: SourceFile, file: string, checker: CheckerAdapter): Finding[] {
  if (isIgnoredSource(sourceFile, file) || configFile.test(file)) return [];
  const findings: Finding[] = [];
  // One finding per missing value is enough: the same value read again two lines later is the same mistake.
  const reported = new Set<string>();
  walkNodes(sourceFile, (node: Node) => {
    if (!isAccess(node)) return;
    const risky = riskyAccess(node, checker, sourceFile);
    if (!risky || isGuarded(node, risky.subject, sourceFile)) return;
    const scope = ts.findAncestor(node, ts.isFunctionLike) ?? sourceFile;
    const key = `${scope.pos}:${scope.end}:${normalized(risky.subject.getText(sourceFile))}`;
    if (reported.has(key)) return;
    reported.add(key);
    const position = sourceFile.getLineAndCharacterOfPosition(reportPosition(node));
    findings.push({
      file,
      line: position.line + 1,
      column: position.character + 1,
      ruleId: 'unguarded-boundary-access',
      message: risky.message,
    });
  });
  return findings;
}

export { checkBoundaryAccess };
