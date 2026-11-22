'use strict';

// orm-cartesian-include: one SQL query that joins two or more collection relations returns one row per combination
// of their items (rows = size of one collection times size of the other), so the response is mostly duplicated data.
// Prisma is not checked: it runs a separate query per relation unless the `relationJoins` preview is combined with
// `relationLoadStrategy: 'join'`, which is not detected.
// Relations are read from the entity class declarations (property type or relation decorator) instead of the type
// checker, which keeps the rule identical on both compiler engines.
const { syntax: ts } = require('./compiler.cjs');
const { declaredInPackage, objectProperty, resolvedSymbol, propertyName } = require('./schema/ts-helpers.cjs');

const RULE_ID = 'orm-cartesian-include';
const MIN_COLLECTIONS = 2;
const TYPEORM = ['typeorm'];
const SEQUELIZE = ['sequelize', 'sequelize-typescript'];
const TYPEORM_COUNTED_JOINS = new Set(['leftJoinAndSelect', 'innerJoinAndSelect']);
const TYPEORM_ALIAS_JOINS = new Set(['leftJoin', 'innerJoin']);
const TYPEORM_ROOTS = new Set(['createQueryBuilder', 'from']);
const TYPEORM_FIND_METHODS = new Set(['find', 'findOne', 'findOneOrFail', 'findAndCount']);
const SEQUELIZE_FIND_METHODS = new Map([
  ['findAll', 0],
  ['findOne', 0],
  ['findAndCountAll', 0],
  ['findByPk', 1],
]);
const SEQUELIZE_COLLECTION_ASSOCIATIONS = new Set(['hasMany', 'belongsToMany']);
const ARRAY_TYPE_NAMES = new Set(['Array', 'ReadonlyArray']);
const COLLECTION_DECORATORS = new Set(['OneToMany', 'ManyToMany', 'HasMany', 'BelongsToMany']);

const FIX_HINT = 'Load the second collection in its own query';

function typeormMessage() {
  return `This query joins two collection relations in one SQL statement, so it returns one row per combination of their items and the result grows as the product of the two sizes. ${FIX_HINT} (set \`relationLoadStrategy: 'query'\` or run a separate query).`;
}

function sequelizeMessage() {
  return `This query includes two collection associations in one SQL statement, so it returns one row per combination of their items and the result grows as the product of the two sizes. ${FIX_HINT} (add \`separate: true\` to the include).`;
}

function stringLiteralValue(node) {
  const value = node && ts.skipOuterExpressions(node);
  return value && ts.isStringLiteralLike(value) ? value.text : undefined;
}

function classSymbolIn(symbol) {
  return symbol && symbol.flags & ts.SymbolFlags.Class ? symbol : undefined;
}

// The class named by an expression such as `User`.
function classSymbolOf(expression, checker) {
  return classSymbolIn(resolvedSymbol(ts.skipOuterExpressions(expression), checker));
}

function classSymbolOfTypeNode(typeNode, checker) {
  return classSymbolIn(checker.getTypeAtLocation(typeNode)?.getSymbol());
}

function isNullishType(typeNode) {
  return (
    typeNode.kind === ts.SyntaxKind.UndefinedKeyword ||
    (ts.isLiteralTypeNode(typeNode) && typeNode.literal.kind === ts.SyntaxKind.NullKeyword)
  );
}

// `Post | null` -> `Post`.
function withoutNullish(typeNode) {
  if (!ts.isUnionTypeNode(typeNode)) return typeNode;
  const members = typeNode.types.filter((member) => !isNullishType(member));
  return members.length === 1 ? members[0] : undefined;
}

// `Post[]` or `Array<Post>` -> the element type node; undefined for anything else.
function listElementType(typeNode) {
  if (ts.isArrayTypeNode(typeNode)) return typeNode.elementType;
  const isArrayReference =
    ts.isTypeReferenceNode(typeNode) &&
    ts.isIdentifier(typeNode.typeName) &&
    ARRAY_TYPE_NAMES.has(typeNode.typeName.text);
  return isArrayReference ? typeNode.typeArguments?.[0] : undefined;
}

function collectionDecorator(member) {
  return member.modifiers?.find(
    (modifier) =>
      ts.isDecorator(modifier) &&
      ts.isCallExpression(modifier.expression) &&
      ts.isIdentifier(modifier.expression.expression) &&
      COLLECTION_DECORATORS.has(modifier.expression.expression.text),
  );
}

// `@OneToMany(() => Post, ...)` -> the Post class.
function decoratorTarget(decorator, checker) {
  const factory = decorator?.expression.arguments[0] && ts.skipOuterExpressions(decorator.expression.arguments[0]);
  const body = factory && ts.isArrowFunction(factory) ? factory.body : undefined;
  return body && !ts.isBlock(body) ? classSymbolOf(body, checker) : undefined;
}

function classProperties(classSymbol) {
  return (classSymbol?.declarations ?? [])
    .filter((declaration) => ts.isClassLike(declaration))
    .flatMap((declaration) => declaration.members.filter((member) => ts.isPropertyDeclaration(member)));
}

