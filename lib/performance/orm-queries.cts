import { loadSyntax, isDefaultLibrary } from './compiler.cjs';
import { findRepeatOwner, promiseCombinatorOf } from './repeated.cjs';
import { awaitedResult, consumesLazyQuery, isDiscardedValue, outsideWrappers } from './query-results.cjs';
import { isBatchCollection, shouldReportLoopQuery } from './query-loops.cjs';
import { isSequentialByDesign } from './sequential-loops.cjs';
import { modelFallback } from './models/index.cjs';
import { declaredTypeormOwner, isTypeormPackage, methodOwner, symbolOwner, typeormImportOf } from './orm-owners.cjs';
import { returnedRowMap, checkTypeormProjection, isWhereOnlyOptions } from './typeorm-projection.cjs';
import type {
  AwaitExpression,
  Block,
  CallExpression,
  Expression,
  MemberName,
  Node,
  PropertyAccessExpression,
  SyntaxKind,
} from 'typescript';
import type { CheckerAdapter, PerformanceRuleContext } from '../shared/types.cjs';
import type { ModelFamily } from './types/model-fallback.cjs';
import type { RepeatOwner } from './types/repeat-owner.cjs';
const ts = loadSyntax();

const repoReads = new Set([
  'find',
  'findBy',
  'findByIds',
  'findOne',
  'findOneBy',
  'findOneById',
  'findOneOrFail',
  'findOneByOrFail',
  'findAndCount',
  'findAndCountBy',
  'count',
  'countBy',
  'exists',
  'existsBy',
]);
// Each call is one statement; `save` of an entity array is already a batch, and the loop rules
// check that.
const typeormWrites = new Set(['save', 'insert', 'update', 'delete', 'upsert', 'increment']);
const typeormRawOwners = new Set(['TypeORM', 'TypeORM EntityManager', 'TypeORM DataSource', 'TypeORM QueryRunner']);
const rowChangingSql = /^\s*(?:update|delete)\b/i;
const sequelizeReads = new Set(['findAll', 'findOne', 'findByPk', 'findAndCountAll', 'count', 'min', 'max', 'sum']);
const mongoReads = new Set([
  'find',
  'findOne',
  'findById',
  'exists',
  'countDocuments',
  'estimatedDocumentCount',
  'distinct',
]);
const mongoModifiers = new Set([
  'lean',
  'where',
  'select',
  'sort',
  'limit',
  'skip',
  'populate',
  'session',
  'collation',
  'hint',
  'setOptions',
]);
const mongoTerminals = new Set(['exec', 'then', 'catch', 'finally']);
const knexReads = new Set([
  'select',
  'first',
  'from',
  'table',
  'where',
  'andWhere',
  'whereIn',
  'whereNull',
  'whereNotNull',
  'join',
  'leftJoin',
  'orderBy',
  'groupBy',
  'distinct',
  'limit',
  'offset',
  'pluck',
  'count',
  'clone',
]);
const kyselyExecutors = new Set(['execute', 'executeTakeFirst', 'executeTakeFirstOrThrow']);
const mikroOrmReads = new Set(['find', 'findOne', 'findOneOrFail', 'findAll', 'findAndCount', 'count']);
const payloadReads = new Set(['find', 'findByID', 'findGlobal', 'findVersions', 'findVersionByID', 'count']);
// How each owner reads many keys in one call, for the read message.
const batchReadExamples: Record<string, string> = {
  MikroORM: '`{ id: ids }`, which MikroORM reads as `$in`',
  Payload: '`where: { id: { in: ids } }`',
};
// ORMs whose project models are recognised from source when the package types are missing (reduced
// precision).
const modelFallbackOwners: Partial<Record<ModelFamily, string>> = {
  typeorm: 'TypeORM',
  mongoose: 'Mongoose Model',
  sequelize: 'Sequelize',
};
const UNKNOWN_WRITE_SHAPE_REASON =
  'The ORM package is not installed, so the written value may already be a list saved in one statement.';
