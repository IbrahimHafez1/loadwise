// error-stack-in-response: the stack of an error, or a whole error object, goes back to the client.
import { ts } from '../../performance/compiler.js';
import { importedFrom } from '../bindings.js';
import { typeAnnotationOf } from '../declarations.js';
import { unwrap, chainRootName, underNonProductionGuard } from './literals.js';
import type {
  BinaryExpression,
  CallExpression,
  CatchClause,
  Expression,
  Identifier,
  NewExpression,
  Node,
  ParameterDeclaration,
  PropertyAccessExpression,
  ShorthandPropertyAssignment,
  TypeNode,
  VariableDeclaration,
} from 'typescript';
import type { CheckerAdapter, SecurityRuleContext, TypeAdapter } from '../../shared/types.js';
import type { InspectableType } from '../types/inspectable-type.js';

const ruleId = 'error-stack-in-response';
const stackMessage =
  'This response includes the error stack, which reveals file paths, dependencies and code structure. Log the error server-side and return a generic message.';
const wholeErrorReason = 'A whole error object is returned; confirm it exposes no stack or internal details.';
const responseNames = new Set(['res', 'response', 'reply']);
const bodyWriters = new Set(['send', 'json', 'end']);
const webResponseNames = new Set(['Response', 'NextResponse']);
const expressErrorHandlerParameterCount = 4;
// `(err, req, res, next)`: one of the other parameters carries an Express name, unused ones often
// with a `_`.
const expressHandlerParameterName = /^_*(?:req|request|res|response|next)$/;

function isNestException(expression: Expression, context: SecurityRuleContext) {
  const callee = unwrap(expression);
  return (
    ts.isIdentifier(callee) &&
    callee.text.endsWith('Exception') &&
    importedFrom(callee, context.checker)?.module === '@nestjs/common'
  );
}

type CatchVariable = VariableDeclaration & { parent: CatchClause };

function isCatchVariable(declaration: Node): declaration is CatchVariable {
  return ts.isVariableDeclaration(declaration) && ts.isCatchClause(declaration.parent);
}

function isPrimitiveTypeNode(typeNode: TypeNode | undefined): boolean {
  if (!typeNode) return false;
  return (
    typeNode.kind === ts.SyntaxKind.StringKeyword ||
    typeNode.kind === ts.SyntaxKind.NumberKeyword ||
    typeNode.kind === ts.SyntaxKind.BooleanKeyword
  );
}

// `(err, req, res, next)`: the Express error-handler shape. Any four-parameter function is not one.
function isErrorHandlerParameter(declaration: Node) {
  if (!ts.isParameter(declaration) || !ts.isIdentifier(declaration.name)) return false;
  if (isPrimitiveTypeNode(declaration.type)) return false;
  const { parameters } = declaration.parent;
  if (parameters.length !== expressErrorHandlerParameterCount || parameters[0] !== declaration) return false;
  const matchedExpressNames = parameters
    .slice(1)
    .filter(
      (parameter: ParameterDeclaration) =>
        ts.isIdentifier(parameter.name) && expressHandlerParameterName.test(parameter.name.text),
    ).length;
  return matchedExpressNames >= 2;
}

// The type is `Error` or extends it; a plain object with `message` and `stack` fields is not an
// error.
function isErrorDerived(type: InspectableType, checker: CheckerAdapter, seen = new Set<TypeAdapter>()): boolean {
  if (seen.has(type)) return false;
  seen.add(type);
  if (type.isUnionOrIntersection?.()) return (type.types ?? []).some((member) => isErrorDerived(member, checker, seen));
  if (type.getSymbol()?.name === 'Error') return true;
  const isReference = type.flags & ts.TypeFlags.Object && (type.objectFlags ?? 0) & ts.ObjectFlags.Reference;
  const target = isReference ? (type.target ?? type) : type;
  if (!target.isClassOrInterface?.()) return false;
  return checker.getBaseTypes(target).some((base) => isErrorDerived(base, checker, seen));
}

function isErrorTyped(identifier: Identifier, checker: CheckerAdapter) {
  return isErrorDerived(checker.getTypeAtLocation(identifier), checker);
}

