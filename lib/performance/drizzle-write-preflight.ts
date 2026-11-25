import { ts } from './compiler.js';
import { executedQuery } from './drizzle.js';
import { drizzleTable, drizzleColumn } from './schema/drizzle-schema.js';
import { declaredInPackage, resolvedSymbol } from './schema/ts-helpers.js';
import { typeFromPackage } from './package-types.js';
import { createHash } from 'node:crypto';
import type { Block, CallExpression, Expression, Node, Statement } from 'typescript';
import type { CheckerAdapter, PerformanceRuleContext } from '../shared/types.js';

type DrizzleTableInfo = NonNullable<ReturnType<typeof drizzleTable>>;

// Column name to the identifier that supplies its value.
type FieldValues = Map<string, string>;

function preflightDigest(read: Node, write: Node): string {
  return createHash('sha256').update(read.getSourceFile().text.slice(read.pos, write.end)).digest('hex');
}

function existenceCheck(statement: Statement): { binding: string; call: CallExpression } | undefined {
  if (!ts.isVariableStatement(statement) || statement.declarationList.declarations.length !== 1) return;
  const { name, initializer } = statement.declarationList.declarations[0];
  if (
    !ts.isArrayBindingPattern(name) ||
    name.elements.length !== 1 ||
    !initializer ||
    !ts.isAwaitExpression(initializer)
  )
    return;
  const [binding] = name.elements;
  if (!ts.isBindingElement(binding) || !ts.isIdentifier(binding.name) || binding.initializer || binding.dotDotDotToken)
    return;
  if (ts.isCallExpression(initializer.expression)) return { binding: binding.name.text, call: initializer.expression };
}

function containsBinding(node: Node, binding: string): boolean {
  return (
    (ts.isIdentifier(node) && node.text === binding) ||
    ts.forEachChild(node, (child) => containsBinding(child, binding)) === true
  );
}

function throwsOnExistence(guard: Statement, binding: string, operation: string): boolean {
  if (!ts.isIfStatement(guard) || guard.elseStatement) return false;
  const branch =
    ts.isBlock(guard.thenStatement) && guard.thenStatement.statements.length === 1
      ? guard.thenStatement.statements[0]
      : guard.thenStatement;
  if (!ts.isThrowStatement(branch) || containsBinding(branch, binding)) return false;
  let condition = guard.expression;
  if (operation === 'delete') {
    if (!ts.isPrefixUnaryExpression(condition) || condition.operator !== ts.SyntaxKind.ExclamationToken) return false;
    condition = condition.operand;
  }
  return ts.isIdentifier(condition) && condition.text === binding;
}

// Accept equality on the declared table's columns and plain identifier values only.
function predicateFields(
  predicate: Expression | undefined,
  table: DrizzleTableInfo,
  checker: CheckerAdapter,
): FieldValues | undefined {
  if (!predicate || !ts.isCallExpression(predicate)) return;
  const terms =
    resolvedSymbol(predicate.expression, checker)?.name === 'and' &&
    declaredInPackage(predicate.expression, checker, ['drizzle-orm'])
      ? predicate.arguments
      : [predicate];
  const fields: FieldValues = new Map();
  for (const term of terms) {
    if (
      !ts.isCallExpression(term) ||
      term.arguments.length !== 2 ||
      resolvedSymbol(term.expression, checker)?.name !== 'eq' ||
      !declaredInPackage(term.expression, checker, ['drizzle-orm'])
    )
      return;
    const [field, value] = term.arguments;
    const column = drizzleColumn(field, checker);
    if (!column || column.table !== table || !ts.isIdentifier(value) || fields.has(column.column)) return;
    fields.set(column.column, value.text);
  }
  return fields.size ? fields : undefined;
}

function insertedFields(object: Expression | undefined): FieldValues | undefined {
  if (!object || !ts.isObjectLiteralExpression(object)) return;
  const fields: FieldValues = new Map();
  for (const property of object.properties) {
    if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) return;
    const value = ts.isPropertyAssignment(property) ? property.initializer : property.name;
    if (!ts.isIdentifier(property.name) || !ts.isIdentifier(value) || fields.has(property.name.text)) return;
    fields.set(property.name.text, value.text);
  }
  return fields;
}

function sameDatabase(left: Expression, right: Expression): boolean {
  if (ts.isIdentifier(left) && ts.isIdentifier(right)) return left.text === right.text;
  return (
    ts.isPropertyAccessExpression(left) &&
    ts.isPropertyAccessExpression(right) &&
    left.expression.kind === ts.SyntaxKind.ThisKeyword &&
    right.expression.kind === ts.SyntaxKind.ThisKeyword &&
    left.name.text === right.name.text
  );
}

function plainPredicate(call: Expression): boolean {
  if (!ts.isCallExpression(call) || !ts.isIdentifier(call.expression) || call.questionDotToken) return false;
  return call.arguments.every(
    (argument) =>
      ts.isIdentifier(argument) ||
      (ts.isPropertyAccessExpression(argument) && ts.isIdentifier(argument.expression) && !argument.questionDotToken) ||
      (ts.isCallExpression(argument) && plainPredicate(argument)),
  );
}

function hasExactUniqueIndex(
  table: NonNullable<ReturnType<typeof drizzleTable>>,
  fields: ReadonlyMap<string, unknown>,
): boolean {
  return table.indexes.some(
    (index) =>
      index.unique &&
      !index.predicate &&
      index.keys.length === fields.size &&
      index.keys.every((key) => key.column !== undefined && fields.has(key.column)),
  );
}

