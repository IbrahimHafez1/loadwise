'use strict';

// password-hash-in-response: a request handler sends a record read from the ORM without a field selection, and the
// record's type still holds a password or hash field.
const { syntax: ts } = require('../../performance/compiler.cjs');
const { enclosingRequestHandler } = require('../../performance/request-handlers.cjs');
const { unwrap, objectLiteralOf, findProperty, methodName, nameText } = require('./literals.cjs');

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
// Prisma clients are usually local instances (`prisma.user`, `this.prisma.user`), so their shape names them.
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
// A schema option, default scope or serializer transform anywhere in the project hides the field from every read.
const projectHidesPassword = [
  /\b(?:password|passwordHash|hashedPassword|password_hash|hash)\s*:\s*\{[^{}]*\bselect\s*:\s*false/i,
  /defaultScope[\s\S]{0,400}?\bexclude\b/,
  /set\(\s*['"]toJSON['"]|toJSON\s*:\s*\{\s*transform/,
];
const hiddenFieldDecorators = new Set(['Exclude']);
const projectCache = new WeakMap();

function describe(field) {
  return `A user record read without a field selection is sent in the response with its \`${field}\` field, so the password hash reaches the client. Return only safe fields: select the fields you need or omit the password hash.`;
}

function fileHidesPassword(file) {
  if (file.isDeclarationFile || file.fileName.includes('node_modules')) return false;
  return projectHidesPassword.some((pattern) => pattern.test(file.text));
}

function programHidesPassword(program) {
  if (!projectCache.has(program)) projectCache.set(program, program.getSourceFiles().some(fileHidesPassword));
  return projectCache.get(program);
}

function isOrmCall(call, context) {
  const receiver = unwrap(unwrap(call.expression).expression);
  if (prismaReceiver.test(receiver.getText())) return true;
  return ormModules.has(context.libraryCall(call)?.module);
}

function selectsFields(call, context) {
  if (projectionMethods.has(methodName(call)) && call.arguments.length > 1) return true;
  const options = objectLiteralOf(call.arguments[0], context.checker);
  return Boolean(options && selectionOptions.some((name) => findProperty(options, name)));
}

function decoratorName(decorator) {
  const callee = ts.isCallExpression(decorator.expression) ? decorator.expression.expression : decorator.expression;
  return ts.isIdentifier(callee) ? callee.text : undefined;
}

// `@Column({ select: false })`, `@Prop({ select: false })` or class-transformer `@Exclude()` on the field.
function isHiddenByDecorator(decorator) {
  if (hiddenFieldDecorators.has(decoratorName(decorator))) return true;
  const options = ts.isCallExpression(decorator.expression) ? unwrap(decorator.expression.arguments[0]) : undefined;
  if (!options || !ts.isObjectLiteralExpression(options)) return false;
  return findProperty(options, 'select')?.value.kind === ts.SyntaxKind.FalseKeyword;
}

function isHiddenField(symbol) {
  return (symbol.declarations ?? []).some((declaration) =>
    (ts.canHaveDecorators(declaration) ? (ts.getDecorators(declaration) ?? []) : []).some(isHiddenByDecorator),
  );
}

// A `toJSON` written in the project decides what the record serializes to.
function hasOwnToJson(type) {
  return (type.getProperty('toJSON')?.declarations ?? []).some((declaration) => {
    const file = declaration.getSourceFile();
    return !file.isDeclarationFile && !file.fileName.includes('node_modules');
  });
}

function recordTypes(type, checker) {
  const awaited = checker.getNonNullableType(checker.getAwaitedType(type) ?? type);
  const element = checker.isArrayType(awaited) ? checker.getTypeArguments(awaited)[0] : awaited;
  return element.isUnion() ? element.types : [element];
}

// The password-like field the read result exposes, or undefined.
function exposedPasswordField(call, checker) {
  for (const record of recordTypes(checker.getTypeAtLocation(call), checker)) {
    if (record.flags & ts.TypeFlags.Any || hasOwnToJson(record)) continue;
    const field = record.getProperties().find((property) => passwordField.test(property.name));
    if (field && !isHiddenField(field)) return field.name;
  }
}

function isResponseCall(call) {
  const callee = unwrap(call.expression);
  if (!ts.isPropertyAccessExpression(callee) || !responseMethods.has(callee.name.text)) return false;
  let receiver = unwrap(callee.expression);
  while (ts.isCallExpression(receiver) && ts.isPropertyAccessExpression(unwrap(receiver.expression)))
    receiver = unwrap(unwrap(receiver.expression).expression);
  return ts.isIdentifier(receiver) && responseReceiver.test(receiver.text);
}

// `{ ...user, password: undefined }` overrides the field it spreads in.
function overridesPassword(literal) {
  return literal.properties.some((property) => property.name && passwordField.test(nameText(property.name) ?? ''));
}

function isPassThroughChain(access) {
  const call = access.parent;
  return ts.isCallExpression(call) && call.expression === access && passThroughChainMethods.has(access.name.text);
}

// `delete user.password`, `user.password = undefined` or `user = sanitize(user)` before the response.
function isStrippingUse(use) {
  const outer = outermostWrapper(use);
  const parent = outer.parent;
  if (ts.isBinaryExpression(parent) && parent.left === outer) return true;
  if (!ts.isPropertyAccessExpression(parent) || parent.expression !== outer || !passwordField.test(parent.name.text))
    return false;
  const holder = parent.parent;
  return ts.isDeleteExpression(holder) || (ts.isBinaryExpression(holder) && holder.left === parent);
}

// `(user as any)` or `user!` around a use.
function outermostWrapper(node) {
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
function referencedSymbol(identifier, checker) {
  return ts.isShorthandPropertyAssignment(identifier.parent)
    ? checker.getShorthandAssignmentValueSymbol(identifier.parent)
    : checker.getSymbolAtLocation(identifier);
}

function usesOf(name, handler, checker) {
  const symbol = checker.getSymbolAtLocation(name);
  const found = [];
  (function visit(node) {
    if (ts.isIdentifier(node) && node !== name && referencedSymbol(node, checker) === symbol) found.push(node);
    ts.forEachChild(node, visit);
  })(handler.body);
  return found;
}

function aliasReachesResponse(name, handler, checker, depth) {
  if (!ts.isIdentifier(name) || depth >= maxAliasDepth) return false;
  const uses = usesOf(name, handler, checker);
  if (uses.some(isStrippingUse)) return false;
  return uses.some((use) => reachesResponse(use, handler, checker, depth + 1));
}

// True when `value` is sent whole: returned from the handler or passed to `res.json`, possibly wrapped in an object
// or array or stored in a local first. Field reads, method calls and other calls (mappers, DTOs) stop the walk.
function reachesResponse(value, handler, checker, depth = 0) {
  for (let current = value, parent = value.parent; parent; current = parent, parent = parent.parent) {
    if (ts.isReturnStatement(parent)) return ts.findAncestor(parent, ts.isFunctionLike) === handler;
    if (ts.isArrowFunction(parent) && parent.body === current) return parent === handler;
    if (ts.isCallExpression(parent)) return parent.arguments.includes(current) && isResponseCall(parent);
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

function isTransparent(parent, current) {
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

function checkCall(call, context) {
  if (!ormReadMethods.has(methodName(call)) || !isOrmCall(call, context) || selectsFields(call, context)) return;
  const handler = enclosingRequestHandler(call);
  if (!handler || !reachesResponse(call, handler, context.checker)) return;
  const field = exposedPasswordField(call, context.checker);
  if (!field || programHidesPassword(context.program)) return;
  context.report(call, ruleId, describe(field));
}

module.exports = { checkCall };
