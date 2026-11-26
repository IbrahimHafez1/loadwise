// orm-cartesian-include: one SQL query that joins two or more collection relations returns one row
// per combination of their items (rows = size of one collection times size of the other), so the
// response is mostly duplicated data. Prisma is not checked: it runs a separate query per relation
// unless the `relationJoins` preview is combined with
// `relationLoadStrategy: 'join'`, which is not detected. Relations are read from the entity class
// declarations (property type or relation decorator) instead of the type checker, which keeps the
// rule identical on both compiler engines.
import { ts } from './compiler.js';
import { declaredInPackage, objectProperty, resolvedSymbol, propertyName } from './schema/ts-helpers.js';
import type {
  CallExpression,
  Decorator,
  Expression,
  Node,
  PropertyDeclaration,
  SourceFile,
  TypeNode,
} from 'typescript';
import type { CheckerAdapter, PerformanceRuleContext, SymbolAdapter } from '../shared/types.js';
import type { MethodCall } from './types/method-call.js';

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

/** A relation property of an entity class: whether it holds a list, and the class it points at. */
interface Relation {
  isCollection: boolean;
  targetSymbol: SymbolAdapter | undefined;
}

/** A relation decorator such as `@OneToMany(() => Post)`. */
type CollectionDecorator = Decorator & { expression: CallExpression };

/** The nested relation names of a `relations` option, by name. */
interface RelationTree {
  [relationName: string]: RelationTree;
}

/** One entry of a Sequelize `include` array. */
interface IncludeDescription {
  model?: Expression;
  association?: string;
  separate?: boolean;
  nested?: Expression;
}

const isMethodCall = (call: CallExpression): call is MethodCall => ts.isPropertyAccessExpression(call.expression);

function typeormMessage(): string {
  return `This query joins two collection relations in one SQL statement, so it returns one row per combination of their items and the result grows as the product of the two sizes. ${FIX_HINT} (set \`relationLoadStrategy: 'query'\` or run a separate query).`;
}

function sequelizeMessage(): string {
  return `This query includes two collection associations in one SQL statement, so it returns one row per combination of their items and the result grows as the product of the two sizes. ${FIX_HINT} (add \`separate: true\` to the include).`;
}

function stringLiteralValue(node: Node | undefined): string | undefined {
  const value = node && ts.skipOuterExpressions(node);
  return value && ts.isStringLiteralLike(value) ? value.text : undefined;
}

function classSymbolIn(symbol: SymbolAdapter | undefined): SymbolAdapter | undefined {
  return symbol && symbol.flags & ts.SymbolFlags.Class ? symbol : undefined;
}

// The class named by an expression such as `User`.
function classSymbolOf(expression: Expression, checker: CheckerAdapter): SymbolAdapter | undefined {
  return classSymbolIn(resolvedSymbol(ts.skipOuterExpressions(expression), checker));
}

function classSymbolOfTypeNode(typeNode: TypeNode, checker: CheckerAdapter): SymbolAdapter | undefined {
  return classSymbolIn(checker.getTypeAtLocation(typeNode)?.getSymbol());
}

function isNullishType(typeNode: TypeNode): boolean {
  return (
    typeNode.kind === ts.SyntaxKind.UndefinedKeyword ||
    (ts.isLiteralTypeNode(typeNode) && typeNode.literal.kind === ts.SyntaxKind.NullKeyword)
  );
}

// `Post | null` -> `Post`.
function withoutNullish(typeNode: TypeNode): TypeNode | undefined {
  if (!ts.isUnionTypeNode(typeNode)) return typeNode;
  const members = typeNode.types.filter((member) => !isNullishType(member));
  return members.length === 1 ? members[0] : undefined;
}

// `Post[]` or `Array<Post>` -> the element type node; undefined for anything else.
function listElementType(typeNode: TypeNode): TypeNode | undefined {
  if (ts.isArrayTypeNode(typeNode)) return typeNode.elementType;
  const isArrayReference =
    ts.isTypeReferenceNode(typeNode) &&
    ts.isIdentifier(typeNode.typeName) &&
    ARRAY_TYPE_NAMES.has(typeNode.typeName.text);
  return isArrayReference ? typeNode.typeArguments?.[0] : undefined;
}