function isWholeError(identifier: Identifier, checker: CheckerAdapter) {
  const symbol = ts.isShorthandPropertyAssignment(identifier.parent)
    ? checker.getShorthandAssignmentValueSymbol(identifier.parent)
    : checker.getSymbolAtLocation(identifier);
  const declaration = symbol?.valueDeclaration;
  if (!declaration) return false;
  return isCatchVariable(declaration) || isErrorHandlerParameter(declaration) || isErrorTyped(identifier, checker);
}

// The `.stack` reads anywhere inside the expression.
function findStackReads(expression: Node, found: PropertyAccessExpression[] = []): PropertyAccessExpression[] {
  const node = ts.skipOuterExpressions(expression);
  if (!node) return found;
  if (ts.isPropertyAccessExpression(node) && node.name.text === 'stack') {
    found.push(node);
    return found;
  }
  if (ts.isFunctionLike(node)) return found;
  ts.forEachChild(node, (child) => {
    findStackReads(child, found);
  });
  return found;
}

// Error objects placed in the body as a whole: the value itself, an object property, a spread or an
// array item.
type WholeError = Identifier | ShorthandPropertyAssignment;

function findWholeErrors(expression: Expression, checker: CheckerAdapter, found: WholeError[] = []): WholeError[] {
  const node = unwrap(expression);
  if (!node) return found;
  if (ts.isIdentifier(node)) {
    if (isWholeError(node, checker)) found.push(node);
  } else if (ts.isObjectLiteralExpression(node)) {
    for (const property of node.properties) {
      if (ts.isShorthandPropertyAssignment(property) && isWholeError(property.name, checker)) found.push(property);
      else if (ts.isPropertyAssignment(property)) findWholeErrors(property.initializer, checker, found);
      else if (ts.isSpreadAssignment(property)) findWholeErrors(property.expression, checker, found);
    }
  } else if (ts.isArrayLiteralExpression(node)) {
    for (const element of node.elements) findWholeErrors(element, checker, found);
  } else if (ts.isConditionalExpression(node)) {
    const narrowed = instanceofErrorTest(node.condition);
    // `err instanceof Error ? err.message : err`: the branch where `err` is known not to be an
    // Error is not one.
    const branches: [Expression, boolean | undefined][] = [
      [node.whenTrue, narrowed?.negated],
      [node.whenFalse, narrowed && !narrowed.negated],
    ];
    for (const [branch, notError] of branches) {
      const value = unwrap(branch);
      if (notError && narrowed && ts.isIdentifier(value) && value.text === narrowed.name) continue;
      findWholeErrors(branch, checker, found);
    }
  }
  return found;
}

// `x instanceof Error` or `!(x instanceof Error)`: the tested name, and whether the test is
// negated.
function instanceofErrorTest(condition: Expression) {
  let node = unwrap(condition);
  let negated = false;
  while (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken) {
    negated = !negated;
    node = unwrap(node.operand);
  }
  if (!ts.isBinaryExpression(node) || node.operatorToken.kind !== ts.SyntaxKind.InstanceOfKeyword) return;
  const value = unwrap(node.left);
  if (!ts.isIdentifier(value) || unwrap(node.right).getText() !== 'Error') return;
  return { name: value.text, negated };
}

function checkBody(body: Expression, context: SecurityRuleContext) {
  if (underNonProductionGuard(body)) return;
  for (const read of findStackReads(body))
    if (!underNonProductionGuard(read)) context.report(read, ruleId, stackMessage);
  for (const error of findWholeErrors(body, context.checker))
    if (!underNonProductionGuard(error)) context.report(error, ruleId, stackMessage, wholeErrorReason);
}

const errorhandlerMiddlewareMessage =
  "The `errorhandler` middleware sends full error stack traces to clients and is registered outside a development-only guard. Wrap it in a `NODE_ENV === 'development'` check or remove it in production.";

