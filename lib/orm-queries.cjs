'use strict';

const { syntax: ts, isDefaultLibrary } = require('./compiler.cjs');
const { findRepeatOwner } = require('./repeated.cjs');
const { awaitedResult, consumesLazyQuery, isDiscardedValue, outsideWrappers } = require('./query-results.cjs');
const { shouldReportLoopQuery } = require('./query-loops.cjs');
const { isSequentialByDesign } = require('./sequential-loops.cjs');
const { returnedRowMap, checkTypeormProjection } = require('./typeorm-projection.cjs');

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
// Each call is one statement; `save` of an entity array is already a batch, and the loop rules check that.
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
]);
const knexPackages = ['knex'];
const knexDatabases = ['Knex', 'Transaction'];
const knexBuilders = ['QueryBuilder'];
const simpleColumn = /^(?:[a-z_]\w*\.)?(?:[a-z_]\w*|\*)$/i;

function declaredOwner(declaration) {
  const owner = declaration.parent;
  if ((!ts.isClassDeclaration(owner) && !ts.isInterfaceDeclaration(owner)) || !owner.name) return;
  const file = declaration.getSourceFile();
  if (!file.isDeclarationFile) return;
  const segments = file.fileName.replaceAll('\\', '/').split('/node_modules/');
  if (segments.length < 2) return;
  const packagePath = segments.at(-1);
  if (packagePath.startsWith('typeorm/')) {
    if (owner.name.text === 'Repository') return 'TypeORM';
    if (owner.name.text === 'EntityManager') return 'TypeORM EntityManager';
    if (owner.name.text === 'DataSource') return 'TypeORM DataSource';
    if (owner.name.text === 'QueryRunner') return 'TypeORM QueryRunner';
  }
  if (owner.name.text === 'Model' && packagePath.startsWith('sequelize/')) return 'Sequelize';
  if (
    (owner.name.text === 'Model' || owner.name.text === 'ModelTypeScript') &&
    packagePath.startsWith('@sequelize/core/')
  )
    return 'Sequelize';
  if (packagePath.startsWith('mongoose/')) {
    if (owner.name.text === 'Model') return 'Mongoose Model';
    if (owner.name.text === 'Query') return 'Mongoose Query';
  }
  if (packagePath.startsWith('knex/') && (owner.name.text === 'QueryInterface' || owner.name.text === 'QueryBuilder'))
    return 'Knex';
  if (
    packagePath.startsWith('kysely/') &&
    (owner.name.text === 'SelectQueryBuilder' || owner.name.text === 'QueryCreator')
  )
    return 'Kysely';
}

function symbolOwner(symbol) {
  const declarations = symbol?.declarations;
  if (!declarations?.length) return;
  const owner = declaredOwner(declarations[0]);
  if (owner && declarations.every((declaration) => declaredOwner(declaration) === owner)) return owner;
}

function methodOwner(name, checker) {
  return symbolOwner(checker.getSymbolAtLocation(name));
}

const identifierCounts = new WeakMap();

function isNullish(expression) {
  const value = ts.skipOuterExpressions(expression);
  return value.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(value) && value.text === 'undefined');
}

// The value a truthiness test reads: `x`, `!x`, `!!x`, `Boolean(x)`, `x != null`, `x !== null` or `x !== undefined`.
function testedValue(expression, allowBare) {
  let value = ts.skipOuterExpressions(expression);
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

function usedOnlyInNextCondition(declaration) {
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
    counts = new Map();
    function count(node) {
      if (ts.isIdentifier(node)) counts.set(node.text, (counts.get(node.text) ?? 0) + 1);
      ts.forEachChild(node, count);
    }
    count(block);
    identifierCounts.set(block, counts);
  }
  return counts.get(condition.text) === 2 && !counts.has('eval');
}

