// plaintext-password-storage: a request-supplied password is written to the database without being
// hashed. Only writes are judged; a bare password column proves nothing because the hash may be
// applied in a service.
import { ts } from '../../performance/compiler.js';
import { propertyKeyName, lastSegment, nameWords, enclosingFunction, referencesOf } from './shared.js';
import { unwrap, objectLiteralOf, findProperty, methodName } from '../exposure/literals.js';
import type {
  CallExpression,
  Expression,
  Node,
  ObjectLiteralExpression,
  PropertyAssignment,
  SourceFile,
} from 'typescript';
import type { CheckerAdapter, ProgramAdapter, SecurityRuleContext } from '../../shared/types.js';

const ruleId = 'plaintext-password-storage';
const traceSinkKind = 'html';
const passwordKeys = new Set(['password', 'passwd', 'pwd', 'userpassword', 'userpasswd', 'user_password']);
// A value named like one of these words is already a digest or ciphertext.
const hashedWords = new Set(['hash', 'hashed', 'digest', 'encrypted', 'crypt', 'cipher', 'bcrypt', 'argon', 'salted']);
const ormWriteMethods = new Set([
  'create',
  'createMany',
  'bulkCreate',
  'insert',
  'insertOne',
  'insertMany',
  'update',
  'updateOne',
  'updateMany',
  'upsert',
  'save',
  'values',
  'set',
  'findOneAndUpdate',
  'findByIdAndUpdate',
  'merge',
]);
// Properties that wrap the written columns: Prisma `data`/`create`/`update`, Mongo `$set`, Drizzle
// `set`.
const wrapperProperties = new Set(['data', 'create', 'update', '$set', 'set', 'values', 'defaults']);
const sqlRunMethods = new Set(['query', 'execute', 'run', 'exec', 'raw', 'unsafe', 'prepare', 'all', 'get']);
const sqlWritesPassword = /\b(?:insert\s+into|update)\b[\s\S]*\b(?:password|passwd|pwd)\b/i;
const maxWrapperDepth = 3;
// A model that hashes in a lifecycle hook stores a hash even when the write passes plain text.
const hookPattern =
  /@Before(?:Insert|Update)\b|\bbefore(?:Create|Save|Update|Insert|BulkCreate|Validate)\b|\.pre\(\s*['"](?:save|validate|findOneAndUpdate|updateOne)|\$extends\b|\$use\(/;
const hashCallPattern = /bcrypt|argon2|scrypt|pbkdf2|\bhash\w*\(|\.hash\b/i;
// A Sequelize setter that rewrites the column on every assignment.
const passwordSetterPattern = /setDataValue\(\s*['"]password/;
// Value objects and message builders also have `create`; their receivers say so
// (`LoginCommand.create`).
const nonDatabaseReceiver =
  /(?:Command|Dto|Request|Response|Schema|Event|Builder|Factory|Payload|Input|Params|Props|Form|Mock)$/;
const hookCache = new WeakMap<ProgramAdapter, boolean>();

const hashingAdvice = 'Hash it with `bcrypt` or `argon2` before the write and store only the hash.';
const untracedReason = 'The value is a function parameter; confirm callers hash it before it reaches this write.';
const secondHopReason = 'Reached through two calls; confirm the intermediate functions hash the value.';

function isPasswordKey(name: string | undefined) {
  return name !== undefined && passwordKeys.has(name.toLowerCase());
}

function isHashedName(name: string | undefined) {
  return name !== undefined && nameWords(name).some((word) => hashedWords.has(word));
}

function fileHashesPassword(file: SourceFile) {
  if (file.isDeclarationFile || /[\\/]node_modules[\\/]/.test(file.fileName)) return false;
  return passwordSetterPattern.test(file.text) || (hookPattern.test(file.text) && hashCallPattern.test(file.text));
}

function programHasHashingHook(program: ProgramAdapter) {
  if (!hookCache.has(program))
    hookCache.set(
      program,
      (program.getSourceFiles?.() ?? program.getToolingSourceFiles?.() ?? []).some(fileHashesPassword),
    );
  return hookCache.get(program);
}

// Object literals a write call stores, looking through the wrappers ORMs put around the columns.
function writtenObjects(expression: Expression, checker: CheckerAdapter, depth = 0): ObjectLiteralExpression[] {
  const node = unwrap(expression);
  if (!node || depth > maxWrapperDepth) return [];
  if (ts.isArrayLiteralExpression(node))
    return node.elements.flatMap((element) => writtenObjects(element, checker, depth + 1));
  const literal = objectLiteralOf(node, checker);
  if (!literal) return [];
  const nested = literal.properties
    .filter(
      (property): property is PropertyAssignment =>
        ts.isPropertyAssignment(property) && wrapperProperties.has(propertyKeyName(property.name) ?? ''),
    )
    .flatMap((property) => writtenObjects(property.initializer, checker, depth + 1));
  return [literal, ...nested];
}

function passwordValues(literal: ObjectLiteralExpression): Expression[] {
  return literal.properties.flatMap((property) => {
    if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) return [];
    const key = propertyKeyName(property.name);
    const value = key !== undefined && isPasswordKey(key) ? findProperty(literal, key)?.value : undefined;
    return value ? [value] : [];
  });
}

function describeWrite(label: string) {
  return `A plaintext password from ${label} is stored without hashing, so a database leak exposes every user's password. ${hashingAdvice}`;
}

// A value that reaches the write from the request is a finding; a bare password parameter is only
// contextual.
function checkStoredValue(value: Expression, context: SecurityRuleContext) {
  if (isHashedName(lastSegment(value)) || isHashedName(value.getText())) return;
  const traced = context.taint.trace(value, traceSinkKind);
  if (traced) {
    const reason = traced.hops >= 2 ? secondHopReason : undefined;
    return context.report(value, ruleId, describeWrite(traced.label), reason, { taint: traced });
  }
  if (!context.taint.isUntracedParameter(value) || !isPasswordKey(lastSegment(value))) return;
  context.report(value, ruleId, describeWrite('a function parameter'), untracedReason);
}

function checkOrmWrite(call: CallExpression, context: SecurityRuleContext) {
  const method = methodName(call);
  const callee = unwrap(call.expression);
  if (!method || !ormWriteMethods.has(method) || !ts.isPropertyAccessExpression(callee)) return;
  if (nonDatabaseReceiver.test(callee.expression.getText())) return;
  for (const argument of call.arguments)
    for (const literal of writtenObjects(argument, context.checker))
      for (const value of passwordValues(literal)) checkStoredValue(value, context);
}

// `user.password = req.body.password; await user.save()`: assignments to the saved document in the
// same function.
function checkAssignThenSave(call: CallExpression, context: SecurityRuleContext) {
  const callee = unwrap(call.expression);
  if (methodName(call) !== 'save' || !ts.isPropertyAccessExpression(callee)) return;
  const receiver = unwrap(callee.expression);
  if (!ts.isIdentifier(receiver)) return;
  const scope = enclosingFunction(call) ?? context.sourceFile;
  for (const reference of referencesOf(receiver, scope, context.checker)) {
    const access = reference.parent;
    const assignment = access?.parent;
    if (!ts.isPropertyAccessExpression(access) || access.expression !== reference) continue;
    if (!isPasswordKey(access.name.text)) continue;
    if (!ts.isBinaryExpression(assignment) || assignment.left !== access) continue;
    if (assignment.operatorToken.kind !== ts.SyntaxKind.EqualsToken) continue;
    checkStoredValue(unwrap(assignment.right), context);
  }
}

function sqlText(expression: Expression): string | undefined {
  const node = unwrap(expression);
  if (!node) return;
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isTemplateExpression(node))
    return node.head.text + node.templateSpans.map((span) => '?' + span.literal.text).join('');
}

// Raw `INSERT`/`UPDATE` on a password column: a bound parameter or interpolation named like the
// password.
function checkRawSql(call: CallExpression, context: SecurityRuleContext) {
  const method = methodName(call);
  if (!method || !sqlRunMethods.has(method) || !sqlWritesPassword.test(sqlText(call.arguments[0]) ?? '')) return;
  const first = unwrap(call.arguments[0]);
  const interpolated = ts.isTemplateExpression(first) ? first.templateSpans.map((span) => span.expression) : [];
  const bound = unwrap(call.arguments[1]);
  const parameters = bound && ts.isArrayLiteralExpression(bound) ? bound.elements : [];
  for (const value of [...interpolated, ...parameters])
    if (isPasswordKey(lastSegment(value))) checkStoredValue(unwrap(value), context);
}

function checkPlaintextPassword(node: Node, context: SecurityRuleContext) {
  if (!ts.isCallExpression(node) || programHasHashingHook(context.program)) return;
  checkOrmWrite(node, context);
  checkAssignThenSave(node, context);
  checkRawSql(node, context);
}

export { checkPlaintextPassword };