function checkCall(call: CallExpression, context: SecurityRuleContext) {
  const callee = unwrap(call.expression);
  if (ts.isIdentifier(callee) && importedFrom(callee, context.checker)?.module === 'errorhandler') {
    if (!underNonProductionGuard(call)) context.report(call, ruleId, errorhandlerMiddlewareMessage);
    return;
  }
  if (!ts.isPropertyAccessExpression(callee)) return;
  const name = callee.name.text;
  const receiver = unwrap(callee.expression);
  const rootName = chainRootName(receiver);
  const writesBody =
    (bodyWriters.has(name) && rootName !== undefined && responseNames.has(rootName)) ||
    (name === 'json' && ts.isIdentifier(receiver) && webResponseNames.has(receiver.text));
  if (!writesBody) return;
  for (const argument of call.arguments) checkBody(argument, context);
  if (isServerErrorOrUnset(receiver)) for (const argument of call.arguments) checkDatabaseBody(argument, context);
}

// database-error-in-response: `err.message` or a whole `err` from a database failure goes back to
// the client.
const databaseRuleId = 'database-error-in-response';
const databaseMessage =
  'This response sends a database error to the client. Driver errors reveal table, column and constraint names. Log the error server-side and return a generic message.';
const middlewareReason =
  'This error handler may receive errors that did not come from the database; confirm it does not forward driver messages.';
const driverErrorNames = new Set([
  'PrismaClientKnownRequestError',
  'PrismaClientUnknownRequestError',
  'PrismaClientValidationError',
  'QueryFailedError',
  'MongoServerError',
  'DatabaseError',
]);
const databaseModulePattern =
  /^(?:@prisma\/client|typeorm|sequelize|sequelize-typescript|mongoose|mongodb|pg|mysql2?|mysql2\/promise|knex|drizzle-orm(?:\/.*)?|@mikro-orm\/.*)$/;
const databaseNamePattern =
  /^(?:db|database|knex|pool|pg|mysql|mysql2|dataSource|entityManager|em|manager|connection|conn)$|prisma|typeorm|sequelize|knex|mongoose|drizzle|(?:Repository|Repo|Model|Db|Pool)$/i;
const ormMethods = new Set([
  'findOne',
  'findAll',
  'findByPk',
  'findMany',
  'findUnique',
  'findFirst',
  'findOneBy',
  'findBy',
  'findById',
  'findOneAndUpdate',
  'findByIdAndUpdate',
  'create',
  'save',
  'destroy',
  'bulkCreate',
  'insertMany',
  'updateOne',
  'deleteOne',
]);
const serverErrorStatusName = /INTERNAL_SERVER_ERROR|SERVICE_UNAVAILABLE|BAD_GATEWAY/;
const serverErrorStatusMinimum = 500;
const statusMethods = new Set(['status', 'code']);
const stringifiers = new Set(['String', 'JSON.stringify']);

// Names along a call chain: `this.prisma.user.create(...)` -> prisma, user, create (and the root
// `this`).
function chainNames(expression: Expression) {
  const names: string[] = [];
  let node = unwrap(expression);
  while (node) {
    if (ts.isCallExpression(node)) node = unwrap(node.expression);
    else if (ts.isPropertyAccessExpression(node)) {
      names.push(node.name.text);
      node = unwrap(node.expression);
    } else {
      if (ts.isIdentifier(node)) names.push(node.text);
      break;
    }
  }
  return names.reverse();
}

function isDatabaseCall(call: CallExpression, context: SecurityRuleContext) {
  const names = chainNames(call.expression);
  const root = unwrap(call.expression);
  const rootIdentifier = chainRootIdentifier(root);
  if (rootIdentifier && databaseModulePattern.test(importedFrom(rootIdentifier, context.checker)?.module ?? ''))
    return true;
  if (names.slice(0, -1).some((name) => databaseNamePattern.test(name))) return true;
  return /^[A-Z]/.test(names[0] ?? '') && ormMethods.has(names.at(-1) ?? '');
}

function chainRootIdentifier(expression: Expression): Identifier | undefined {
  let node = unwrap(expression);
  while (node && (ts.isPropertyAccessExpression(node) || ts.isCallExpression(node))) node = unwrap(node.expression);
  return node && ts.isIdentifier(node) ? node : undefined;
}

function awaitsDatabaseCall(node: Node, context: SecurityRuleContext): boolean {
  if (ts.isFunctionLike(node)) return false;
  if (ts.isAwaitExpression(node) && containsDatabaseCall(node.expression, context)) return true;
  return Boolean(ts.forEachChild(node, (child) => awaitsDatabaseCall(child, context) || undefined));
}

