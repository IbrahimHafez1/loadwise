import { ts } from './compiler.js';
import { consumesPrismaQuery, isGeneratedPrismaFile, prismaModelName } from './prisma.js';
import { outsideWrappers } from './query-results.js';
import type {
  CallExpression,
  Expression,
  Identifier,
  MemberName,
  Node,
  PropertyAccessExpression,
  PropertyAssignment,
  ShorthandPropertyAssignment,
  Statement,
} from 'typescript';
import type { CheckerAdapter, RuleContext, SymbolAdapter } from '../shared/types.js';

const arithmetic = () =>
  new Set([ts.SyntaxKind.PlusToken, ts.SyntaxKind.MinusToken, ts.SyntaxKind.AsteriskToken, ts.SyntaxKind.SlashToken]);

// An object-literal property written as `name: value` or `name`.
type KeyedProperty = PropertyAssignment | ShorthandPropertyAssignment;

// An update field such as `count: row.count + 1`.
interface CalculatedField extends PropertyAssignment {
  name: Identifier;
}

// What identifies the row an update or a read targets: the filtered field and the value it is
// compared with.
interface RowKey {
  name: string;
  value: SymbolAdapter | string;
}

function isPrismaTransactionMethod(name: MemberName, checker: CheckerAdapter) {
  if (name.text !== '$transaction') return false;
  const declarations = checker.getSymbolAtLocation(name)?.declarations;
  return Boolean(
    declarations?.length &&
    declarations.every(
      (declaration) =>
        (ts.isClassLike(declaration.parent) || ts.isInterfaceDeclaration(declaration.parent)) &&
        declaration.parent.name?.text === 'PrismaClient' &&
        isGeneratedPrismaFile(declaration.getSourceFile()),
    ),
  );
}

function sameReference(left: Node, right: Node, checker: CheckerAdapter): boolean {
  left = ts.skipOuterExpressions(left);
  right = ts.skipOuterExpressions(right);
  if (left.kind !== right.kind) return false;
  if (ts.isPropertyAccessExpression(left) && ts.isPropertyAccessExpression(right)) {
    return left.name.text === right.name.text && sameReference(left.expression, right.expression, checker);
  }
  if (left.kind === ts.SyntaxKind.ThisKeyword) {
    const bindsThis = (node: Node) => (ts.isFunctionLike(node) && !ts.isArrowFunction(node)) || ts.isClassLike(node);
    return ts.findAncestor(left, bindsThis) === ts.findAncestor(right, bindsThis);
  }
  if (!ts.isIdentifier(left) || !ts.isIdentifier(right) || left.text !== right.text) return false;
  const binding = checker.getSymbolAtLocation(left);
  return Boolean(binding && binding === checker.getSymbolAtLocation(right));
}

