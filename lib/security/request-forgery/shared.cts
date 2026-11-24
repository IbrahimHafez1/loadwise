// Helpers shared by the request-forgery rules: argument and option lookup, response receivers, hop
// tiering, and the validation evidence that keeps a traced value quiet.
import { loadSyntax } from '../../performance/compiler.cjs';
import { importedFrom, stripExpression as strip } from '../bindings.cjs';
import { isLiteralList } from '../pg-identifier-guards.cjs';
import { isGuardedByCondition, isReassigned } from '../taint/guards.cjs';
import { argumentValidations } from '../taint/summaries.cjs';
import { isUrlConstructor } from '../taint/url-parts.cjs';
import type {
  CallExpression,
  Expression,
  Identifier,
  Node,
  PropertyAccessExpression,
  VariableDeclaration,
} from 'typescript';
import type { CheckerAdapter, SecurityRuleContext, Trace } from '../../shared/types.cjs';
const ts = loadSyntax();

const secondHopReason = 'Reached through two calls; confirm the intermediate functions do not validate the value.';
// Parameter names that hold an HTTP response (Express, Fastify, Koa, Hono) in practice.
const responseNames = new Set(['res', 'response', 'reply', 'ctx', 'context', 'c']);
// Response methods that return the response, so a chain through them still ends on it.
const chainedResponseMethods = new Set(['status', 'code', 'type', 'set', 'header', 'cookie', 'clearCookie']);
// Trace labels for the Host header: `req.headers.host`, `req.hostname`, `req.get('host')`,
// `@Headers('host') host`.
const hostHeaderLabel =
  /(?:headers?\W+(?:x-forwarded-)?host\b|\b(?:req|request|ctx)\.host(?:name)?\b|\.(?:get|header)\(['"`](?:x-forwarded-)?host['"`]|@HostParam)/i;

function nameText(name: Node | undefined): string | undefined {
  return name && (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) ? name.text : undefined;
}

// The value of property `name` in an object literal argument, for `{ url }` and `{ url: target }`.
function propertyValue(argument: Expression, name: string): Expression | undefined {
  const literal = strip(argument);
  if (!literal || !ts.isObjectLiteralExpression(literal)) return;
  for (const property of literal.properties) {
    if (ts.isPropertyAssignment(property) && nameText(property.name) === name) return property.initializer;
    if (ts.isShorthandPropertyAssignment(property) && property.name.text === name) return property.name;
  }
}

function hasProperty(argument: Expression, name: string): boolean {
  const literal = strip(argument);
  return Boolean(
    literal &&
    ts.isObjectLiteralExpression(literal) &&
    literal.properties.some((property) => !ts.isSpreadAssignment(property) && nameText(property.name) === name),
  );
}

function calleeName(call: CallExpression): string | undefined {
  const callee = strip(call.expression);
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
}

// `res.redirect(...)`: the receiver is an identifier named like a response, or `this.res`, possibly
// through chained setters such as `res.status(302).redirect(...)`.
function isResponseReceiver(expression: Expression): boolean {
  let receiver = strip(expression);
  while (
    ts.isCallExpression(receiver) &&
    ts.isPropertyAccessExpression(receiver.expression) &&
    chainedResponseMethods.has(receiver.expression.name.text)
  )
    receiver = strip(receiver.expression.expression);
  if (ts.isIdentifier(receiver)) return responseNames.has(receiver.text);
  return (
    ts.isPropertyAccessExpression(receiver) &&
    receiver.expression.kind === ts.SyntaxKind.ThisKeyword &&
    responseNames.has(receiver.name.text)
  );
}

// An identifier that is not declared by the project: a global such as `fetch` or `Response`.
function isGlobalIdentifier(identifier: Identifier, checker: CheckerAdapter): boolean {
  const declaration = checker.getSymbolAtLocation(identifier)?.declarations?.[0];
  return !declaration || declaration.getSourceFile().isDeclarationFile;
}

function isHostHeader(trace: Trace): boolean {
  return hostHeaderLabel.test(trace.label);
}

function hopReason(trace: Trace): string | undefined {
  return trace.hops >= 2 ? secondHopReason : undefined;
}

function constantDeclaration(identifier: Identifier, checker: CheckerAdapter): VariableDeclaration | undefined {
  const declaration = checker.getSymbolAtLocation(identifier)?.valueDeclaration;
  if (!declaration || !ts.isVariableDeclaration(declaration) || !declaration.initializer) return;
  return declaration.parent.flags & ts.NodeFlags.Const ? declaration : undefined;
}

// The body of the function around `sink`, or its source file.
function scopeOf(sink: Node): Node {
  const fn = ts.findAncestor(sink, ts.isFunctionLike);
  return (fn && 'body' in fn ? fn.body : undefined) ?? sink.getSourceFile();
}

function stableIdentifier(
  node: Expression,
  sink: Node,
  checker: CheckerAdapter,
  properties = false,
): Identifier | undefined {
  const value = strip(node);
  if (!value || !ts.isIdentifier(value)) return;
  const symbol = checker.getSymbolAtLocation(value);
  const declaration = symbol?.valueDeclaration;
  if (!symbol || !declaration || !(ts.isParameter(declaration) || constantDeclaration(value, checker))) return;
  if (!isReassigned(scopeOf(sink), symbol, checker, properties)) return value;
}

function sameValue(node: Expression | undefined, reference: Expression | undefined, checker: CheckerAdapter): boolean {
  const value = strip(node);
  const expected = strip(reference);
  if (!value || !expected) return false;
  if (ts.isStringLiteralLike(expected)) return ts.isStringLiteralLike(value) && value.text === expected.text;
  if (!ts.isIdentifier(value) || !ts.isIdentifier(expected)) return false;
  const symbol = checker.getSymbolAtLocation(expected);
  return !!symbol && checker.getSymbolAtLocation(value) === symbol;
}

/** `receiver.method(argument)` with exactly one argument. */
interface MethodCall {
  call: CallExpression;
  receiver: Expression;
}

function methodCall(node: Expression | undefined, method: string): MethodCall | undefined {
  if (!node || !ts.isCallExpression(node) || node.arguments.length !== 1) return;
  const callee = strip(node.expression);
  if (ts.isPropertyAccessExpression(callee) && callee.name.text === method)
    return { call: node, receiver: callee.expression };
}

function pathCall(node: Expression | undefined, method: string, context: SecurityRuleContext): node is CallExpression {
  if (!node || !ts.isCallExpression(node)) return false;
  const library = context.libraryCall(node);
  return library?.module === 'path' && (library.method ?? library.exported) === method;
}

function isPathSeparator(node: Expression, checker: CheckerAdapter): boolean {
  const value = strip(node);
  if (ts.isIdentifier(value)) {
    const binding = importedFrom(value, checker);
    return binding?.module === 'path' && binding.exported === 'sep';
  }
  return (
    ts.isPropertyAccessExpression(value) &&
    value.name.text === 'sep' &&
    importedFrom(strip(value.expression), checker)?.module === 'path'
  );
}

const separators = /[\\/]+/g;

// `'/srv/'` for `path.resolve('/srv', name)`: the literal root plus one trailing separator.
// resolve() output is normalized, so a prefix in the other platform's separator style never matches
// and fails closed.
function isRootWithSeparator(prefixText: string, root: Expression): boolean {
  if (!ts.isStringLiteralLike(root) || !/[\\/]$/.test(prefixText)) return false;
  const directory = root.text.replaceAll(separators, '/').replace(/\/$/, '');
  return directory !== '' && prefixText.replaceAll(separators, '/') === `${directory}/`;
}

// A path starts inside the resolved root only after the directory boundary, or when its relative
// path is neither an upward traversal nor an absolute path (which can happen across Windows
// drives).
function isContainedPath(sink: Node, expression: Expression, context: SecurityRuleContext): boolean {
  const { checker, taint } = context;
  const target = stableIdentifier(expression, sink, checker);
  const resolved = target && strip(constantDeclaration(target, checker)?.initializer);
  if (!pathCall(resolved, 'resolve', context) || resolved.arguments.length < 2) return false;
  const root = strip(resolved.arguments[0]);
  if (
    !((ts.isStringLiteralLike(root) && root.text) || stableIdentifier(root, sink, checker)) ||
    taint.trace(root, 'path') ||
    taint.trace(root, 'archive-path')
  ) {
    return false;
  }

  function relativeToRoot(node: Expression | undefined): boolean {
    const value = strip(node);
    const alias = value && ts.isIdentifier(value) && stableIdentifier(value, sink, checker);
    const relative = alias ? strip(constantDeclaration(alias, checker)?.initializer) : value;
    return (
      pathCall(relative, 'relative', context) &&
      sameValue(relative.arguments[0], root, checker) &&
      sameValue(relative.arguments[1], target, checker)
    );
  }

  const boundedPrefix = (condition: Expression, truth: boolean) => {
    const found = methodCall(condition, 'startsWith');
    if (!truth || !found || !sameValue(found.receiver, target, checker)) return false;
    const prefix = strip(found.call.arguments[0]);
    if (prefix && ts.isStringLiteralLike(prefix)) return isRootWithSeparator(prefix.text, root);
    return (
      prefix !== undefined &&
      ts.isBinaryExpression(prefix) &&
      prefix.operatorToken.kind === ts.SyntaxKind.PlusToken &&
      sameValue(prefix.left, root, checker) &&
      isPathSeparator(prefix.right, checker)
    );
  };
  const rejectsParent = (condition: Expression, truth: boolean) => {
    const found = methodCall(condition, 'startsWith');
    if (truth || !found) return false;
    const prefix = strip(found.call.arguments[0]);
    return ts.isStringLiteralLike(prefix) && prefix.text === '..' && relativeToRoot(found.receiver);
  };
  const rejectsAbsolute = (condition: Expression, truth: boolean) =>
    !truth && pathCall(condition, 'isAbsolute', context) && relativeToRoot(condition.arguments[0]);
  const rejectsParentDirectory = (condition: Expression, truth: boolean) => {
    const found = methodCall(condition, 'startsWith');
    if (truth || !found) return false;
    const prefix = strip(found.call.arguments[0]);
    if (!ts.isBinaryExpression(prefix) || prefix.operatorToken.kind !== ts.SyntaxKind.PlusToken) return false;
    const left = strip(prefix.left);
    return (
      ts.isStringLiteralLike(left) &&
      left.text === '..' &&
      isPathSeparator(prefix.right, checker) &&
      relativeToRoot(found.receiver)
    );
  };
  const rejectsParentValue = (condition: Expression, truth: boolean) => {
    if (!ts.isBinaryExpression(condition)) return false;
    const equality = truth ? ts.SyntaxKind.ExclamationEqualsEqualsToken : ts.SyntaxKind.EqualsEqualsEqualsToken;
    if (condition.operatorToken.kind !== equality) return false;
    const left = strip(condition.left);
    const right = strip(condition.right);
    return (
      (ts.isStringLiteralLike(left) && left.text === '..' && relativeToRoot(right)) ||
      (ts.isStringLiteralLike(right) && right.text === '..' && relativeToRoot(left))
    );
  };
  return (
    isGuardedByCondition(sink, boundedPrefix) ||
    (isGuardedByCondition(sink, rejectsAbsolute) &&
      (isGuardedByCondition(sink, rejectsParent) ||
        (isGuardedByCondition(sink, rejectsParentValue) && isGuardedByCondition(sink, rejectsParentDirectory))))
  );
}

function checkedAgainstLiteral(
  condition: Expression,
  truth: boolean,
  matches: (node: Expression) => boolean,
  checker: CheckerAdapter,
): boolean {
  if (ts.isCallExpression(condition) && condition.arguments.length === 1 && truth) {
    const list = methodCall(condition, 'has') ?? methodCall(condition, 'includes');
    return list !== undefined && matches(condition.arguments[0]) && isLiteralList(list.receiver, checker);
  }
  if (!ts.isBinaryExpression(condition)) return false;
  const sides = [strip(condition.left), strip(condition.right)];
  const equality = truth ? ts.SyntaxKind.EqualsEqualsEqualsToken : ts.SyntaxKind.ExclamationEqualsEqualsToken;
  return (
    condition.operatorToken.kind === equality &&
    ((matches(sides[0]) && ts.isStringLiteralLike(sides[1])) || (matches(sides[1]) && ts.isStringLiteralLike(sides[0])))
  );
}

// The same value: identifiers of one symbol, or property chains such as `req.query.next` with the
// same names.
function sameReference(node: Expression, reference: Expression, checker: CheckerAdapter): boolean {
  const value = strip(node);
  const expected = strip(reference);
  if (!value || !expected) return false;
  if (ts.isPropertyAccessExpression(expected))
    return (
      ts.isPropertyAccessExpression(value) &&
      value.name.text === expected.name.text &&
      sameReference(value.expression, expected.expression, checker)
    );
  return sameValue(value, expected, checker);
}

// The values a sink argument is built from: identifiers and request property chains, without callee
// names.
function referencedValues(expression: Expression): (Identifier | PropertyAccessExpression)[] {
  const values: (Identifier | PropertyAccessExpression)[] = [];
  (function visit(node: Node): void {
    const value = strip(node);
    if (ts.isIdentifier(value) || ts.isPropertyAccessExpression(value)) values.push(value);
    else ts.forEachChild(value, visit);
  })(expression);
  return values;
}

function validatesValue(
  call: Expression,
  value: Expression,
  kinds: readonly string[],
  modes: readonly string[],
  context: SecurityRuleContext,
): boolean {
  if (!call || !ts.isCallExpression(call)) return false;
  return argumentValidations(call, context.program).some(
    ({ argument, kind, mode }) =>
      kinds.includes(kind) && modes.includes(mode) && sameReference(argument, value, context.checker),
  );
}

// `assertSafe(value);` as an earlier statement of a block around the sink.
function precededByAssertion(
  sink: Node,
  value: Expression,
  kinds: readonly string[],
  context: SecurityRuleContext,
): boolean {
  for (
    let child: Node = sink, parent: Node = sink.parent;
    parent && !ts.isFunctionLike(child);
    child = parent, parent = parent.parent
  ) {
    if (!ts.isBlock(parent)) continue;
    const earlier = parent.statements.slice(
      0,
      parent.statements.findIndex((statement) => statement === child),
    );
    const asserted = earlier.some(
      (statement) =>
        ts.isExpressionStatement(statement) &&
        validatesValue(strip(statement.expression), value, kinds, ['throws'], context),
    );
    if (asserted) return true;
  }
  return false;
}

// A project helper accepted the value (see lib/shared/function-summaries.cjs) before the sink, by
// condition or by throwing. Helpers that return a sanitized copy are handled by the taint engine,
// which then traces nothing.
function isProjectValidated(
  sink: Node,
  expression: Expression,
  kinds: readonly string[],
  context: SecurityRuleContext,
): boolean {
  return referencedValues(expression).some(
    (value) =>
      isGuardedByCondition(
        sink,
        (condition, truth) => truth && validatesValue(strip(condition), value, kinds, ['boolean', 'throws'], context),
      ) || precededByAssertion(sink, value, kinds, context),
  );
}

const hostFields = new Set(['hostname', 'host', 'origin']);
const urlValueProperties = new Set([...hostFields, 'href', 'protocol', 'port', 'pathname', 'search', 'hash']);

function urlReferenceEscapes(sink: Node, target: Identifier, checker: CheckerAdapter): boolean {
  const scope = scopeOf(sink);
  const declaration = checker.getSymbolAtLocation(target)?.valueDeclaration;
  if (!declaration) return true;
  if (declaration.getStart() < scope.getStart()) return true;
  const declaredName = 'name' in declaration ? declaration.name : undefined;
  const sinkStart = sink.getStart();
  return Boolean(
    (function visit(node: Node): boolean | undefined {
      if (node.getStart() >= sinkStart) return false;
      if (node !== declaredName && ts.isIdentifier(node) && sameValue(node, target, checker)) {
        const parent = node.parent;
        return !ts.isPropertyAccessExpression(parent) || !urlValueProperties.has(parent.name.text);
      }
      return ts.forEachChild(node, visit);
    })(scope),
  );
}

function isAllowedHost(sink: Node, expression: Expression, context: SecurityRuleContext, hostOnly: boolean): boolean {
  const { checker } = context;
  const target = stableIdentifier(expression, sink, checker, !hostOnly);
  if (!target) return false;
  if (!hostOnly) {
    const parsed = strip(constantDeclaration(target, checker)?.initializer);
    if (
      !parsed ||
      !ts.isNewExpression(parsed) ||
      !isUrlConstructor(strip(parsed.expression), checker) ||
      urlReferenceEscapes(sink, target, checker)
    ) {
      return false;
    }
  }
  function matches(node: Expression) {
    if (hostOnly) return sameValue(node, target, checker);
    const property = strip(node);
    return (
      ts.isPropertyAccessExpression(property) &&
      hostFields.has(property.name.text) &&
      sameValue(property.expression, target, checker)
    );
  }
  return isGuardedByCondition(sink, (condition, truth) => checkedAgainstLiteral(condition, truth, matches, checker));
}

// Reject characters the URL parser treats as alternate separators or removes before interpreting
// the path.
const redirectSeparators = /[\\\t\r\n]/;

function isRelativeRedirect(sink: Node, expression: Expression, context: SecurityRuleContext): boolean {
  const { checker } = context;
  const target = stableIdentifier(expression, sink, checker);
  if (!target) return false;
  const matches = (node: Expression) => sameValue(node, target, checker);
  if (isGuardedByCondition(sink, (condition, truth) => checkedAgainstLiteral(condition, truth, matches, checker))) {
    return true;
  }
  const prefix = (condition: Expression, expected: string) => {
    const found = methodCall(condition, 'startsWith');
    if (!found) return false;
    const value = strip(found.call.arguments[0]);
    return ts.isStringLiteralLike(value) && value.text === expected && matches(found.receiver);
  };
  const unsafeSeparator = (condition: Expression) => {
    const found = methodCall(condition, 'test');
    if (!found) return false;
    const pattern = strip(found.receiver);
    return (
      ts.isRegularExpressionLiteral(pattern) &&
      pattern.text === redirectSeparators.toString() &&
      matches(found.call.arguments[0])
    );
  };
  return (
    isGuardedByCondition(sink, (condition, truth) => truth && prefix(condition, '/')) &&
    isGuardedByCondition(sink, (condition, truth) => !truth && prefix(condition, '//')) &&
    isGuardedByCondition(sink, (condition, truth) => !truth && unsafeSeparator(condition))
  );
}

export {
  strip,
  scopeOf,
  nameText,
  propertyValue,
  hasProperty,
  calleeName,
  isResponseReceiver,
  isGlobalIdentifier,
  hopReason,
  isHostHeader,
  constantDeclaration,
  isContainedPath,
  isAllowedHost,
  isRelativeRedirect,
  isProjectValidated,
};