// `{ where: { relation: { id: { in: ids } } } }` nests the key list this deep.
const MAX_FILTER_DEPTH = 3;
const listOperators = new Set(['in', '$in']);
const candidateNames = new Set([
  ...repoReads,
  ...typeormWrites,
  'query',
  ...sequelizeReads,
  ...mongoReads,
  ...mongoModifiers,
  ...mongoTerminals,
  ...knexReads,
  ...kyselyExecutors,
  ...mikroOrmReads,
  ...payloadReads,
]);
const knexPackages = ['knex'];
const knexDatabases = ['Knex', 'Transaction'];
const knexBuilders = ['QueryBuilder'];
const simpleColumn = /^(?:[a-z_]\w*\.)?(?:[a-z_]\w*|\*)$/i;
const logicalOperators: readonly SyntaxKind[] = [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken];
const literalKeywords: readonly SyntaxKind[] = [
  ts.SyntaxKind.TrueKeyword,
  ts.SyntaxKind.FalseKeyword,
  ts.SyntaxKind.NullKeyword,
];

const identifierCounts = new WeakMap<Block, Map<string, number>>();

function isNullish(expression: Expression) {
  const value = ts.skipOuterExpressions(expression);
  return value.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(value) && value.text === 'undefined');
}

// The value a truthiness test reads: `x`, `!x`, `!!x`, `Boolean(x)`, `x != null`, `x !== null` or
// `x !== undefined`.
function testedValue(expression: Expression, allowBare: boolean): Expression | undefined {
  let value: Expression = ts.skipOuterExpressions(expression);
  if (ts.isPrefixUnaryExpression(value) && value.operator === ts.SyntaxKind.ExclamationToken) {
    value = ts.skipOuterExpressions(value.operand);
    if (ts.isPrefixUnaryExpression(value) && value.operator === ts.SyntaxKind.ExclamationToken)
      value = ts.skipOuterExpressions(value.operand);
    return value;
  }
  if (
    ts.isCallExpression(value) &&
    ts.isIdentifier(value.expression) &&
    value.expression.text === 'Boolean' &&
    value.arguments.length === 1
  )
    return ts.skipOuterExpressions(value.arguments[0]);
  if (
    ts.isBinaryExpression(value) &&
    ((value.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsToken &&
      ts.skipOuterExpressions(value.right).kind === ts.SyntaxKind.NullKeyword) ||
      (value.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken && isNullish(value.right)))
  )
    return ts.skipOuterExpressions(value.left);
  if (allowBare) return value;
}

function usedOnlyInNextCondition(declaration: Node) {
  if (
    !ts.isVariableDeclaration(declaration) ||
    !ts.isIdentifier(declaration.name) ||
    declaration.type ||
    !(declaration.parent.flags & ts.NodeFlags.Const)
  )
    return false;
  const statement = declaration.parent.parent;
  const block = statement.parent;
  if (!ts.isVariableStatement(statement) || !ts.isBlock(block)) return false;
  const guard = block.statements[block.statements.indexOf(statement) + 1];
  if (!guard || (!ts.isIfStatement(guard) && !ts.isReturnStatement(guard)) || !guard.expression) return false;
  // `return row` hands the entity on; only a boolean form of it is an existence test.
  const condition = testedValue(guard.expression, ts.isIfStatement(guard));
  if (!condition || !ts.isIdentifier(condition) || condition.text !== declaration.name.text) return false;
  // Include closures and shorthand object properties. A same-spelled identifier in another scope
  // can only prevent a suggestion. Count once per block to avoid rescans for consecutive queries.
  let counts = identifierCounts.get(block);
  if (!counts) {
    const tally = new Map<string, number>();
    function count(node: Node) {
      if (ts.isIdentifier(node)) tally.set(node.text, (tally.get(node.text) ?? 0) + 1);
      ts.forEachChild(node, count);
    }
    count(block);
    identifierCounts.set(block, tally);
    counts = tally;
  }
  return counts.get(condition.text) === 2 && !counts.has('eval');
}

