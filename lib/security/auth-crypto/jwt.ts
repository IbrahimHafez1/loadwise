// jsonwebtoken, @nestjs/jwt and jwt-decode misuse: unverified payloads, unpinned algorithms,
// `none`, no expiry.
import { calleeName } from '../../performance/call-syntax.js';
import { ts } from '../../performance/compiler.js';
import { importedFrom } from '../bindings.js';
import {
  fileMentions,
  libraryInfo,
  libraryFunction,
  resolveConstant,
  propertyKeyName,
  findProperty,
  hasSpread,
  enclosingFunction,
  functionName,
  isFunctionExpressionLike,
  referencesOf,
} from './shared.js';
import type {
  CallExpression,
  Expression,
  Identifier,
  Node,
  ObjectLiteralExpression,
  ParameterDeclaration,
  PropertyAccessExpression,
  PropertyAssignment,
  SignatureDeclaration,
} from 'typescript';
import type { CheckerAdapter, ProgramAdapter, SecurityRuleContext, SymbolAdapter } from '../../shared/types.js';

const nestJwt = '@nestjs/jwt';
const signLibraries = ['jsonwebtoken', nestJwt];
const jwtLibraries = [...signLibraries, 'jwt-decode'];
const signNames = new Set(['sign', 'signAsync']);
// `expiresAt` is a custom claim the project's own verification reads, as in `{ id, expiresAt:
// addHours(now, 24) }`.
const expiryClaims = ['exp', 'expiresAt'];
// Whether the module a provider belongs to registers a JwtService that signs with an expiry;
// undefined when unknown.
const moduleExpiryCache = new WeakMap<ProgramAdapter, Map<SymbolAdapter, boolean | undefined>>();
const verifyNames = new Set(['verify', 'verifyAsync', 'jwtVerify']);
const authFunctionName = /auth|guard|authenticate|authorize/i;
const authMethodNames = new Set(['canActivate', 'validate']);
const requestUserTarget = /^(?:req|request|ctx\.state|context\.state)\.user$/;
const databaseMethodNames = new Set([
  'find',
  'findOne',
  'findFirst',
  'findUnique',
  'findMany',
  'findOneBy',
  'findBy',
  'findById',
  'findByPk',
  'findOneOrFail',
  'where',
  'andWhere',
  'update',
  'updateMany',
  'delete',
  'deleteMany',
  'count',
  'exists',
]);
// Claims that are read for housekeeping, not for an access decision.
const harmlessClaims = new Set(['exp', 'iat', 'nbf', 'header']);
const noneAlgorithm = 'none';
const asymmetricKeyName = /public|pem|cert|jwk/i;
const messages = {
  decode:
    '`decode` does not check the signature, so anyone can forge this payload. Use `verify` with the expected algorithms before trusting any claim.',
  verify:
    "This `jwt.verify` call does not pin `algorithms`, so the token header chooses how it is checked. Pass the algorithms you sign with, for example `{ algorithms: ['RS256'] }`.",
  none: 'The `none` algorithm accepts unsigned tokens. Remove it and list only the algorithms you sign with.',
  expiry:
    'This token is signed without an expiry, so a leaked token works forever. Set `expiresIn` (or an `exp` claim) and rotate with refresh tokens.',
};

function isDecodeCall(call: CallExpression, context: SecurityRuleContext) {
  const info = libraryInfo(call, context);
  if (!info?.module) return false;
  if (info.module === 'jwt-decode') return !info.method;
  if (info.module !== 'jsonwebtoken' && info.module !== '@nestjs/jwt') return false;
  return (info.method ?? info.exported) === 'decode';
}

function isVerifiedInside(scope: Node, tokenText: string) {
  let verified = false;
  (function visit(node: Node): void {
    if (verified) return;
    if (
      ts.isCallExpression(node) &&
      verifyNames.has(calleeName(node) ?? '') &&
      node.arguments[0]?.getText() === tokenText
    )
      verified = true;
    ts.forEachChild(node, visit);
  })(scope);
  return verified;
}