function checkTransaction(call: CallExpression, method: PropertyAccessExpression, context: RuleContext) {
  const callback = call.arguments[0] && ts.skipOuterExpressions(call.arguments[0]);
  if (
    !callback ||
    (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback)) ||
    !isPrismaTransactionMethod(method.name, context.checker)
  )
    return;
  const client = method.expression;
  const callbackBody = callback.body;
  function visit(node: Node): void {
    if (ts.isFunctionLike(node) || ts.isClassLike(node)) return;
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const queryMethod = node.expression;
      const delegate = queryMethod.expression;
      if (ts.isPropertyAccessExpression(delegate) && sameReference(client, delegate.expression, context.checker)) {
        const result = outsideWrappers(node);
        // The transaction adopts the callback result even when the callback is synchronous.
        const returned = result === callbackBody || ts.isReturnStatement(result.parent);
        if (
          (returned || consumesPrismaQuery(node, context.checker)) &&
          prismaModelName(queryMethod.name, context.checker)
        ) {
          context.report(
            queryMethod.name,
            'prisma-transaction-client-escape',
            'This call uses the outer Prisma client inside a transaction callback, so it runs outside the transaction and is not rolled back with it. Call it on the callback client, for example `tx.order.create(...)`.',
          );
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(callbackBody);
}

// Computed keys, duplicate names and spreads can override any apparent guard.
function objectField(object: Expression | undefined, name: string): KeyedProperty | undefined {
  if (!object || !ts.isObjectLiteralExpression(object)) return;
  let match: KeyedProperty | undefined;
  for (const property of object.properties) {
    if (
      (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) ||
      (!ts.isIdentifier(property.name) && !ts.isStringLiteral(property.name))
    )
      return;
    if (property.name.text !== name) continue;
    if (match) return;
    match = property;
  }
  return match;
}

// The value of a `name: value` field; a shorthand field has none to inspect.
function fieldInitializer(field: KeyedProperty | undefined): Expression | undefined {
  return field && ts.isPropertyAssignment(field) ? field.initializer : undefined;
}

function rowKey(options: Expression | undefined, checker: CheckerAdapter): RowKey | undefined {
  const where = fieldInitializer(objectField(options, 'where'));
  if (!where || !ts.isObjectLiteralExpression(where) || where.properties.length !== 1) return;
  const property = where.properties[0];
  if (!property.name || !ts.isIdentifier(property.name)) return;
  let value: SymbolAdapter | string | undefined;
  if (ts.isShorthandPropertyAssignment(property)) value = checker.getShorthandAssignmentValueSymbol(property);
  if (ts.isPropertyAssignment(property)) {
    const expression = ts.skipOuterExpressions(property.initializer);
    if (ts.isIdentifier(expression)) value = checker.getSymbolAtLocation(expression);
    if (ts.isStringLiteral(expression) || ts.isNumericLiteral(expression))
      value = expression.kind + '/' + expression.text;
  }
  if (value !== undefined) return { name: property.name.text, value };
}

function writeStatement(call: CallExpression): Statement | undefined {
  let expression: Node = call;
  while (ts.isOuterExpression(expression.parent) || ts.isAwaitExpression(expression.parent))
    expression = expression.parent;
  const parent = expression.parent;
  if (ts.isReturnStatement(parent) || ts.isExpressionStatement(parent)) return parent;
  if (
    ts.isVariableDeclaration(parent) &&
    parent.initializer === expression &&
    ts.isVariableDeclarationList(parent.parent) &&
    parent.parent.declarations.length === 1 &&
    ts.isVariableStatement(parent.parent.parent)
  ) {
    return parent.parent.parent;
  }
}

function isNullGuard(statement: Statement, binding: Node, checker: CheckerAdapter) {
  if (!ts.isIfStatement(statement) || statement.elseStatement) return false;
  const condition = ts.skipOuterExpressions(statement.expression);
  if (
    !ts.isPrefixUnaryExpression(condition) ||
    condition.operator !== ts.SyntaxKind.ExclamationToken ||
    !sameReference(condition.operand, binding, checker)
  )
    return false;
  const branch = statement.thenStatement;
  const exit = ts.isBlock(branch) && branch.statements.length === 1 ? branch.statements[0] : branch;
  return ts.isReturnStatement(exit) || ts.isThrowStatement(exit);
}

function guardedBySerializable(update: CallExpression, delegate: PropertyAccessExpression, checker: CheckerAdapter) {
  const callback = ts.findAncestor(update, ts.isFunctionLike);
  if (!callback || (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback))) return false;
  let callbackExpression: Node = callback;
  while (ts.isOuterExpression(callbackExpression.parent)) callbackExpression = callbackExpression.parent;
  const transaction = callbackExpression.parent;
  if (
    !ts.isCallExpression(transaction) ||
    transaction.arguments[0] !== callbackExpression ||
    !ts.isPropertyAccessExpression(transaction.expression) ||
    !callback.parameters[0] ||
    !sameReference(delegate.expression, callback.parameters[0].name, checker)
  )
    return false;
  const isolation = fieldInitializer(objectField(transaction.arguments[1], 'isolationLevel'));
  if (!isolation) return false;
  const serializable = ts.isStringLiteral(isolation)
    ? isolation.text === 'Serializable'
    : ts.isPropertyAccessExpression(isolation) &&
      isolation.name.text === 'Serializable' &&
      ts.isPropertyAccessExpression(isolation.expression) &&
      isolation.expression.name.text === 'TransactionIsolationLevel';
  return serializable && isPrismaTransactionMethod(transaction.expression.name, checker);
}

// The statements of a block-like container, if the node is one.
function statementsOf(node: Node): readonly Statement[] | undefined {
  if (ts.isBlock(node) || ts.isSourceFile(node) || ts.isModuleBlock(node) || ts.isCaseOrDefaultClause(node))
    return node.statements;
}

function readThatSupplied(
  field: CalculatedField,
  delegate: Expression,
  write: Statement,
  key: RowKey,
  checker: CheckerAdapter,
) {
  const value = ts.skipOuterExpressions(field.initializer);
  if (!ts.isBinaryExpression(value) || !arithmetic().has(value.operatorToken.kind)) return false;
  for (const operand of [value.left, value.right]) {
    const access = ts.skipOuterExpressions(operand);
    if (!ts.isPropertyAccessExpression(access) || access.name.text !== field.name.text) continue;
    const row = ts.skipOuterExpressions(access.expression);
    if (!ts.isIdentifier(row)) continue;
    const binding = checker.getSymbolAtLocation(row)?.valueDeclaration;
    if (
      !binding ||
      !ts.isVariableDeclaration(binding) ||
      !binding.initializer ||
      !ts.isVariableDeclarationList(binding.parent) ||
      !(binding.parent.flags & ts.NodeFlags.Const) ||
      binding.parent.declarations.length !== 1
    )
      continue;
    const declaration = binding.parent.parent;
    if (!ts.isVariableStatement(declaration) || declaration.parent !== write.parent) continue;
    if (declaration.end !== write.pos) {
      const statements = statementsOf(write.parent);
      if (!statements) continue;
      const readIndex = statements.indexOf(declaration);
      if (statements[readIndex + 2] !== write || !isNullGuard(statements[readIndex + 1], binding.name, checker))
        continue;
    }
    const initializer = ts.skipOuterExpressions(binding.initializer);
    if (!ts.isAwaitExpression(initializer)) continue;
    const read = ts.skipOuterExpressions(initializer.expression);
    if (
      !ts.isCallExpression(read) ||
      !ts.isPropertyAccessExpression(read.expression) ||
      !['findUnique', 'findUniqueOrThrow'].includes(read.expression.name.text) ||
      !sameReference(read.expression.expression, delegate, checker)
    )
      continue;
    const original = rowKey(read.arguments[0], checker);
    if (
      original?.name === key.name &&
      original.value === key.value &&
      prismaModelName(read.expression.name, checker) &&
      checker.getTypeAtLocation(access).flags & (ts.TypeFlags.NumberLike | ts.TypeFlags.BigIntLike)
    )
      return true;
  }
  return false;
}

function checkPrismaIntegrity(call: CallExpression, context: RuleContext) {
  const method = call.expression;
  if (!ts.isPropertyAccessExpression(method)) return;
  if (method.name.text === '$transaction') return checkTransaction(call, method, context);
  if (method.name.text !== 'update' || !ts.isPropertyAccessExpression(method.expression)) return;
  const options = call.arguments[0];
  const data = fieldInitializer(objectField(options, 'data'));
  if (!data || !ts.isObjectLiteralExpression(data)) return;
  const calculated = data.properties.filter(
    (property): property is CalculatedField =>
      ts.isPropertyAssignment(property) &&
      ts.isIdentifier(property.name) &&
      ts.isBinaryExpression(ts.skipOuterExpressions(property.initializer)),
  );
  if (!calculated.length) return;
  const { checker } = context;
  const key = rowKey(options, checker);
  const write = writeStatement(call);
  if (
    !key ||
    !write ||
    !consumesPrismaQuery(call, checker) ||
    !prismaModelName(method.name, checker) ||
    guardedBySerializable(call, method.expression, checker)
  )
    return;
  for (const field of calculated) {
    if (objectField(data, field.name.text) !== field) continue;
    if (readThatSupplied(field, method.expression, write, key, checker)) {
      context.report(
        field.name,
        'prisma-read-modify-write',
        'This update writes a value computed from an earlier read of the same row, so concurrent requests can overwrite each other. Use an atomic update such as `data: { count: { increment: 1 } }`, or check a version field and retry on conflict.',
      );
    }
  }
}

export { checkPrismaIntegrity, isPrismaTransactionMethod, objectField };