function collectionDecorator(member: PropertyDeclaration): CollectionDecorator | undefined {
  return member.modifiers?.find(
    (modifier): modifier is CollectionDecorator =>
      ts.isDecorator(modifier) &&
      ts.isCallExpression(modifier.expression) &&
      ts.isIdentifier(modifier.expression.expression) &&
      COLLECTION_DECORATORS.has(modifier.expression.expression.text),
  );
}

// `@OneToMany(() => Post, ...)` -> the Post class.
function decoratorTarget(
  decorator: CollectionDecorator | undefined,
  checker: CheckerAdapter,
): SymbolAdapter | undefined {
  const factory = decorator?.expression.arguments[0] && ts.skipOuterExpressions(decorator.expression.arguments[0]);
  const body = factory && ts.isArrowFunction(factory) ? factory.body : undefined;
  return body && !ts.isBlock(body) ? classSymbolOf(body, checker) : undefined;
}

function classProperties(classSymbol: SymbolAdapter | undefined): PropertyDeclaration[] {
  return (classSymbol?.declarations ?? [])
    .filter(ts.isClassLike)
    .flatMap((declaration) => declaration.members.filter(ts.isPropertyDeclaration));
}

// `{ isCollection, targetSymbol }` for a relation property of an entity class, or undefined when
// the property is neither a list of entities nor a decorated collection relation.
function relationOf(member: PropertyDeclaration, checker: CheckerAdapter): Relation | undefined {
  const typeNode = member.type && withoutNullish(member.type);
  const elementType = typeNode && listElementType(typeNode);
  const decorator = collectionDecorator(member);
  const targetNode = elementType ?? typeNode;
  const targetSymbol =
    (targetNode && classSymbolOfTypeNode(targetNode, checker)) || decoratorTarget(decorator, checker);
  if (!targetSymbol && !decorator) return;
  return { isCollection: !!elementType || !!decorator, targetSymbol };
}

function relationTarget(
  classSymbol: SymbolAdapter | undefined,
  name: string,
  checker: CheckerAdapter,
): Relation | undefined {
  const member = classProperties(classSymbol).find((candidate) => propertyName(candidate) === name);
  return member && relationOf(member, checker);
}

// --- TypeORM query builder
// -------------------------------------------------------------------------------------

