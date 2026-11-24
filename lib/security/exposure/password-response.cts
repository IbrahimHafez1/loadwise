// password-hash-in-response: a request handler sends a record read from the ORM without a field
// selection, and the record's type still holds a password or hash field. The read may sit one hop
// away, in a constructor-injected service method that returns it whole.
import { loadSyntax } from '../../performance/compiler.cjs';
import { enclosingRequestHandler } from '../../performance/request-handlers.cjs';
import { bodyOf } from '../declarations.cjs';
import { unwrap, objectLiteralOf, findProperty, methodName, nameText } from './literals.cjs';
import type {
  CallExpression,
  Decorator,
  Identifier,
  Node,
  ObjectLiteralExpression,
  PropertyAccessExpression,
  SourceFile,
} from 'typescript';
import type { CheckerAdapter, ProgramAdapter, SecurityRuleContext, SymbolAdapter } from '../../shared/types.cjs';
import type { InspectableType } from '../types/inspectable-type.cjs';
const ts = loadSyntax();

const ruleId = 'password-hash-in-response';
const passwordField = /^(?:password|passwordHash|hashedPassword|password_hash|hash)$/i;
const ormReadMethods = new Set([
  'findUnique',
  'findUniqueOrThrow',
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'create',
  'update',
  'findOne',
  'findOneBy',
  'findOneOrFail',
  'findOneByOrFail',
  'save',
  'findById',
  'findByPk',
]);
const ormModules = new Set(['@prisma/client', 'typeorm', 'mongoose', 'sequelize', 'sequelize-typescript']);
// Prisma clients are usually local instances (`prisma.user`, `this.prisma.user`), so their shape
// names them.
const prismaReceiver = /\bprisma\w*\.\w+$/i;
// Any of these in the options narrows the columns read, so the result is judged clean.
const selectionOptions = ['select', 'omit', 'attributes', 'projection'];
// Mongoose and Sequelize take a projection or options object second; it may drop the field.
const projectionMethods = new Set(['findOne', 'findById', 'findByPk']);
// Query-builder steps that keep the whole document: `User.findById(id).lean().exec()`.
const passThroughChainMethods = new Set(['exec', 'lean', 'populate', 'orFail']);
const responseReceiver = /^(?:res|response|reply|ctx|c|NextResponse|Response)$/;
const responseMethods = new Set(['json', 'send', 'jsonp']);
const maxAliasDepth = 3;
// A schema option, default scope or serializer transform anywhere in the project hides the field
// from every read.
const projectHidesPassword = [
  /\b(?:password|passwordHash|hashedPassword|password_hash|hash)\s*:\s*\{[^{}]*\bselect\s*:\s*false/i,
  /defaultScope[\s\S]{0,400}?\bexclude\b/,
  /set\(\s*['"]toJSON['"]|toJSON\s*:\s*\{\s*transform/,
];
const hiddenFieldDecorators = new Set(['Exclude']);
const projectCache = new WeakMap<ProgramAdapter, boolean>();

function describe(field: string) {
  return `A user record read without a field selection is sent in the response with its \`${field}\` field, so the password hash reaches the client. Return only safe fields: select the fields you need or omit the password hash.`;
}

function fileHidesPassword(file: SourceFile) {
  if (file.isDeclarationFile || /[\\/]node_modules[\\/]/.test(file.fileName)) return false;
  return projectHidesPassword.some((pattern) => pattern.test(file.text));
}

function programHidesPassword(program: ProgramAdapter) {
  if (!projectCache.has(program))
    projectCache.set(
      program,
      (program.getSourceFiles?.() ?? program.getToolingSourceFiles?.() ?? []).some(fileHidesPassword),
    );
  return projectCache.get(program);
}

function isOrmCall(call: CallExpression, context: SecurityRuleContext) {
  const callee = unwrap(call.expression);
  if (!ts.isPropertyAccessExpression(callee)) return false;
  if (prismaReceiver.test(unwrap(callee.expression).getText())) return true;
  const module = context.libraryCall(call)?.module;
  return module !== undefined && ormModules.has(module);
}

function selectsFields(call: CallExpression, context: SecurityRuleContext) {
  const method = methodName(call);
  if (method !== undefined && projectionMethods.has(method) && call.arguments.length > 1) return true;
  const options = objectLiteralOf(call.arguments[0], context.checker);
  return Boolean(options && selectionOptions.some((name) => findProperty(options, name)));
}

function decoratorName(decorator: Decorator) {
  const callee = ts.isCallExpression(decorator.expression) ? decorator.expression.expression : decorator.expression;
  return ts.isIdentifier(callee) ? callee.text : undefined;
}

// `@Column({ select: false })`, `@Prop({ select: false })` or class-transformer `@Exclude()` on the
// field.
function isHiddenByDecorator(decorator: Decorator) {
  const name = decoratorName(decorator);
  if (name !== undefined && hiddenFieldDecorators.has(name)) return true;
  const options = ts.isCallExpression(decorator.expression) ? unwrap(decorator.expression.arguments[0]) : undefined;
  if (!options || !ts.isObjectLiteralExpression(options)) return false;
  return findProperty(options, 'select')?.value.kind === ts.SyntaxKind.FalseKeyword;
}

function isHiddenField(symbol: SymbolAdapter) {
  return (symbol.declarations ?? []).some((declaration) =>
    (ts.canHaveDecorators(declaration) ? (ts.getDecorators(declaration) ?? []) : []).some(isHiddenByDecorator),
  );
}

// A `toJSON` written in the project decides what the record serializes to.
function hasOwnToJson(type: InspectableType) {
  return (type.getProperty('toJSON')?.declarations ?? []).some((declaration) => {
    const file = declaration.getSourceFile();
    return !file.isDeclarationFile && !/[\\/]node_modules[\\/]/.test(file.fileName);
  });
}

function recordTypes(type: InspectableType, checker: CheckerAdapter): readonly InspectableType[] {
  const awaited = checker.getNonNullableType(checker.getAwaitedType(type) ?? type);
  const element = checker.isArrayType(awaited) ? checker.getTypeArguments(awaited)[0] : awaited;
  return element.isUnion() && element.types ? element.types : [element];
}

// The password-like field the read result exposes, or undefined.
function exposedPasswordField(call: CallExpression, checker: CheckerAdapter): string | undefined {
  for (const record of recordTypes(checker.getTypeAtLocation(call), checker)) {
    if (record.flags & ts.TypeFlags.Any || hasOwnToJson(record)) continue;
    const field = record.getProperties?.().find((property) => passwordField.test(property.name));
    if (field && !isHiddenField(field)) return field.name;
  }
}

function isResponseCall(call: CallExpression) {
  const callee = unwrap(call.expression);
  if (!ts.isPropertyAccessExpression(callee) || !responseMethods.has(callee.name.text)) return false;
  let receiver = unwrap(callee.expression);
  while (ts.isCallExpression(receiver)) {
    const inner = unwrap(receiver.expression);
    if (!ts.isPropertyAccessExpression(inner)) break;
    receiver = unwrap(inner.expression);
  }
  return ts.isIdentifier(receiver) && responseReceiver.test(receiver.text);
}

// `{ ...user, password: undefined }` overrides the field it spreads in.
function overridesPassword(literal: ObjectLiteralExpression) {
  return literal.properties.some((property) => property.name && passwordField.test(nameText(property.name) ?? ''));
}

function isPassThroughChain(access: PropertyAccessExpression) {
  const call = access.parent;
  return ts.isCallExpression(call) && call.expression === access && passThroughChainMethods.has(access.name.text);
}

// `delete user.password`, `user.password = undefined` or `user = sanitize(user)` before the
// response.
function isStrippingUse(use: Node) {
  const outer = outermostWrapper(use);
  const parent = outer.parent;
  if (ts.isBinaryExpression(parent) && parent.left === outer) return true;
  if (!ts.isPropertyAccessExpression(parent) || parent.expression !== outer || !passwordField.test(parent.name.text))
    return false;
  const holder = parent.parent;
  return ts.isDeleteExpression(holder) || (ts.isBinaryExpression(holder) && holder.left === parent);
}

// `(user as any)` or `user!` around a use.
function outermostWrapper(node: Node): Node {
  let outer = node;
  while (
    ts.isParenthesizedExpression(outer.parent) ||
    ts.isAsExpression(outer.parent) ||
    ts.isNonNullExpression(outer.parent)
  )
    outer = outer.parent;
  return outer;
}

// `{ user }` names the property, so the variable it reads comes from the shorthand lookup.
function referencedSymbol(identifier: Identifier, checker: CheckerAdapter) {
  return ts.isShorthandPropertyAssignment(identifier.parent)
    ? checker.getShorthandAssignmentValueSymbol(identifier.parent)
    : checker.getSymbolAtLocation(identifier);
}

function usesOf(name: Identifier, handler: Node, checker: CheckerAdapter): Identifier[] {
  const symbol = checker.getSymbolAtLocation(name);
  const found: Identifier[] = [];
  const body = bodyOf(handler);
  if (!body) return found;
  (function visit(node: Node): void {
    if (ts.isIdentifier(node) && node !== name && referencedSymbol(node, checker) === symbol) found.push(node);
    ts.forEachChild(node, visit);
  })(body);
  return found;
}

function aliasReachesResponse(name: Node, handler: Node, checker: CheckerAdapter, depth: number): boolean {
  if (!ts.isIdentifier(name) || depth >= maxAliasDepth) return false;
  const uses = usesOf(name, handler, checker);
  if (uses.some(isStrippingUse)) return false;
  return uses.some((use) => reachesResponse(use, handler, checker, depth + 1));
}

// True when a project function returns its `argIndex` parameter whole, possibly wrapped, without
// stripping the password (`res.json(envelope(user))`). Declared or library functions are treated as
// mappers.
function helperPreservesValue(call: CallExpression, argIndex: number, checker: CheckerAdapter): boolean {
  if (argIndex < 0) return false;
  const fn = checker.getResolvedSignature(call)?.declaration;
  if (!fn || !ts.isFunctionLike(fn) || !bodyOf(fn) || fn.getSourceFile().isDeclarationFile) return false;
  const param = fn.parameters[argIndex];
  if (!param || !ts.isIdentifier(param.name)) return false;
  const uses = usesOf(param.name, fn, checker);
  if (!uses.length || uses.some(isStrippingUse)) return false;
  return uses.some((use) => {
    for (
      let current: Node = use, parent: Node | undefined = use.parent;
      parent && parent !== fn;
      current = parent, parent = parent.parent
    ) {
      if (ts.isReturnStatement(parent)) return ts.findAncestor(parent, ts.isFunctionLike) === fn;
      if (ts.isArrowFunction(parent) && parent.body === current) return parent === fn;
      if (ts.isObjectLiteralExpression(parent) && overridesPassword(parent)) return false;
      if (!isTransparent(parent, current)) return false;
    }
    return false;
  });
}

// True when `value` is sent whole: returned from the handler or passed to `res.json`, possibly
// wrapped in an object or array or stored in a local first. Field reads, method calls and calls to
// mappers or DTOs stop the walk; a project helper that returns the value whole is followed one call
// deep.
function reachesResponse(value: Node, handler: Node, checker: CheckerAdapter, depth = 0): boolean {
  for (
    let current: Node = value, parent: Node | undefined = value.parent;
    parent;
    current = parent, parent = parent.parent
  ) {
    if (ts.isReturnStatement(parent)) return ts.findAncestor(parent, ts.isFunctionLike) === handler;
    if (ts.isArrowFunction(parent) && parent.body === current) return parent === handler;
    if (ts.isCallExpression(parent)) {
      const argumentIndex = parent.arguments.findIndex((argument) => argument === current);
      if (argumentIndex < 0) return false;
      if (isResponseCall(parent)) return true;
      // Follow one-hop project helper calls (e.g. `res.json(formatUser(user))`) that pass the
      // argument through without stripping.
      if (depth < maxAliasDepth && helperPreservesValue(parent, argumentIndex, checker)) {
        continue;
      }
      return false;
    }
    if (ts.isVariableDeclaration(parent))
      return parent.initializer === current && aliasReachesResponse(parent.name, handler, checker, depth);
    if (ts.isPropertyAccessExpression(parent)) {
      if (parent.expression !== current || !isPassThroughChain(parent)) return false;
      parent = parent.parent;
      continue;
    }
    if (ts.isObjectLiteralExpression(parent) && overridesPassword(parent)) return false;
    if (!isTransparent(parent, current)) return false;
  }
  return false;
}

function isTransparent(parent: Node, current: Node) {
  return (
    ts.isAwaitExpression(parent) ||
    ts.isParenthesizedExpression(parent) ||
    ts.isAsExpression(parent) ||
    ts.isNonNullExpression(parent) ||
    ts.isSatisfiesExpression(parent) ||
    ts.isObjectLiteralExpression(parent) ||
    ts.isArrayLiteralExpression(parent) ||
    ts.isSpreadElement(parent) ||
    ts.isSpreadAssignment(parent) ||
    ts.isShorthandPropertyAssignment(parent) ||
    (ts.isPropertyAssignment(parent) && parent.initializer === current) ||
    (ts.isConditionalExpression(parent) && parent.condition !== current)
  );
}

function isUnselectedOrmRead(call: CallExpression, context: SecurityRuleContext) {
  const method = methodName(call);
  return (
    method !== undefined && ormReadMethods.has(method) && isOrmCall(call, context) && !selectsFields(call, context)
  );
}

// `this.users.findOne(id)` where `users` is a constructor parameter property, as Nest injects
// services.
function isInjectedMemberCall(call: CallExpression, checker: CheckerAdapter) {
  const callee = unwrap(call.expression);
  if (!ts.isPropertyAccessExpression(callee)) return false;
  const member = unwrap(callee.expression);
  if (!ts.isPropertyAccessExpression(member) || member.expression.kind !== ts.SyntaxKind.ThisKeyword) return false;
  const declaration = checker.getSymbolAtLocation(member.name)?.valueDeclaration;
  return Boolean(declaration && ts.isParameterPropertyDeclaration(declaration, declaration.parent));
}

// The ORM read the injected project method returns whole, followed one hop into the service, or
// undefined.
function serviceReturnedRead(call: CallExpression, context: SecurityRuleContext): CallExpression | undefined {
  const method = context.checker.getResolvedSignature(call)?.declaration;
  if (!method || !ts.isMethodDeclaration(method) || !method.body || method.getSourceFile().isDeclarationFile) return;
  let found: CallExpression | undefined;
  (function visit(node: Node): void {
    if (found) return;
    if (
      ts.isCallExpression(node) &&
      isUnselectedOrmRead(node, context) &&
      reachesResponse(node, method, context.checker) &&
      exposedPasswordField(node, context.checker)
    )
      found = node;
    ts.forEachChild(node, visit);
  })(method.body);
  return found;
}

function checkCall(call: CallExpression, context: SecurityRuleContext) {
  const isDirectRead = isUnselectedOrmRead(call, context);
  if (!isDirectRead && !isInjectedMemberCall(call, context.checker)) return;
  const handler = enclosingRequestHandler(call);
  if (!handler || !reachesResponse(call, handler, context.checker)) return;
  const read = isDirectRead ? call : serviceReturnedRead(call, context);
  const field = read && exposedPasswordField(read, context.checker);
  if (!field || programHidesPassword(context.program)) return;
  context.report(call, ruleId, describe(field));
}

export { checkCall };