function isMysql2Receiver(receiver: Expression, checker: CheckerAdapter): boolean {
  const type = checker.getTypeAtLocation(receiver);
  const members = type.flags & ts.TypeFlags.Intersection ? (type.types ?? [type]) : [type];
  const getter =
    ts.isPropertyAccessExpression(receiver) &&
    resolvedSymbol(receiver.name, checker)?.declarations?.some(ts.isGetAccessorDeclaration);
  return (
    !getter &&
    members.some((member) => typeFromPackage(member, ['drizzle-orm/mysql2'], ['MySql2Database', 'MySql2Transaction']))
  );
}

type ExistenceCheck = NonNullable<ReturnType<typeof existenceCheck>>;
type ExecutedQuery = NonNullable<ReturnType<typeof executedQuery>>;

// An awaited write statement preceded by an existence check and the guard that throws on it.
interface PreflightSite {
  statement: Statement;
  block: Block;
  position: number;
  check: ExistenceCheck;
}

function findPreflightSite(call: CallExpression): PreflightSite | undefined {
  if (!ts.isAwaitExpression(call.parent) || !ts.isExpressionStatement(call.parent.parent)) return;
  const statement = call.parent.parent;
  const block = statement.parent;
  if (
    !ts.isBlock(block) ||
    !ts.isPropertyAccessExpression(call.expression) ||
    !['where', 'values'].includes(call.expression.name.text)
  )
    return;
  const position = block.statements.indexOf(statement);
  if (position < 2 || !ts.isIfStatement(block.statements[position - 1])) return;
  const check = existenceCheck(block.statements[position - 2]);
  if (!check) return;
  return { statement, block, position, check };
}

function isGuardedWrite(write: ExecutedQuery, { block, position, check }: PreflightSite): boolean {
  const operation = write.root.text;
  return (
    ['delete', 'insert'].includes(operation) &&
    write.steps.length === 1 &&
    write.steps[0].name === (operation === 'delete' ? 'where' : 'values') &&
    throwsOnExistence(block.statements[position - 1], check.binding, operation)
  );
}

// The check must be `select().from(table).where(...).limit(1)` on the same database as the write.
function isSingleRowRead(read: ExecutedQuery, write: ExecutedQuery): boolean {
  return (
    read.root.text === 'select' &&
    !read.root.parent.parent.arguments.length &&
    read.steps.map((step) => step.name).join('.') === 'limit.where.from' &&
    read.steps[0].call.arguments[0]?.getText() === '1' &&
    sameDatabase(read.root.parent.expression, write.root.parent.expression)
  );
}

function unusedAfterWrite({ block, position, check }: PreflightSite): boolean {
  return !block.statements.slice(position + 1).some((later) => containsBinding(later, check.binding));
}

function sameFieldValues(readFields: FieldValues, writeFields: FieldValues): boolean {
  return (
    writeFields.size === readFields.size && ![...readFields].some(([field, value]) => writeFields.get(field) !== value)
  );
}

// Only a delete by plain predicates on a mysql2 database can be fixed by its digest.
function mysql2DeleteDetails(
  read: ExecutedQuery,
  write: ExecutedQuery,
  site: PreflightSite,
  checker: CheckerAdapter,
): { mysql2DeletePreflight: string } | undefined {
  const readTable = read.steps[2].call.arguments[0];
  const writeTable = write.root.parent.parent.arguments[0];
  const argument = write.steps[0].call.arguments[0];
  if (
    write.root.text !== 'delete' ||
    !ts.isIdentifier(readTable) ||
    !ts.isIdentifier(writeTable) ||
    !plainPredicate(read.steps[1].call.arguments[0]) ||
    !plainPredicate(argument) ||
    !isMysql2Receiver(write.root.parent.expression, checker)
  )
    return;
  return { mysql2DeletePreflight: preflightDigest(site.block.statements[site.position - 2], site.statement) };
}

function checkWritePreflight(call: CallExpression, context: PerformanceRuleContext): void {
  const site = findPreflightSite(call);
  if (!site) return;
  const checker = context.checker;
  const write = executedQuery(call, checker);
  if (!write || !isGuardedWrite(write, site)) return;
  const operation = write.root.text;
  const read = executedQuery(site.check.call, checker);
  if (!read || !isSingleRowRead(read, write)) return;
  const readTable = read.steps[2].call.arguments[0];
  const writeTable = write.root.parent.parent.arguments[0];
  if (!readTable || !writeTable) return;
  const table = drizzleTable(readTable, checker);
  if (!table || table !== drizzleTable(writeTable, checker)) return;
  const readFields = predicateFields(read.steps[1].call.arguments[0], table, checker);
  if (!readFields || !hasExactUniqueIndex(table, readFields)) return;
  const argument = write.steps[0].call.arguments[0];
  const writeFields = operation === 'insert' ? insertedFields(argument) : predicateFields(argument, table, checker);
  if (!writeFields || !sameFieldValues(readFields, writeFields) || !unusedAfterWrite(site)) return;
  const advice =
    operation === 'insert'
      ? 'Another request can insert the same unique key after the check. Consider inserting directly and translating only a violation of the matching unique constraint.'
      : 'Another request can delete the row after the check. Consider testing the delete result for a missing row and preserving the existing error.';
  context.report(
    read.root,
    'drizzle-write-preflight',
    `A separate existence check before the ${operation} adds a round trip. ${advice}`,
    undefined,
    mysql2DeleteDetails(read, write, site, checker),
  );
}

export { checkWritePreflight, preflightDigest };