function existenceUse(
  call: CallExpression,
  awaited: AwaitExpression | undefined,
  method: string,
): 'exists' | 'existsBy' | undefined {
  if (!awaited || !['findOne', 'findOneBy'].includes(method) || call.arguments.length !== 1) return;
  // Changing the method also changes the return type. Leave explicitly asserted
  // entities and Promise<Entity> values alone, even if their final use is boolean.
  let operand: Expression = awaited.expression;
  while (ts.isParenthesizedExpression(operand)) operand = operand.expression;
  if (operand !== call) return;
  const options = ts.skipOuterExpressions(call.arguments[0]);
  if (!ts.isObjectLiteralExpression(options) || !options.properties.length) return;
  if (method === 'findOne') {
    const [property] = options.properties;
    if (
      options.properties.length !== 1 ||
      !ts.isPropertyAssignment(property) ||
      ts.isComputedPropertyName(property.name) ||
      property.name.text !== 'where' ||
      !ts.isObjectLiteralExpression(ts.skipOuterExpressions(property.initializer))
    )
      return;
  }
  let value: Node = awaited;
  while (ts.isParenthesizedExpression(value.parent)) value = value.parent;
  while (ts.isBinaryExpression(value.parent) && logicalOperators.includes(value.parent.operatorToken.kind)) {
    value = value.parent;
    while (ts.isParenthesizedExpression(value.parent)) value = value.parent;
  }
  const use = value.parent;
  if (
    usedOnlyInNextCondition(use) ||
    (ts.isPrefixUnaryExpression(use) && use.operator === ts.SyntaxKind.ExclamationToken) ||
    (ts.isIfStatement(use) && use.expression === value) ||
    (ts.isConditionalExpression(use) && use.condition === value)
  )
    return method === 'findOne' ? 'exists' : 'existsBy';
}

function lengthRead(awaited: AwaitExpression | undefined): MemberName | undefined {
  if (!awaited) return;
  const expression = outsideWrappers(awaited);
  const access = expression.parent;
  if (!ts.isPropertyAccessExpression(access) || access.expression !== expression || access.name.text !== 'length')
    return;
  const use = outsideWrappers(access);
  if (!ts.isAssignmentTarget(access) && !ts.isDeleteExpression(use.parent) && !isDiscardedValue(use))
    return access.name;
}

function simpleMongoFilter(call: CallExpression) {
  if (!call.arguments.length) return true;
  const [filter] = call.arguments;
  if (call.arguments.length !== 1 || !ts.isObjectLiteralExpression(filter)) return false;
  // Filters with server-specific operators (e.g. $near) can require a different count query.
  return filter.properties.every(
    (property) =>
      (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) &&
      (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) &&
      !property.name.text.startsWith('$') &&
      (ts.isShorthandPropertyAssignment(property) ||
        ts.isIdentifier(property.initializer) ||
        ts.isStringLiteral(property.initializer) ||
        ts.isNumericLiteral(property.initializer) ||
        literalKeywords.includes(property.initializer.kind)),
  );
}

function countsModelFind(
  call: CallExpression,
  callee: PropertyAccessExpression,
  owner: string | undefined,
  checker: CheckerAdapter,
) {
  // Only transparent lean()/exec() links are allowed. A limit, skip or populated
  // query can change the cardinality or add work that the caller depends on.
  let current = call;
  let currentCallee = callee;
  while (
    owner === 'Mongoose Query' &&
    ['lean', 'exec'].includes(currentCallee.name.text) &&
    !current.arguments.length
  ) {
    const receiver = ts.skipOuterExpressions(currentCallee.expression);
    if (!ts.isCallExpression(receiver) || !ts.isPropertyAccessExpression(receiver.expression)) return false;
    current = receiver;
    currentCallee = receiver.expression;
    owner = methodOwner(currentCallee.name, checker);
  }
  return owner === 'Mongoose Model' && currentCallee.name.text === 'find' && simpleMongoFilter(current);
}