// `{ isCollection, targetSymbol }` for a relation property of an entity class, or undefined when the property is
// neither a list of entities nor a decorated collection relation.
function relationOf(member, checker) {
  const typeNode = member.type && withoutNullish(member.type);
  const elementType = typeNode && listElementType(typeNode);
  const decorator = collectionDecorator(member);
  const targetNode = elementType ?? typeNode;
  const targetSymbol =
    (targetNode && classSymbolOfTypeNode(targetNode, checker)) || decoratorTarget(decorator, checker);
  if (!targetSymbol && !decorator) return;
  return { isCollection: !!elementType || !!decorator, targetSymbol };
}

function relationTarget(classSymbol, name, checker) {
  const member = classProperties(classSymbol).find((candidate) => propertyName(candidate) === name);
  return member && relationOf(member, checker);
}

// --- TypeORM query builder -------------------------------------------------------------------------------------

// Calls of a builder chain from the first call to `call`.
function chainCalls(call) {
  const calls = [call];
  let receiver = ts.skipOuterExpressions(call.expression);
  while (ts.isPropertyAccessExpression(receiver)) {
    const inner = ts.skipOuterExpressions(receiver.expression);
    if (ts.isCallExpression(inner)) calls.unshift(inner);
    receiver = ts.isCallExpression(inner) ? ts.skipOuterExpressions(inner.expression) : inner;
  }
  return calls;
}

// The entity class of `Repository<User>` typed declarations and `getRepository(User)` initializers.
function repositoryEntity(expression, checker) {
  const symbol = resolvedSymbol(ts.skipOuterExpressions(expression), checker);
  for (const declaration of symbol?.declarations ?? []) {
    const typeArgument =
      declaration.type && ts.isTypeReferenceNode(declaration.type) && declaration.type.typeArguments?.[0];
    if (typeArgument) return classSymbolOfTypeNode(typeArgument, checker);
    const initializer = declaration.initializer && ts.skipOuterExpressions(declaration.initializer);
    const isGetRepository =
      initializer &&
      ts.isCallExpression(initializer) &&
      ts.isPropertyAccessExpression(initializer.expression) &&
      initializer.expression.name.text === 'getRepository';
    if (isGetRepository && initializer.arguments[0]) return classSymbolOf(initializer.arguments[0], checker);
  }
}

function rootAlias(call, context) {
  const alias = stringLiteralValue(call.arguments[call.arguments.length - 1]);
  if (!alias) return;
  const entityArgument = call.arguments.find((argument) => stringLiteralValue(argument) === undefined);
  const entityClass = entityArgument
    ? classSymbolOf(entityArgument, context.checker)
    : repositoryEntity(call.expression.expression, context.checker);
  return entityClass && { alias, entityClass };
}

// The collection joins selected by a query builder chain, in order, with the aliases of every join resolved.
function selectedCollectionJoins(chain, context) {
  const aliases = new Map();
  const collections = [];
  for (const call of chain) {
    if (!ts.isPropertyAccessExpression(call.expression)) continue;
    const method = call.expression.name.text;
    if (TYPEORM_ROOTS.has(method)) {
      const root = rootAlias(call, context);
      if (root) aliases.set(root.alias, root.entityClass);
      continue;
    }
    const isCounted = TYPEORM_COUNTED_JOINS.has(method);
    if (!isCounted && !TYPEORM_ALIAS_JOINS.has(method)) continue;
    const [parentAlias, propertyKey] = (stringLiteralValue(call.arguments[0]) ?? '').split('.');
    const joinAlias = stringLiteralValue(call.arguments[1]);
    const target = propertyKey && relationTarget(aliases.get(parentAlias), propertyKey, context.checker);
    if (!target) continue;
    if (joinAlias) aliases.set(joinAlias, target.targetSymbol);
    if (isCounted && target.isCollection) collections.push(call);
  }
  return collections;
}

function checkQueryBuilderJoin(call, context) {
  if (!declaredInPackage(call.expression, context.checker, TYPEORM)) return;
  const collections = selectedCollectionJoins(chainCalls(call), context);
  if (collections.length !== MIN_COLLECTIONS || collections[collections.length - 1] !== call) return;
  context.report(call.expression.name, RULE_ID, typeormMessage());
}

// --- TypeORM find({ relations }) -------------------------------------------------------------------------------

function addPath(tree, path) {
  let level = tree;
  for (const segment of path.split('.')) level = level[segment] ??= {};
}

function relationTree(value) {
  const tree = {};
  const node = value && ts.skipOuterExpressions(value);
  if (!node) return tree;
  if (ts.isArrayLiteralExpression(node)) {
    for (const element of node.elements) {
      const path = stringLiteralValue(element);
      if (path) addPath(tree, path);
    }
  } else if (ts.isObjectLiteralExpression(node)) {
    for (const property of node.properties) {
      const name = ts.isPropertyAssignment(property) && propertyName(property);
      if (name) tree[name] = relationTree(property.initializer);
    }
  }
  return tree;
}