// Calls of a builder chain from the first call to `call`.
function chainCalls(call: CallExpression): CallExpression[] {
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
function repositoryEntity(expression: Expression, checker: CheckerAdapter): SymbolAdapter | undefined {
  const symbol = resolvedSymbol(ts.skipOuterExpressions(expression), checker);
  for (const declaration of symbol?.declarations ?? []) {
    if (
      !ts.isVariableDeclaration(declaration) &&
      !ts.isPropertyDeclaration(declaration) &&
      !ts.isParameter(declaration) &&
      !ts.isPropertySignature(declaration)
    )
      continue;
    const typeArgument =
      declaration.type && ts.isTypeReferenceNode(declaration.type) && declaration.type.typeArguments?.[0];
    if (typeArgument) return classSymbolOfTypeNode(typeArgument, checker);
    const declaredInitializer = ts.isPropertySignature(declaration) ? undefined : declaration.initializer;
    const initializer = declaredInitializer && ts.skipOuterExpressions(declaredInitializer);
    const isGetRepository =
      initializer &&
      ts.isCallExpression(initializer) &&
      ts.isPropertyAccessExpression(initializer.expression) &&
      initializer.expression.name.text === 'getRepository';
    if (isGetRepository && initializer.arguments[0]) return classSymbolOf(initializer.arguments[0], checker);
  }
}

function rootAlias(
  call: MethodCall,
  context: PerformanceRuleContext,
): { alias: string; entityClass: SymbolAdapter } | undefined {
  const alias = stringLiteralValue(call.arguments[call.arguments.length - 1]);
  if (!alias) return;
  const entityArgument = call.arguments.find((argument: Expression) => stringLiteralValue(argument) === undefined);
  const entityClass = entityArgument
    ? classSymbolOf(entityArgument, context.checker)
    : repositoryEntity(call.expression.expression, context.checker);
  return entityClass && { alias, entityClass };
}

// The collection joins selected by a query builder chain, in order, with the aliases of every join
// resolved.
function selectedCollectionJoins(chain: readonly CallExpression[], context: PerformanceRuleContext): CallExpression[] {
  const aliases = new Map<string, SymbolAdapter | undefined>();
  const collections: CallExpression[] = [];
  for (const call of chain) {
    if (!isMethodCall(call)) continue;
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

function checkQueryBuilderJoin(call: MethodCall, context: PerformanceRuleContext): void {
  if (!declaredInPackage(call.expression, context.checker, TYPEORM)) return;
  const collections = selectedCollectionJoins(chainCalls(call), context);
  if (collections.length !== MIN_COLLECTIONS || collections[collections.length - 1] !== call) return;
  context.report(call.expression.name, RULE_ID, typeormMessage());
}

// --- TypeORM find({ relations })
// -------------------------------------------------------------------------------

function addPath(tree: RelationTree, path: string): void {
  let level = tree;
  for (const segment of path.split('.')) level = level[segment] ??= {};
}

function relationTree(value: Expression | undefined): RelationTree {
  const tree: RelationTree = {};
  const node = value && ts.skipOuterExpressions(value);
  if (!node) return tree;
  if (ts.isArrayLiteralExpression(node)) {
    for (const element of node.elements) {
      const path = stringLiteralValue(element);
      if (path) addPath(tree, path);
    }
  } else if (ts.isObjectLiteralExpression(node)) {
    for (const property of node.properties) {
      if (!ts.isPropertyAssignment(property)) continue;
      const name = propertyName(property);
      if (name) tree[name] = relationTree(property.initializer);
    }
  }
  return tree;
}

function countCollections(entityClass: SymbolAdapter | undefined, tree: RelationTree, checker: CheckerAdapter): number {
  let count = 0;
  for (const [name, subtree] of Object.entries(tree)) {
    const target = relationTarget(entityClass, name, checker);
    if (!target) continue;
    count += (target.isCollection ? 1 : 0) + countCollections(target.targetSymbol, subtree, checker);
  }
  return count;
}

function findEntityAndOptions(
  call: MethodCall,
  checker: CheckerAdapter,
): { entityClass: SymbolAdapter | undefined; options: Expression | undefined } {
  const entityClass = repositoryEntity(call.expression.expression, checker);
  if (entityClass) return { entityClass, options: call.arguments[0] };
  const [entity, options] = call.arguments;
  return { entityClass: entity && classSymbolOf(entity, checker), options };
}

function hasSiblingCollections(
  entityClass: SymbolAdapter | undefined,
  tree: RelationTree,
  checker: CheckerAdapter,
): boolean {
  let branchesWithCollections = 0;
  for (const [name, subtree] of Object.entries(tree)) {
    const target = relationTarget(entityClass, name, checker);
    if (!target) continue;
    if (hasSiblingCollections(target.targetSymbol, subtree, checker)) return true;
    if (target.isCollection || countCollections(target.targetSymbol, subtree, checker) > 0) {
      branchesWithCollections++;
      if (branchesWithCollections >= MIN_COLLECTIONS) return true;
    }
  }
  return false;
}

function checkFindRelations(call: MethodCall, context: PerformanceRuleContext): void {
  if (!declaredInPackage(call.expression, context.checker, TYPEORM)) return;
  const { entityClass, options } = findEntityAndOptions(call, context.checker);
  const literal = options && ts.skipOuterExpressions(options);
  if (!entityClass || !literal || !ts.isObjectLiteralExpression(literal)) return;
  if (stringLiteralValue(objectProperty(literal, 'relationLoadStrategy')) === 'query') return;
  const tree = relationTree(objectProperty(literal, 'relations'));
  if (countCollections(entityClass, tree, context.checker) < MIN_COLLECTIONS) return;
  const method = call.expression.name.text;
  const nestedOnlyOnSingle =
    (method === 'findOne' || method === 'findOneOrFail') && !hasSiblingCollections(entityClass, tree, context.checker);
  context.report(
    call.expression.name,
    RULE_ID,
    typeormMessage(),
    nestedOnlyOnSingle
      ? 'Loads a single nested relation chain on one parent row rather than two sibling collections; verify the child lists stay small.'
      : undefined,
  );
}

// --- Sequelize include
// -----------------------------------------------------------------------------------------

function includeEntries(includeValue: Expression | undefined): readonly Expression[] {
  const value = includeValue && ts.skipOuterExpressions(includeValue);
  if (!value) return [];
  return ts.isArrayLiteralExpression(value) ? value.elements : [value];
}

function isTrue(node: Node | undefined): boolean {
  return !!node && ts.skipOuterExpressions(node).kind === ts.SyntaxKind.TrueKeyword;
}

// `Author.hasMany(Post)` written in the same file as the query.
function hasAssociationCall(
  sourceFile: SourceFile,
  parentClass: SymbolAdapter,
  modelClass: SymbolAdapter,
  checker: CheckerAdapter,
): boolean {
  let found = false;
  (function visit(node: Node): void {
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

// True when the parent model has the named property, or every property pointing at the model, typed
// as a list.
function isCollectionAssociation(
  parentExpression: Expression,
  modelExpression: Expression | undefined,
  associationName: string | undefined,
  checker: CheckerAdapter,
): boolean {
  const parentClass = classSymbolOf(parentExpression, checker);
  if (!parentClass) return false;
  if (associationName) return !!relationTarget(parentClass, associationName, checker)?.isCollection;
  const modelClass = modelExpression && classSymbolOf(modelExpression, checker);
  if (!modelClass) return false;
  const relations = classProperties(parentClass)
    .map((member) => relationOf(member, checker))
    .filter((relation): relation is Relation => relation?.targetSymbol === modelClass);
  if (relations.length > 0) return relations.every((relation) => relation.isCollection);
  return hasAssociationCall(parentExpression.getSourceFile(), parentClass, modelClass, checker);
}

function includeDescription(entry: Expression): IncludeDescription | undefined {
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

function countIncludedCollections(
  parentExpression: Expression,
  includeValue: Expression | undefined,
  checker: CheckerAdapter,
): number {
  let count = 0;
  for (const entry of includeEntries(includeValue)) {
    const description = includeDescription(entry);
    if (!description || description.separate) continue;
    if (isCollectionAssociation(parentExpression, description.model, description.association, checker)) count += 1;
    if (description.model) count += countIncludedCollections(description.model, description.nested, checker);
  }
  return count;
}

function checkSequelizeInclude(call: MethodCall, context: PerformanceRuleContext): void {
  const optionsIndex = SEQUELIZE_FIND_METHODS.get(call.expression.name.text);
  const optionsArgument = optionsIndex === undefined ? undefined : call.arguments[optionsIndex];
  const options = optionsArgument && ts.skipOuterExpressions(optionsArgument);
  if (!options || !ts.isObjectLiteralExpression(options)) return;
  if (!declaredInPackage(call.expression, context.checker, SEQUELIZE)) return;
  const include = objectProperty(options, 'include');
  if (!include) return;
  if (countIncludedCollections(call.expression.expression, include, context.checker) < MIN_COLLECTIONS) return;
  context.report(call.expression.name, RULE_ID, sequelizeMessage());
}

function check(call: CallExpression, context: PerformanceRuleContext): void {
  if (!isMethodCall(call)) return;
  const method = call.expression.name.text;
  if (TYPEORM_COUNTED_JOINS.has(method)) return checkQueryBuilderJoin(call, context);
  if (SEQUELIZE_FIND_METHODS.has(method)) checkSequelizeInclude(call, context);
  if (TYPEORM_FIND_METHODS.has(method)) checkFindRelations(call, context);
}

export { check };