function literalTable(call: CallExpression) {
  return call.arguments.length === 1 && ts.isStringLiteralLike(call.arguments[0]);
}

function simpleBuilderSelect(call: Expression, owner: string | undefined, context: PerformanceRuleContext) {
  let selected = owner === 'Knex';
  let current: Expression = call;
  while (ts.isCallExpression(current)) {
    const access = current.expression;
    if (owner === 'Knex' && literalTable(current) && context.isPackageType(access, knexPackages, knexDatabases))
      return true;
    if (!ts.isPropertyAccessExpression(access) || methodOwner(access.name, context.checker) !== owner) return false;
    const method = access.name.text;
    if (owner === 'Kysely' && method === 'selectFrom') return selected && literalTable(current);
    if (owner === 'Knex' && (method === 'from' || method === 'table')) {
      return literalTable(current) && context.isPackageType(access.expression, knexPackages, knexDatabases);
    }
    if (
      method === 'select' &&
      current.arguments.length &&
      current.arguments.every((argument) => ts.isStringLiteralLike(argument) && simpleColumn.test(argument.text))
    )
      selected = true;
    else if (owner === 'Kysely' && method === 'selectAll' && !current.arguments.length) selected = true;
    else if (
      method !== 'where' ||
      current.arguments.length < 2 ||
      current.arguments.length > 3 ||
      !ts.isStringLiteralLike(current.arguments[0])
    )
      return false;
    current = ts.skipOuterExpressions(access.expression);
  }
  return false;
}

// `save(rows)` or `delete(ids)` already writes a whole list in one statement, typically one group
// per iteration.
function writesList(call: CallExpression, checker: CheckerAdapter) {
  return call.arguments.some((argument: Expression) => isArrayType(argument, checker));
}

// Without the ORM's types a written value of unknown shape may already be a whole list.
function isObjectLiteralArgument(call: CallExpression) {
  return !!call.arguments[0] && ts.isObjectLiteralExpression(ts.skipOuterExpressions(call.arguments[0]));
}

// `query('UPDATE ...')`: a raw statement that changes rows, read from its literal text.
function changesRows(call: CallExpression) {
  const text = call.arguments[0] && ts.skipOuterExpressions(call.arguments[0]);
  if (!text) return false;
  if (ts.isStringLiteralLike(text)) return rowChangingSql.test(text.text);
  return ts.isTemplateExpression(text) && rowChangingSql.test(text.head.text);
}

// A filter that already names a list of keys, such as one chunk of ids, reads them all in one call.
// MikroORM treats any array value as `$in`; Payload spells it `{ in: ids }`.
function readsKeyList(call: CallExpression, owner: string | undefined, checker: CheckerAdapter) {
  return call.arguments.some((argument: Expression) => hasKeyList(argument, owner, checker, 0));
}

function hasKeyList(
  expression: Expression,
  owner: string | undefined,
  checker: CheckerAdapter,
  depth: number,
): boolean {
  const value = ts.skipOuterExpressions(expression);
  if (depth > MAX_FILTER_DEPTH || !ts.isObjectLiteralExpression(value)) return false;
  return value.properties.some(
    (property) =>
      ts.isPropertyAssignment(property) &&
      (((owner === 'MikroORM' ||
        (!ts.isComputedPropertyName(property.name) && listOperators.has(property.name.text))) &&
        isArrayType(property.initializer, checker)) ||
        hasKeyList(property.initializer, owner, checker, depth + 1)),
  );
}

// `In(chunk)` anywhere in a read's options or a write's criteria, including beside a spread or
// inside a relation filter, handles one chunk of the loop's list per iteration: `count({ where: {
// id: In(chunk) } })`.
function passesInBatch(call: CallExpression, checker: CheckerAdapter) {
  const loop = findRepeatOwner(call, checker);
  return !!loop && call.arguments.some((argument: Expression) => hasInBatch(argument, loop, checker, 0));
}