function isExpressMiddlewareShape(fn: SignatureDeclaration) {
  const names = fn.parameters.map((parameter: ParameterDeclaration) => parameter.name.getText());
  return names.length === 3 && /^(?:req|request)$/.test(names[0]) && names[1].startsWith('res') && names[2] === 'next';
}

function isAuthFunction(fn: SignatureDeclaration) {
  const name = functionName(fn);
  if (name && (authMethodNames.has(name) || authFunctionName.test(name))) return true;
  return isExpressMiddlewareShape(fn);
}

function insideAuthFunction(node: Node) {
  for (let fn = enclosingFunction(node); fn; fn = enclosingFunction(fn)) if (isAuthFunction(fn)) return true;
  return false;
}

// Where the decoded value goes: a variable it is bound to, a property it is assigned to, or a claim
// read at once.
interface ValueSite {
  variable?: Identifier;
  assignedTo?: string;
  claim?: string;
}

function valueSite(call: CallExpression): ValueSite {
  let current: Node = call;
  while (
    current.parent &&
    (ts.isParenthesizedExpression(current.parent) ||
      ts.isAsExpression(current.parent) ||
      ts.isNonNullExpression(current.parent) ||
      ts.isAwaitExpression(current.parent))
  )
    current = current.parent;
  const parent = current.parent;
  if (parent && ts.isVariableDeclaration(parent) && parent.initializer === current)
    return ts.isIdentifier(parent.name) ? { variable: parent.name } : {};
  if (
    parent &&
    ts.isBinaryExpression(parent) &&
    parent.right === current &&
    parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
  )
    return { assignedTo: parent.left.getText().replaceAll(/\s+/g, '') };
  if (parent && ts.isPropertyAccessExpression(parent) && parent.expression === current)
    return { claim: parent.name.text };
  return {};
}

function isInsideFunctionBetween(node: Node, boundary: Node) {
  for (let current: Node | undefined = node.parent; current && current !== boundary; current = current.parent)
    if (ts.isFunctionLike(current)) return true;
  return false;
}

function isWithin(node: Node, container: Node) {
  return container.pos <= node.pos && node.end <= container.end;
}

function isDatabaseFilterUse(reference: Node) {
  const call = ts.findAncestor(
    reference,
    (node: Node): node is CallExpression =>
      ts.isCallExpression(node) && databaseMethodNames.has(calleeName(node) ?? ''),
  );
  if (!call || !call.arguments.some((argument: Expression) => isWithin(reference, argument))) return false;
  return !isInsideFunctionBetween(reference, call);
}

function isAssignedToRequestUser(reference: Node) {
  const assignment = ts.findAncestor(reference, ts.isBinaryExpression);
  return (
    assignment?.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    requestUserTarget.test(assignment.left.getText().replaceAll(/\s+/g, '')) &&
    isWithin(reference, assignment.right)
  );
}

// `if (decoded && decoded.exp)`: the value is tested, not trusted.
function isTruthinessCheck(reference: Node) {
  const parent = reference.parent;
  if (ts.isPrefixUnaryExpression(parent)) return parent.operator === ts.SyntaxKind.ExclamationToken;
  if (ts.isIfStatement(parent)) return parent.expression === reference;
  if (ts.isConditionalExpression(parent)) return parent.condition === reference;
  return (
    ts.isBinaryExpression(parent) &&
    parent.left === reference &&
    [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken].includes(parent.operatorToken.kind)
  );
}