function existenceUse(call, awaited, method) {
  if (!awaited || !['findOne', 'findOneBy'].includes(method) || call.arguments.length !== 1) return;
  // Changing the method also changes the return type. Leave explicitly asserted
  // entities and Promise<Entity> values alone, even if their final use is boolean.
  let operand = awaited.expression;
  while (ts.isParenthesizedExpression(operand)) operand = operand.expression;
  if (operand !== call) return;
  const options = ts.skipOuterExpressions(call.arguments[0]);
  if (!ts.isObjectLiteralExpression(options) || !options.properties.length) return;
  if (method === 'findOne') {
    const [property] = options.properties;
    if (
      options.properties.length !== 1 ||
      !ts.isPropertyAssignment(property) ||
      property.name.text !== 'where' ||
      !ts.isObjectLiteralExpression(ts.skipOuterExpressions(property.initializer))
    )
      return;
  }
  let value = awaited;
  while (ts.isParenthesizedExpression(value.parent)) value = value.parent;
  while (
    ts.isBinaryExpression(value.parent) &&
    [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken].includes(value.parent.operatorToken.kind)
  ) {
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

function lengthRead(awaited) {
  if (!awaited) return;
  const expression = outsideWrappers(awaited);
  const access = expression.parent;
  if (!ts.isPropertyAccessExpression(access) || access.expression !== expression || access.name.text !== 'length')
    return;
  const use = outsideWrappers(access);
  if (!ts.isAssignmentTarget(access) && !ts.isDeleteExpression(use.parent) && !isDiscardedValue(use))
    return access.name;
}

function whereOnly(call) {
  if (!call.arguments.length) return true;
  const [options] = call.arguments;
  return (
    call.arguments.length === 1 &&
    ts.isObjectLiteralExpression(options) &&
    options.properties.every(
      (property) =>
        (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) &&
        property.name.text === 'where',
    )
  );
}

function simpleMongoFilter(call) {
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
        [ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword, ts.SyntaxKind.NullKeyword].includes(
          property.initializer.kind,
        )),
  );
}

function countsModelFind(call, owner, checker) {
  // Only transparent lean()/exec() links are allowed. A limit, skip or populated
  // query can change the cardinality or add work that the caller depends on.
  while (owner === 'Mongoose Query' && ['lean', 'exec'].includes(call.expression.name.text) && !call.arguments.length) {
    const receiver = ts.skipOuterExpressions(call.expression.expression);
    if (!ts.isCallExpression(receiver) || !ts.isPropertyAccessExpression(receiver.expression)) return false;
    call = receiver;
    owner = methodOwner(call.expression.name, checker);
  }
  return owner === 'Mongoose Model' && call.expression.name.text === 'find' && simpleMongoFilter(call);
}

function literalTable(call) {
  return call.arguments.length === 1 && ts.isStringLiteralLike(call.arguments[0]);
}

function simpleBuilderSelect(call, owner, context) {
  let selected = owner === 'Knex';
  while (ts.isCallExpression(call)) {
    const access = call.expression;
    if (owner === 'Knex' && literalTable(call) && context.isPackageType(access, knexPackages, knexDatabases))
      return true;
    if (!ts.isPropertyAccessExpression(access) || methodOwner(access.name, context.checker) !== owner) return false;
    const method = access.name.text;
    if (owner === 'Kysely' && method === 'selectFrom') return selected && literalTable(call);
    if (owner === 'Knex' && (method === 'from' || method === 'table')) {
      return literalTable(call) && context.isPackageType(access.expression, knexPackages, knexDatabases);
    }
    if (
      method === 'select' &&
      call.arguments.length &&
      call.arguments.every((argument) => ts.isStringLiteralLike(argument) && simpleColumn.test(argument.text))
    )
      selected = true;
    else if (owner === 'Kysely' && method === 'selectAll' && !call.arguments.length) selected = true;
    else if (
      method !== 'where' ||
      call.arguments.length < 2 ||
      call.arguments.length > 3 ||
      !ts.isStringLiteralLike(call.arguments[0])
    )
      return false;
    call = ts.skipOuterExpressions(access.expression);
  }
  return false;
}

// `save(rows)` or `delete(ids)` already writes a whole list in one statement, typically one group per iteration.
function writesList(call, checker) {
  return call.arguments.some((argument) => {
    const symbol = checker.getTypeAtLocation(argument).getSymbol();
    return (
      (symbol?.name === 'Array' || symbol?.name === 'ReadonlyArray') &&
      !!symbol.declarations?.some((declaration) => isDefaultLibrary(checker, declaration.getSourceFile()))
    );
  });
}

// `query('UPDATE ...')`: a raw statement that changes rows, read from its literal text.
function changesRows(call) {
  const text = call.arguments[0] && ts.skipOuterExpressions(call.arguments[0]);
  if (!text) return false;
  if (ts.isStringLiteralLike(text)) return rowChangingSql.test(text.text);
  return ts.isTemplateExpression(text) && rowChangingSql.test(text.head.text);
}