function hasInBatch(expression: Expression, loop: RepeatOwner, checker: CheckerAdapter, depth: number): boolean {
  const value = ts.skipOuterExpressions(expression);
  if (ts.isCallExpression(value) && ts.isIdentifier(value.expression) && value.arguments.length === 1)
    return typeormImportOf(value.expression, checker) === 'In' && isBatchCollection(value.arguments[0], loop, checker);
  // `const options = { where: { id: In(chunk) } }` built just before the call.
  if (ts.isIdentifier(value)) {
    const declaration = checker.getSymbolAtLocation(value)?.valueDeclaration;
    return (
      !!declaration &&
      ts.isVariableDeclaration(declaration) &&
      !!(declaration.parent.flags & ts.NodeFlags.Const) &&
      !!declaration.initializer &&
      ts.isObjectLiteralExpression(ts.skipOuterExpressions(declaration.initializer)) &&
      hasInBatch(declaration.initializer, loop, checker, depth)
    );
  }
  // An array of WHERE objects is a disjunction, where any arm without the batch could match every
  // row.
  if (depth >= MAX_FILTER_DEPTH || !ts.isObjectLiteralExpression(value)) return false;
  return value.properties.some(
    (property) => ts.isPropertyAssignment(property) && hasInBatch(property.initializer, loop, checker, depth + 1),
  );
}

function isArrayType(node: Node, checker: CheckerAdapter) {
  const symbol = checker.getTypeAtLocation(node).getSymbol();
  return (
    (symbol?.name === 'Array' || symbol?.name === 'ReadonlyArray') &&
    !!symbol.declarations?.some((declaration) => isDefaultLibrary(checker, declaration.getSourceFile()))
  );
}

interface ResolvedOrmOwner {
  readonly owner: string | undefined;
  readonly recognisedFromSource: boolean;
}

function resolveOrmOwner(
  access: Expression,
  propertyAccess: PropertyAccessExpression | undefined,
  member: MemberName | undefined,
  context: PerformanceRuleContext,
): ResolvedOrmOwner {
  let owner: string | undefined = member && methodOwner(member, context.checker);
  if (propertyAccess && !owner && !context.checker.getSymbolAtLocation(propertyAccess.name))
    owner = declaredTypeormOwner(propertyAccess.expression, context.checker);
  const recognisedFromSource = !!member && !owner && !context.checker.getSymbolAtLocation(member);
  if (recognisedFromSource) {
    const fallbackOrm = modelFallback(access, context.checker)?.orm;
    owner = fallbackOrm === undefined ? undefined : modelFallbackOwners[fallbackOrm];
  }
  return { owner, recognisedFromSource };
}

interface TypeormReadFacts {
  readonly propertyAccess: PropertyAccessExpression | undefined;
  readonly owner: string;
  readonly rowMap: CallExpression | false | undefined;
  readonly exists: 'exists' | 'existsBy' | undefined;
  readonly repeated: boolean;
}

function reportTypeormRead(call: CallExpression, facts: TypeormReadFacts, context: PerformanceRuleContext): void {
  const { propertyAccess, owner, rowMap, exists, repeated } = facts;
  if (
    rowMap &&
    propertyAccess &&
    symbolOwner(context.checker.getTypeAtLocation(propertyAccess.expression).getProperty('findBy')) === owner
  )
    checkTypeormProjection(call, rowMap, context);
  if (
    exists &&
    propertyAccess &&
    !repeated &&
    symbolOwner(context.checker.getTypeAtLocation(propertyAccess.expression).getProperty(exists)) === owner
  ) {
    context.report(
      propertyAccess.name,
      'typeorm-existence-materialization',
      `This read hydrates entities only to test existence. Use \`Repository.${exists}()\` with the same filter; entity-load hooks and subscribers will not run.`,
    );
  }
}

interface LoopQueryFacts {
  readonly owner: string;
  readonly name: string;
  readonly write: boolean;
  readonly recognisedFromSource: boolean;
}