function countCollections(entityClass, tree, checker) {
  let count = 0;
  for (const [name, subtree] of Object.entries(tree)) {
    const target = relationTarget(entityClass, name, checker);
    if (!target) continue;
    count += (target.isCollection ? 1 : 0) + countCollections(target.targetSymbol, subtree, checker);
  }
  return count;
}

function findEntityAndOptions(call, checker) {
  const entityClass = repositoryEntity(call.expression.expression, checker);
  if (entityClass) return { entityClass, options: call.arguments[0] };
  const [entity, options] = call.arguments;
  return { entityClass: entity && classSymbolOf(entity, checker), options };
}

function checkFindRelations(call, context) {
  if (!declaredInPackage(call.expression, context.checker, TYPEORM)) return;
  const { entityClass, options } = findEntityAndOptions(call, context.checker);
  const literal = options && ts.skipOuterExpressions(options);
  if (!entityClass || !literal || !ts.isObjectLiteralExpression(literal)) return;
  if (stringLiteralValue(objectProperty(literal, 'relationLoadStrategy')) === 'query') return;
  const tree = relationTree(objectProperty(literal, 'relations'));
  if (countCollections(entityClass, tree, context.checker) < MIN_COLLECTIONS) return;
  context.report(call.expression.name, RULE_ID, typeormMessage());
}

// --- Sequelize include -----------------------------------------------------------------------------------------

function includeEntries(includeValue) {
  const value = includeValue && ts.skipOuterExpressions(includeValue);
  if (!value) return [];
  return ts.isArrayLiteralExpression(value) ? value.elements : [value];
}

function isTrue(node) {
  return !!node && ts.skipOuterExpressions(node).kind === ts.SyntaxKind.TrueKeyword;
}

// `Author.hasMany(Post)` written in the same file as the query.
function hasAssociationCall(sourceFile, parentClass, modelClass, checker) {
  let found = false;
  (function visit(node) {
    if (found) return;
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const isCollectionAssociation = SEQUELIZE_COLLECTION_ASSOCIATIONS.has(node.expression.name.text);
      const isSameParent = resolvedSymbol(node.expression.expression, checker) === parentClass;
      const isSameModel = node.arguments[0] && resolvedSymbol(node.arguments[0], checker) === modelClass;
      found = isCollectionAssociation && isSameParent && isSameModel;
    }
    ts.forEachChild(node, visit);
  })(sourceFile);
  return found;
}

// True when the parent model has the named property, or every property pointing at the model, typed as a list.
function isCollectionAssociation(parentExpression, modelExpression, associationName, checker) {
  const parentClass = classSymbolOf(parentExpression, checker);
  if (!parentClass) return false;
  if (associationName) return !!relationTarget(parentClass, associationName, checker)?.isCollection;
  const modelClass = modelExpression && classSymbolOf(modelExpression, checker);
  if (!modelClass) return false;
  const relations = classProperties(parentClass)
    .map((member) => relationOf(member, checker))
    .filter((relation) => relation?.targetSymbol === modelClass);
  if (relations.length > 0) return relations.every((relation) => relation.isCollection);
  return hasAssociationCall(parentExpression.getSourceFile(), parentClass, modelClass, checker);
}

function includeDescription(entry) {
  const value = ts.skipOuterExpressions(entry);
  if (ts.isIdentifier(value) || ts.isPropertyAccessExpression(value)) return { model: value };
  if (!ts.isObjectLiteralExpression(value)) return;
  return {
    model: objectProperty(value, 'model'),
    association: stringLiteralValue(objectProperty(value, 'association') ?? objectProperty(value, 'as')),
    separate: isTrue(objectProperty(value, 'separate')),
    nested: objectProperty(value, 'include'),
  };
}

function countIncludedCollections(parentExpression, includeValue, checker) {
  let count = 0;
  for (const entry of includeEntries(includeValue)) {
    const description = includeDescription(entry);
    if (!description || description.separate) continue;
    if (isCollectionAssociation(parentExpression, description.model, description.association, checker)) count += 1;
    if (description.model) count += countIncludedCollections(description.model, description.nested, checker);
  }
  return count;
}

function checkSequelizeInclude(call, context) {
  const optionsIndex = SEQUELIZE_FIND_METHODS.get(call.expression.name.text);
  const options = call.arguments[optionsIndex] && ts.skipOuterExpressions(call.arguments[optionsIndex]);
  if (!options || !ts.isObjectLiteralExpression(options)) return;
  if (!declaredInPackage(call.expression, context.checker, SEQUELIZE)) return;
  const include = objectProperty(options, 'include');
  if (!include) return;
  if (countIncludedCollections(call.expression.expression, include, context.checker) < MIN_COLLECTIONS) return;
  context.report(call.expression.name, RULE_ID, sequelizeMessage());
}

function check(call, context) {
  if (!ts.isPropertyAccessExpression(call.expression)) return;
  const method = call.expression.name.text;
  if (TYPEORM_COUNTED_JOINS.has(method)) return checkQueryBuilderJoin(call, context);
  if (SEQUELIZE_FIND_METHODS.has(method)) checkSequelizeInclude(call, context);
  if (TYPEORM_FIND_METHODS.has(method)) checkFindRelations(call, context);
}

module.exports = { check };