function containsDatabaseCall(node: Node, context: SecurityRuleContext): boolean {
  if (ts.isCallExpression(node) && isDatabaseCall(node, context)) return true;
  return Boolean(ts.forEachChild(node, (child) => containsDatabaseCall(child, context) || undefined));
}

function typeLastName(typeNode: TypeNode | undefined) {
  if (!typeNode || !ts.isTypeReferenceNode(typeNode)) return;
  const name = typeNode.typeName;
  return ts.isIdentifier(name) ? name.text : name.right.text;
}

function isDriverErrorClass(expression: Expression) {
  const node = unwrap(expression);
  const name = ts.isPropertyAccessExpression(node) ? node.name.text : ts.isIdentifier(node) ? node.text : undefined;
  return name !== undefined && driverErrorNames.has(name);
}

// `err instanceof X` tests that mention `name`: the class tested.
function instanceofClasses(condition: Expression, name: string) {
  const classes: Expression[] = [];
  const visit = (node: Node) => {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword &&
      unwrap(node.left).getText() === name
    )
      classes.push(node.right);
    ts.forEachChild(node, visit);
  };
  visit(condition);
  return classes;
}

function enclosingConditions(node: Node, name: string) {
  const conditions: Expression[] = [];
  for (
    let child: Node = node, parent: Node | undefined = node.parent;
    parent && !ts.isFunctionLike(parent);
    child = parent, parent = parent.parent
  ) {
    if (ts.isIfStatement(parent) && child !== parent.expression) conditions.push(parent.expression);
    else if (ts.isConditionalExpression(parent) && child !== parent.condition) conditions.push(parent.condition);
    else if (
      ts.isBinaryExpression(parent) &&
      parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken &&
      child === parent.right
    )
      conditions.push(parent.left);
  }
  return conditions.filter((condition) => condition.getText().includes(name));
}