function reportLoopQuery(call: CallExpression, facts: LoopQueryFacts, context: PerformanceRuleContext): void {
  const { owner, name, write, recognisedFromSource } = facts;
  const access = call.expression;
  const member = ts.isPropertyAccessExpression(access) ? access.name : undefined;
  if (
    (write && name !== 'query' && writesList(call, context.checker)) ||
    isSequentialByDesign(call, findRepeatOwner(call, context.checker)) ||
    (owner.startsWith('TypeORM') && passesInBatch(call, context.checker)) ||
    !shouldReportLoopQuery(call, context.checker, { family: owner, method: name })
  )
    return;
  const operation = `${owner}${name ? '.' + name : ''}()`;
  const combinator = promiseCombinatorOf(findRepeatOwner(call, context.checker));
  // Started together through a Promise combinator, the calls overlap instead of adding up.
  const cost = combinator
    ? `\`Promise.${combinator}\` starts them at once, so the waits overlap, but each item still costs its own round trip and pooled connection.`
    : undefined;
  context.report(
    member || access,
    'orm-query-in-loop',
    write
      ? `${operation} runs one write per item, ${cost ?? 'adding a round trip each time.'} Write the rows in one statement where the per-row values allow it (for example \`insert(rows)\`, \`save(entities)\` in chunks, or \`update({ id: In(ids) }, values)\` when every row gets the same change); keep per-row hooks, ordering and transaction.`
      : `${operation} can run one database operation per item, ${cost ?? 'adding a round trip each time.'} For independent reads, fetch all keys at once (for example ${batchReadExamples[owner] ?? '`In(ids)` or `$in`'}) and index the rows in a Map; keep per-item filters, ordering and transaction.`,
    recognisedFromSource && write && !isObjectLiteralArgument(call) ? UNKNOWN_WRITE_SHAPE_REASON : undefined,
  );
}

interface QueryShape {
  readonly propertyAccess: PropertyAccessExpression | undefined;
  readonly name: string;
  readonly owner: string | undefined;
  readonly length: MemberName | undefined;
  readonly callableTable: boolean;
  readonly rowMap: CallExpression | false | undefined;
  readonly exists: 'exists' | 'existsBy' | undefined;
  readonly repeated: boolean;
}

interface QueryExecution {
  readonly owner: string | undefined;
  readonly executes: boolean;
  readonly countMethod: string | undefined;
  readonly write: boolean;
}

function classifyKysely(shape: QueryShape, context: PerformanceRuleContext): QueryExecution {
  const { propertyAccess, name, owner, length } = shape;
  const countable =
    length &&
    name === 'execute' &&
    propertyAccess &&
    simpleBuilderSelect(ts.skipOuterExpressions(propertyAccess.expression), owner, context);
  return { owner, executes: true, countMethod: countable ? 'COUNT(*)' : undefined, write: false };
}

function classifyKnexRead(call: CallExpression, shape: QueryShape, context: PerformanceRuleContext): QueryExecution {
  const owner = 'Knex';
  const countable = shape.length && simpleBuilderSelect(call, owner, context);
  return {
    owner,
    executes: consumesLazyQuery(call, context.checker),
    countMethod: countable ? 'COUNT(*)' : undefined,
    write: false,
  };
}

function classifyTypeormRead(call: CallExpression, shape: QueryShape, context: PerformanceRuleContext): QueryExecution {
  const { propertyAccess, name, length, rowMap, exists, repeated } = shape;
  const owner = 'TypeORM';
  reportTypeormRead(call, { propertyAccess, owner, rowMap, exists, repeated }, context);
  let countMethod: string | undefined;
  if (length && name === 'find' && isWhereOnlyOptions(call)) countMethod = 'Repository.count()';
  if (length && name === 'findBy' && call.arguments.length === 1) countMethod = 'Repository.countBy()';
  return { owner, executes: true, countMethod, write: false };
}