// 'harmless' when only housekeeping claims are read, 'trusted' when the value reaches an access
// decision.
function classifyDecode(call: CallExpression, scope: Node, context: SecurityRuleContext) {
  const site = valueSite(call);
  if (site.claim) return harmlessClaims.has(site.claim) ? 'harmless' : 'other';
  if (site.assignedTo) return requestUserTarget.test(site.assignedTo) ? 'trusted' : 'other';
  if (!site.variable) return 'other';
  let wholeValueUsed = false;
  let trusted = false;
  let truthinessChecked = false;
  let claimRead = false;
  for (const reference of referencesOf(site.variable, scope, context.checker)) {
    const parent = reference.parent;
    if (
      ts.isPropertyAccessExpression(parent) &&
      parent.expression === reference &&
      harmlessClaims.has(parent.name.text)
    ) {
      claimRead = true;
      continue;
    }
    if (isTruthinessCheck(reference)) {
      truthinessChecked = true;
      continue;
    }
    wholeValueUsed = true;
    if (isAssignedToRequestUser(reference) || isDatabaseFilterUse(reference)) trusted = true;
  }
  if (trusted) return 'trusted';
  // `if (decoded)` on its own is the access decision; next to an `exp` read it is a guard around
  // that read.
  return wholeValueUsed || (truthinessChecked && !claimRead) ? 'other' : 'harmless';
}

function checkJwtDecode(call: CallExpression, context: SecurityRuleContext) {
  if (!call.arguments.length || !fileMentions(context.sourceFile, jwtLibraries)) return;
  if (/\.[jt]sx$/.test(context.sourceFile.fileName)) return;
  if (!isDecodeCall(call, context)) return;
  const scope = enclosingFunction(call) ?? context.sourceFile;
  if (isVerifiedInside(scope, call.arguments[0].getText())) return;
  if (isTokenSignedHere(call.arguments[0], context)) return;
  const usage = classifyDecode(call, scope, context);
  if (usage === 'harmless') return;
  if (usage === 'trusted' || insideAuthFunction(call))
    return context.report(call, 'jwt-decode-for-auth', messages.decode);
  context.report(
    call,
    'jwt-decode-for-auth',
    messages.decode,
    'The decoded claims are not clearly used for an access decision here.',
  );
}

// `const token = jwt.sign(...); jwt.decode(token)`: reading back a token this code just signed
// trusts nothing new.
function isTokenSignedHere(argument: Expression, context: SecurityRuleContext) {
  const token = ts.skipOuterExpressions(argument);
  if (!ts.isIdentifier(token)) return false;
  const declaration = context.checker.getSymbolAtLocation(token)?.valueDeclaration;
  if (!declaration || !ts.isVariableDeclaration(declaration) || !(declaration.parent.flags & ts.NodeFlags.Const))
    return false;
  let initializer = declaration.initializer && ts.skipOuterExpressions(declaration.initializer);
  if (initializer && ts.isAwaitExpression(initializer)) initializer = ts.skipOuterExpressions(initializer.expression);
  if (!initializer || !ts.isCallExpression(initializer)) return false;
  const info = libraryInfo(initializer, context);
  const module = info?.module;
  return (
    !!info &&
    module !== undefined &&
    signLibraries.includes(module) &&
    signNames.has(info.method ?? info.exported ?? '')
  );
}

interface OptionsArgument {
  opaque?: boolean;
  literal?: ObjectLiteralExpression;
}

function optionsArgument(call: CallExpression, optionsIndex: number, context: SecurityRuleContext): OptionsArgument {
  const argument = call.arguments[optionsIndex];
  if (!argument || isFunctionExpressionLike(argument)) return {};
  const resolved = resolveConstant(argument, context.checker);
  if (!ts.isObjectLiteralExpression(resolved) || hasSpread(resolved)) return { opaque: true };
  return { literal: resolved };
}

function keyLooksAsymmetric(keyNode: Expression, context: SecurityRuleContext) {
  const key = ts.skipOuterExpressions(keyNode);
  if (isFunctionExpressionLike(key)) return true;
  if (ts.isCallExpression(key)) return key.expression.getText().endsWith('readFileSync');
  if (ts.isIdentifier(key)) {
    const declaration = context.checker.getSymbolAtLocation(key)?.valueDeclaration;
    if (declaration && ts.isFunctionDeclaration(declaration)) return true;
    if (declaration && ts.isParameter(declaration) && declaration.type && ts.isFunctionTypeNode(declaration.type))
      return true;
    if (
      declaration &&
      ts.isVariableDeclaration(declaration) &&
      declaration.initializer &&
      isFunctionExpressionLike(declaration.initializer)
    )
      return true;
  }
  return asymmetricKeyName.test(key.getText());
}