// The error is mapped: a branch for a non-driver class (`err instanceof ValidationError`) or a
// known code.
function isHandledBranch(use: Node, name: string) {
  return enclosingConditions(use, name).some((condition) => {
    const classes = instanceofClasses(condition, name);
    if (classes.some(isDriverErrorClass)) return false;
    if (classes.some((errorClass) => unwrap(errorClass).getText() !== 'Error')) return true;
    const escaped = name.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?<![\\w$])${escaped}\\.(?:code|name)\\b`).test(condition.getText());
  });
}

function isNarrowedToDriverError(use: Node, name: string) {
  return enclosingConditions(use, name).some((condition) =>
    instanceofClasses(condition, name).some(isDriverErrorClass),
  );
}

// 'default', 'contextual' or undefined for how likely `use` (an identifier) holds a database error.
function databaseErrorConfidence(use: Identifier, context: SecurityRuleContext) {
  const symbol = ts.isShorthandPropertyAssignment(use.parent)
    ? context.checker.getShorthandAssignmentValueSymbol(use.parent)
    : context.checker.getSymbolAtLocation(use);
  const declaration = symbol?.valueDeclaration;
  if (!declaration) return;
  const annotatedName = typeLastName(typeAnnotationOf(declaration));
  if (isNarrowedToDriverError(use, use.text) || (annotatedName !== undefined && driverErrorNames.has(annotatedName)))
    return 'default';
  if (isCatchVariable(declaration)) {
    return awaitsDatabaseCall(declaration.parent.parent.tryBlock, context) ? 'default' : undefined;
  }
  return isErrorHandlerParameter(declaration) ? 'contextual' : undefined;
}

// The identifier whose `.message` a node reads, if it reads one.
function messageReadOwner(node: Node): Identifier | undefined {
  if (!ts.isPropertyAccessExpression(node) || node.name.text !== 'message') return;
  const owner = unwrap(node.expression);
  return ts.isIdentifier(owner) ? owner : undefined;
}

const wholeValueParents = [ts.isSpreadAssignment, ts.isArrayLiteralExpression, ts.isTemplateSpan];

// Identifiers that stand for the whole error value: the argument itself, a property, a spread, an
// item or `${err}`.
function isWholeValue(identifier: Identifier) {
  const parent = identifier.parent;
  if (ts.isCallExpression(parent)) return parent.arguments.includes(identifier) && isResponseWriterCall(parent);
  if (ts.isPropertyAssignment(parent)) return parent.initializer === identifier;
  return wholeValueParents.some((test) => test(parent));
}

function isResponseWriterCall(call: CallExpression) {
  const callee = unwrap(call.expression);
  return ts.isPropertyAccessExpression(callee) && bodyWriters.has(callee.name.text);
}

// `err.message` reads and whole `err` values in a response body; calls other than stringifiers hide
// their arguments.
interface DatabaseErrorUse {
  report: Node;
  identifier: Identifier;
}

function findDatabaseErrorUses(expression: Node, found: DatabaseErrorUse[] = []): DatabaseErrorUse[] {
  const node = ts.skipOuterExpressions(expression);
  if (!node || ts.isFunctionLike(node)) return found;
  const messageOwner = messageReadOwner(node);
  if (messageOwner) found.push({ report: node, identifier: messageOwner });
  else if (ts.isIdentifier(node)) {
    if (isWholeValue(node)) found.push({ report: node, identifier: node });
  } else if (ts.isCallExpression(node)) {
    findDatabaseErrorUses(node.expression, found);
    if (stringifiers.has(unwrap(node.expression).getText()))
      for (const argument of node.arguments) findDatabaseErrorUses(argument, found);
  } else if (ts.isConditionalExpression(node)) {
    findDatabaseErrorUses(node.whenTrue, found);
    findDatabaseErrorUses(node.whenFalse, found);
  } else if (ts.isShorthandPropertyAssignment(node)) found.push({ report: node, identifier: node.name });
  else
    ts.forEachChild(node, (child) => {
      findDatabaseErrorUses(child, found);
    });
  return found;
}

function checkDatabaseBody(body: Expression, context: SecurityRuleContext) {
  if (underNonProductionGuard(body)) return;
  for (const { report, identifier } of findDatabaseErrorUses(body)) {
    const confidence = databaseErrorConfidence(identifier, context);
    if (!confidence || isHandledBranch(report, identifier.text) || underNonProductionGuard(report)) continue;
    context.report(report, databaseRuleId, databaseMessage, confidence === 'contextual' ? middlewareReason : undefined);
  }
}

// True unless `res.status(...)` / `reply.code(...)` in the chain sets a status that is not a
// literal 5xx.
function isServerErrorOrUnset(receiver: Expression) {
  let node: Expression | undefined = receiver;
  while (node && ts.isCallExpression(node)) {
    const callee = unwrap(node.expression);
    if (ts.isPropertyAccessExpression(callee) && statusMethods.has(callee.name.text)) {
      const status = unwrap(node.arguments[0]);
      if (status && ts.isNumericLiteral(status)) return Number(status.text) >= serverErrorStatusMinimum;
      return Boolean(status) && serverErrorStatusName.test(status.getText());
    }
    const outer: Expression = node.expression;
    node =
      ts.isPropertyAccessExpression(outer) ||
      ts.isElementAccessExpression(outer) ||
      ts.isCallExpression(outer) ||
      ts.isNonNullExpression(outer) ||
      ts.isParenthesizedExpression(outer)
        ? unwrap(outer.expression)
        : undefined;
  }
  return true;
}

function checkNew(node: NewExpression, context: SecurityRuleContext) {
  const callee = unwrap(node.expression);
  const isResponse = ts.isIdentifier(callee) && callee.text === 'Response';
  if (!isResponse && !isNestException(node.expression, context)) return;
  if (node.arguments?.[0]) checkBody(node.arguments[0], context);
}

// `ctx.body = { stack: err.stack }`
function checkAssignment(node: BinaryExpression, context: SecurityRuleContext) {
  if (node.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return;
  const target = unwrap(node.left);
  const isBody =
    ts.isPropertyAccessExpression(target) && target.name.text === 'body' && chainRootName(target) === 'ctx';
  if (isBody) checkBody(node.right, context);
}

export { checkCall, checkNew, checkAssignment };