function checkOrmQuery(call, context) {
  const access = call.expression;
  const member = ts.isPropertyAccessExpression(access) ? access.name : undefined;
  const callableTable = !member && ts.isIdentifier(access) && literalTable(call);
  if (!(member && candidateNames.has(member.text)) && !callableTable) return;
  const name = member?.text;
  const awaited = awaitedResult(call);
  const length = lengthRead(awaited);
  const exists = existenceUse(call, awaited, name);
  const rowMap = name === 'find' && awaited && whereOnly(call) && returnedRowMap(awaited);
  if (callableTable && !length && !consumesLazyQuery(call, context.checker)) return;
  const repeated = context.isRepeated(call);
  if (!length && !repeated && !exists && !rowMap) return;
  let owner = member && methodOwner(member, context.checker);
  let executes = false;
  let countMethod;
  let write = false;
  if (owner === 'Kysely' && kyselyExecutors.has(name)) {
    executes = true;
    if (
      length &&
      name === 'execute' &&
      simpleBuilderSelect(ts.skipOuterExpressions(access.expression), owner, context)
    ) {
      countMethod = 'COUNT(*)';
    }
  } else if (
    (owner === 'Knex' && knexReads.has(name)) ||
    (callableTable && context.isPackageType(access, knexPackages, knexDatabases))
  ) {
    owner = 'Knex';
    executes = consumesLazyQuery(call, context.checker);
    if (length && simpleBuilderSelect(call, owner, context)) countMethod = 'COUNT(*)';
  } else if (
    (name === 'then' || name === 'catch' || name === 'finally') &&
    context.isPackageType(access.expression, knexPackages, knexBuilders)
  ) {
    // Knex exposes these methods via Pick<Promise<T>, ...>; their symbol belongs
    // to the standard library, so verify the receiver instead.
    owner = 'Knex';
    executes = true;
  } else if (owner === 'TypeORM' && repoReads.has(name)) {
    executes = true;
    if (rowMap && symbolOwner(context.checker.getTypeAtLocation(access.expression).getProperty('findBy')) === owner)
      checkTypeormProjection(call, rowMap, context);
    if (
      exists &&
      !repeated &&
      symbolOwner(context.checker.getTypeAtLocation(access.expression).getProperty(exists)) === owner
    ) {
      context.report(
        member,
        'typeorm-existence-materialization',
        `This read hydrates entities only to test existence. Use \`Repository.${exists}()\` with the same filter; entity-load hooks and subscribers will not run.`,
      );
    }
    if (length && name === 'find' && whereOnly(call)) countMethod = 'Repository.count()';
    if (length && name === 'findBy' && call.arguments.length === 1) countMethod = 'Repository.countBy()';
  } else if (
    ((owner === 'TypeORM' || owner === 'TypeORM EntityManager') && typeormWrites.has(name)) ||
    (typeormRawOwners.has(owner) && name === 'query' && changesRows(call))
  ) {
    executes = true;
    write = true;
  } else if (owner === 'Sequelize' && sequelizeReads.has(name)) {
    executes = true;
    if (length && name === 'findAll' && whereOnly(call)) countMethod = 'Model.count()';
  } else if (owner === 'Mongoose Model' || owner === 'Mongoose Query') {
    executes = owner === 'Mongoose Query' && mongoTerminals.has(name);
    if (!executes && (mongoReads.has(name) || (owner === 'Mongoose Query' && mongoModifiers.has(name)))) {
      executes = consumesLazyQuery(call, context.checker);
    }
    if (length && countsModelFind(call, owner, context.checker)) countMethod = 'Model.countDocuments()';
  }
  if (
    repeated &&
    executes &&
    !(write && name !== 'query' && writesList(call, context.checker)) &&
    !isSequentialByDesign(call, findRepeatOwner(call, context.checker)) &&
    shouldReportLoopQuery(call, context.checker, { family: owner, method: name })
  ) {
    context.report(
      member || access,
      'orm-query-in-loop',
      write
        ? `${owner}.${name}() runs one write per item, adding a round trip each time. Write the rows in one statement where the per-row values allow it (for example \`insert(rows)\`, \`save(entities)\` in chunks, or \`update({ id: In(ids) }, values)\` when every row gets the same change); keep per-row hooks, ordering and transaction.`
        : `${owner}${name ? '.' + name : ''}() can run one database operation per item, adding a round trip each time. For independent reads, fetch all keys at once (for example \`In(ids)\` or \`$in\`) and index the rows in a Map; keep per-item filters, ordering and transaction.`,
    );
  }
  if (countMethod) {
    context.report(
      length,
      'orm-count-materialization',
      `This query loads every matching record only to read its length. Use \`${countMethod}\` with the same filter so the database counts; check that scopes and the numeric result type still match.`,
    );
  }
}

module.exports = { checkOrmQuery };