function checkJwtVerify(call: CallExpression, context: SecurityRuleContext) {
  if (call.arguments.length < 2 || !fileMentions(context.sourceFile, ['jsonwebtoken'])) return;
  if (libraryFunction(call, context, ['jsonwebtoken']) !== 'verify') return;
  const options = optionsArgument(call, 2, context);
  if (options.opaque || (options.literal && findProperty(options.literal, 'algorithms'))) return;
  if (keyLooksAsymmetric(call.arguments[1], context))
    return context.report(call, 'jwt-verify-without-algorithms', messages.verify);
  context.report(
    call,
    'jwt-verify-without-algorithms',
    messages.verify,
    'The key is a shared secret, so an unpinned algorithm is less exploitable here.',
  );
}

function isNoneLiteral(node: Node) {
  return ts.isStringLiteralLike(node) && node.text.toLowerCase() === noneAlgorithm;
}

function checkJwtNone(property: PropertyAssignment, context: SecurityRuleContext) {
  const name = propertyKeyName(property.name);
  const value = ts.skipOuterExpressions(property.initializer);
  if (name === 'algorithms' && ts.isArrayLiteralExpression(value)) {
    const none = value.elements.find(isNoneLiteral);
    if (none) context.report(none, 'jwt-none-algorithm', messages.none);
    return;
  }
  // `algorithm: 'none'` is only a signing option when the object is handed to a sign call.
  if (name !== 'algorithm' || !isNoneLiteral(value)) return;
  const call = ts.findAncestor(property, ts.isCallExpression);
  if (call && /^sign(?:Async|Sync)?$/.test(calleeName(call) ?? '') && call.arguments.includes(property.parent))
    context.report(value, 'jwt-none-algorithm', messages.none);
}

function propertyValue(object: ObjectLiteralExpression, name: string, checker: CheckerAdapter): Expression | undefined {
  const property = findProperty(object, name);
  if (!property) return;
  if (ts.isPropertyAssignment(property)) return property.initializer;
  const declaration = checker.getShorthandAssignmentValueSymbol(property)?.valueDeclaration;
  if (declaration && ts.isVariableDeclaration(declaration) && declaration.parent.flags & ts.NodeFlags.Const)
    return declaration.initializer;
  return property.name;
}

function moduleArray(metadata: ObjectLiteralExpression, key: string, checker: CheckerAdapter): readonly Expression[] {
  const value = propertyValue(metadata, key, checker);
  const array = value && resolveConstant(value, checker);
  return array && ts.isArrayLiteralExpression(array) ? array.elements : [];
}

type JwtModuleRegistration = CallExpression & { expression: PropertyAccessExpression };

function isJwtModuleRegistration(expression: Expression, checker: CheckerAdapter): expression is JwtModuleRegistration {
  if (!ts.isCallExpression(expression) || !ts.isPropertyAccessExpression(expression.expression)) return false;
  const { expression: receiver, name } = expression.expression;
  if (name.text !== 'register' && name.text !== 'registerAsync') return false;
  const namespace = ts.isPropertyAccessExpression(receiver) && receiver.name.text === 'JwtModule';
  const binding = importedFrom(namespace ? receiver.expression : receiver, checker);
  return binding?.module === nestJwt && binding.exported === (namespace ? '*' : 'JwtModule');
}