function classifyMongoose(call: CallExpression, shape: QueryShape, context: PerformanceRuleContext): QueryExecution {
  const { propertyAccess, name, owner, length } = shape;
  let executes = owner === 'Mongoose Query' && mongoTerminals.has(name);
  if (!executes && (mongoReads.has(name) || (owner === 'Mongoose Query' && mongoModifiers.has(name)))) {
    executes = consumesLazyQuery(call, context.checker);
  }
  const countable = length && propertyAccess && countsModelFind(call, propertyAccess, owner, context.checker);
  return { owner, executes, countMethod: countable ? 'Model.countDocuments()' : undefined, write: false };
}

function classifyExecution(call: CallExpression, shape: QueryShape, context: PerformanceRuleContext): QueryExecution {
  const { propertyAccess, name, owner, length, callableTable } = shape;
  const none: QueryExecution = { owner, executes: false, countMethod: undefined, write: false };
  if (owner === 'Kysely' && kyselyExecutors.has(name)) return classifyKysely(shape, context);
  if (
    (owner === 'Knex' && knexReads.has(name)) ||
    (callableTable && context.isPackageType(call.expression, knexPackages, knexDatabases))
  )
    return classifyKnexRead(call, shape, context);
  if (
    (name === 'then' || name === 'catch' || name === 'finally') &&
    propertyAccess &&
    context.isPackageType(propertyAccess.expression, knexPackages, knexBuilders)
  ) {
    // Knex exposes these methods via Pick<Promise<T>, ...>; their symbol belongs
    // to the standard library, so verify the receiver instead.
    return { ...none, owner: 'Knex', executes: true };
  }
  if (owner === 'TypeORM' && repoReads.has(name)) return classifyTypeormRead(call, shape, context);
  if (
    ((owner === 'TypeORM' || owner === 'TypeORM EntityManager') && typeormWrites.has(name)) ||
    (owner !== undefined && typeormRawOwners.has(owner) && name === 'query' && changesRows(call))
  )
    return { ...none, executes: true, write: true };
  if ((owner === 'MikroORM' && mikroOrmReads.has(name)) || (owner === 'Payload' && payloadReads.has(name)))
    return { ...none, executes: !readsKeyList(call, owner, context.checker) };
  if (owner === 'Sequelize' && sequelizeReads.has(name)) {
    const countable = length && name === 'findAll' && isWhereOnlyOptions(call);
    return { ...none, executes: true, countMethod: countable ? 'Model.count()' : undefined };
  }
  if (owner === 'Mongoose Model' || owner === 'Mongoose Query') return classifyMongoose(call, shape, context);
  return none;
}

function checkOrmQuery(call: CallExpression, context: PerformanceRuleContext) {
  const access = call.expression;
  const propertyAccess = ts.isPropertyAccessExpression(access) ? access : undefined;
  const member = propertyAccess?.name;
  const callableTable = !member && ts.isIdentifier(access) && literalTable(call);
  if (!(member && candidateNames.has(member.text)) && !callableTable) return;
  const name = member?.text ?? '';
  const awaited = awaitedResult(call);
  const length = lengthRead(awaited);
  const exists = existenceUse(call, awaited, name);
  const rowMap = name === 'find' && awaited && isWhereOnlyOptions(call) && returnedRowMap(awaited);
  if (callableTable && !length && !consumesLazyQuery(call, context.checker)) return;
  const repeated = context.isRepeated(call);
  if (!length && !repeated && !exists && !rowMap) return;
  const { owner: resolvedOwner, recognisedFromSource } = resolveOrmOwner(access, propertyAccess, member, context);
  const { owner, executes, countMethod, write } = classifyExecution(
    call,
    { propertyAccess, name, owner: resolvedOwner, length, callableTable, rowMap, exists, repeated },
    context,
  );
  if (repeated && executes && owner)
    reportLoopQuery(call, { owner, name, write, recognisedFromSource: !!recognisedFromSource }, context);
  if (countMethod && length) {
    context.report(
      length,
      'orm-count-materialization',
      `This query loads every matching record only to read its length. Use \`${countMethod}\` with the same filter so the database counts; check that scopes and the numeric result type still match.`,
    );
  }
}

export { checkOrmQuery, declaredTypeormOwner, isTypeormPackage, typeormImportOf };