// A direct synchronous registration can prove whether the injected service inherits an expiry.
function registrationExpiry(
  metadata: ObjectLiteralExpression,
  providers: readonly Expression[],
  context: SecurityRuleContext,
): boolean | undefined {
  const imports = moduleArray(metadata, 'imports', context.checker);
  if (imports.some(ts.isSpreadElement) || providers.some(ts.isSpreadElement)) return;
  for (const provider of providers) {
    const token = ts.isObjectLiteralExpression(provider)
      ? propertyValue(provider, 'provide', context.checker)
      : provider;
    const binding = importedFrom(token, context.checker);
    if (binding?.module === nestJwt && binding.exported === 'JwtService') return;
  }
  const registrations = imports.filter((expression): expression is JwtModuleRegistration =>
    isJwtModuleRegistration(expression, context.checker),
  );
  const [registration] = registrations;
  if (registrations.length !== 1 || registration.expression.name.text !== 'register') return;
  const { literal: options } = optionsArgument(registration, 0, context);
  if (!options) return;
  const signOptions = propertyValue(options, 'signOptions', context.checker);
  if (!signOptions) return false;
  const literal = resolveConstant(signOptions, context.checker);
  if (!ts.isObjectLiteralExpression(literal) || hasSpread(literal)) return;
  const expiry = propertyValue(literal, 'expiresIn', context.checker);
  if (!expiry) return false;
  const value = resolveConstant(expiry, context.checker);
  if (ts.isStringLiteralLike(value) || ts.isNumericLiteral(value)) return true;
}

function recordModuleExpiry(
  expression: Expression,
  context: SecurityRuleContext,
  result: Map<SymbolAdapter, boolean | undefined>,
) {
  if (!ts.isCallExpression(expression) || libraryFunction(expression, context, ['@nestjs/common']) !== 'Module') return;
  const { literal: metadata } = optionsArgument(expression, 0, context);
  if (!metadata) return;
  const providers = moduleArray(metadata, 'providers', context.checker);
  const controllers = moduleArray(metadata, 'controllers', context.checker);
  const expiry = registrationExpiry(metadata, providers, context);
  for (const provider of [...providers, ...controllers].filter(ts.isIdentifier)) {
    const symbol = context.checker.getSymbolAtLocation(provider);
    if (!symbol) continue;
    const original = symbol.flags & ts.SymbolFlags.Alias ? context.checker.getAliasedSymbol(symbol) : symbol;
    const conflicting = result.has(original) && result.get(original) !== expiry;
    result.set(original, conflicting ? undefined : expiry);
  }
}

function moduleExpiryByProvider(context: SecurityRuleContext): Map<SymbolAdapter, boolean | undefined> {
  const cached = moduleExpiryCache.get(context.program);
  if (cached) return cached;
  const result = new Map<SymbolAdapter, boolean | undefined>();
  for (const sourceFile of context.program.getSourceFiles?.() ?? context.program.getToolingSourceFiles?.() ?? []) {
    if (sourceFile.isDeclarationFile || !fileMentions(sourceFile, ['@nestjs/common'])) continue;
    for (const statement of sourceFile.statements.filter(ts.isClassDeclaration)) {
      for (const { expression } of ts.getDecorators(statement) ?? []) {
        recordModuleExpiry(expression, context, result);
      }
    }
  }
  moduleExpiryCache.set(context.program, result);
  return result;
}

function injectedModuleExpiry(call: CallExpression, context: SecurityRuleContext): boolean | undefined {
  const callee = ts.skipOuterExpressions(call.expression);
  if (!context.program || !ts.isPropertyAccessExpression(callee)) return;
  const receiver = ts.skipOuterExpressions(callee.expression);
  if (!ts.isPropertyAccessExpression(receiver) || receiver.expression.kind !== ts.SyntaxKind.ThisKeyword) return;
  const declaration = context.checker.getSymbolAtLocation(receiver.name)?.valueDeclaration;
  if (!declaration || !ts.isParameter(declaration) || !ts.isConstructorDeclaration(declaration.parent)) return;
  if ((ts.getDecorators(declaration) ?? []).length) return;
  const owner = declaration.parent.parent;
  const enclosingClass = ts.findAncestor(call, (node: Node) => ts.isClassLike(node));
  if (!owner.name || owner !== enclosingClass) return;
  const ownerSymbol = context.checker.getSymbolAtLocation(owner.name);
  return ownerSymbol ? moduleExpiryByProvider(context).get(ownerSymbol) : undefined;
}

// The literal sets an expiry claim after its last spread, to a value that cannot be `undefined`.
function setsExpiryClaim(payload: ObjectLiteralExpression, checker: CheckerAdapter) {
  const lastSpread = payload.properties.findLastIndex((property) => ts.isSpreadAssignment(property));
  return payload.properties.slice(lastSpread + 1).some((property) => {
    if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) return false;
    if (!expiryClaims.includes(propertyKeyName(property.name) ?? '')) return false;
    const value = ts.isPropertyAssignment(property) ? property.initializer : property.name;
    const branches = ts.isConditionalExpression(value) ? [value.whenTrue, value.whenFalse] : [value];
    if (branches.some((branch) => ts.skipOuterExpressions(branch).getText() === 'undefined')) return false;
    const type = checker.getTypeAtLocation(value);
    const members = type.isUnion() && type.types ? type.types : [type];
    return !members.some((member) => member.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void));
  });
}

// `payload.exp = ...` set on the payload identifier earlier in the same function before signing.
function assignsExpiryBeforeCall(call: CallExpression, payloadArgument: Expression, checker: CheckerAdapter): boolean {
  const target = ts.skipOuterExpressions(payloadArgument);
  if (!ts.isIdentifier(target)) return false;
  const scope = enclosingFunction(call) ?? call.getSourceFile();
  const callStart = call.getStart();
  return referencesOf(target, scope, checker).some((reference) => {
    if (reference.getStart() >= callStart) return false;
    const access = reference.parent;
    if (!ts.isPropertyAccessExpression(access) || access.expression !== reference) return false;
    if (!expiryClaims.includes(access.name.text)) return false;
    const assignment = access.parent;
    if (
      !ts.isBinaryExpression(assignment) ||
      assignment.left !== access ||
      assignment.operatorToken.kind !== ts.SyntaxKind.EqualsToken
    ) {
      return false;
    }
    const assigned = ts.skipOuterExpressions(assignment.right);
    return !(ts.isIdentifier(assigned) && assigned.text === 'undefined');
  });
}

function checkJwtSign(call: CallExpression, context: SecurityRuleContext) {
  if (!call.arguments.length || !fileMentions(context.sourceFile, signLibraries)) return;
  const info = libraryInfo(call, context);
  const name = info?.method ?? info?.exported;
  const nestService =
    info?.module === nestJwt && info.exported === 'JwtService' && name !== undefined && signNames.has(name);
  if (!nestService && !(info?.module === 'jsonwebtoken' && name === 'sign' && call.arguments.length >= 2)) return;
  const options = optionsArgument(call, nestService ? 1 : 2, context);
  if (options.opaque || (options.literal && findProperty(options.literal, 'expiresIn'))) return;
  const moduleExpiry = nestService ? injectedModuleExpiry(call, context) : false;
  if (moduleExpiry === true) return;
  if (assignsExpiryBeforeCall(call, call.arguments[0], context.checker)) return;
  const payload = resolveConstant(call.arguments[0], context.checker);
  if (ts.isStringLiteralLike(payload) || ts.isTemplateExpression(payload)) return;
  if (ts.isObjectLiteralExpression(payload) && setsExpiryClaim(payload, context.checker)) return;
  if (!ts.isObjectLiteralExpression(payload) || hasSpread(payload))
    return context.report(
      call,
      'jwt-sign-without-expiry',
      messages.expiry,
      'The token payload is not an object literal, so an `exp` claim may be set elsewhere.',
    );
  if (!findProperty(payload, 'exp')) {
    const hasCustomTimestamp = Boolean(findProperty(payload, 'createdAt'));
    const reason = hasCustomTimestamp
      ? 'The payload carries an application-level timestamp (`expiresAt` or `createdAt`); confirm the verifier enforces expiry.'
      : moduleExpiry === undefined
        ? 'The injected JwtService might inherit an expiry from its module.'
        : undefined;
    context.report(call, 'jwt-sign-without-expiry', messages.expiry, reason);
  }
}

export { checkJwtDecode, checkJwtVerify, checkJwtNone, checkJwtSign };
