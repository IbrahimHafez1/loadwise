import { loadSyntax } from '../compiler.cjs';
import { declaredTypeOf, resolvedSymbol, decoratorsOf, decoratorCall } from '../schema/ts-helpers.cjs';
import type {
  CallExpression,
  ClassLikeDeclaration,
  Expression,
  Node,
  ParameterDeclaration,
  PropertyAccessExpression,
  TypeNode,
} from 'typescript';
import type { CheckerAdapter } from '../../shared/types.cjs';
import type { DecoratorCall } from '../types/decorator-call.cjs';
import type { ModelFallback, ModelFamily } from '../types/model-fallback.cjs';
const ts = loadSyntax();

interface ImportReference {
  module: string;
  name: string | undefined;
}

interface NestInjection {
  module: string;
  family: ModelFamily;
}

// Without an installed package every ORM call resolves to nothing. These readers recognise a
// receiver from the project's own model declarations and the package its imports name, so they only
// ever rate a call as "probably this ORM" (reduced precision, like the schema.prisma fallback in
// prisma.cjs).
const FAMILY_MODULES: Record<ModelFamily, (module: string) => boolean> = {
  typeorm: (module) => module !== '@nestjs/typeorm' && /^(?:@[^/]+\/)?typeorm$/.test(module),
  mongoose: (module) => module === 'mongoose',
  sequelize: (module) => ['sequelize', 'sequelize-typescript', '@sequelize/core'].includes(module),
  drizzle: (module) => module === 'drizzle-orm' || module.startsWith('drizzle-orm/'),
};
const FAMILY_PACKAGES: Record<ModelFamily, readonly string[]> = {
  typeorm: ['typeorm', '@n8n/typeorm'],
  mongoose: ['mongoose'],
  sequelize: ['sequelize', 'sequelize-typescript', '@sequelize/core'],
  drizzle: ['drizzle-orm'],
};
const NEST_INJECTION: Record<string, NestInjection> = {
  InjectRepository: { module: '@nestjs/typeorm', family: 'typeorm' },
  InjectModel: { module: '@nestjs/mongoose', family: 'mongoose' },
};
const DRIZZLE_TABLE_FUNCTIONS = new Set(['pgTable', 'mysqlTable', 'sqliteTable', 'singlestoreTable']);
const DRIZZLE_TABLE_ARGUMENT_METHODS = new Set(['from', 'insert', 'update', 'delete']);
const SEQUELIZE_BASE_NAMES = new Set(['Model']);
const TYPEORM_BASE_NAMES = new Set(['BaseEntity']);
const MAX_HERITAGE_DEPTH = 4;
const MAX_ALIAS_HOPS = 4;

// The `x` in `require('x')`, or undefined for any other expression.
function requiredModule(expression: Expression | undefined): Expression | undefined {
  if (!expression || !ts.isCallExpression(expression) || expression.arguments.length !== 1) return;
  if (!ts.isIdentifier(expression.expression) || expression.expression.text !== 'require') return;
  return expression.arguments[0];
}

function moduleOfDeclaration(declaration: Node): Expression | undefined {
  if (ts.isImportSpecifier(declaration)) return declaration.parent.parent.parent.moduleSpecifier;
  if (ts.isNamespaceImport(declaration)) return declaration.parent.parent.moduleSpecifier;
  if (ts.isImportClause(declaration)) return declaration.parent.moduleSpecifier;
  if (ts.isVariableDeclaration(declaration)) return requiredModule(declaration.initializer);
  if (ts.isBindingElement(declaration) && ts.isObjectBindingPattern(declaration.parent))
    return requiredModule(declaration.parent.parent.initializer);
}

// The name an import or a destructured `require` takes from its module; `default` for the whole
// module.
function importedName(declaration: Node): string | undefined {
  if (ts.isImportSpecifier(declaration) || ts.isBindingElement(declaration))
    return textOfName(declaration.propertyName ?? declaration.name);
  return 'default';
}

function textOfName(name: Node): string | undefined {
  return ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name) ? name.text : undefined;
}

function importOf(identifier: Node | undefined, checker: CheckerAdapter): ImportReference | undefined {
  if (!identifier || !ts.isIdentifier(identifier)) return;
  const declaration = checker.getSymbolAtLocation(identifier)?.declarations?.[0];
  if (!declaration) return;
  const specifier = moduleOfDeclaration(declaration);
  if (!specifier || !ts.isStringLiteral(specifier)) return;
  return { module: specifier.text, name: importedName(declaration) };
}

function importedFrom(
  identifier: Node | undefined,
  family: ModelFamily,
  checker: CheckerAdapter,
  names?: ReadonlySet<string>,
): boolean {
  const imported = importOf(identifier, checker);
  return (
    !!imported &&
    FAMILY_MODULES[family](imported.module) &&
    (!names || (imported.name !== undefined && names.has(imported.name)))
  );
}

// `mongoose.model`: the member name when the object is an import of the family (namespace or
// default).
function namespaceMember(callee: Node, family: ModelFamily, checker: CheckerAdapter): string | undefined {
  return ts.isPropertyAccessExpression(callee) && importedFrom(callee.expression, family, checker)
    ? callee.name.text
    : undefined;
}

function calleeIsFromFamily(callee: Node, family: ModelFamily, name: string, checker: CheckerAdapter): boolean {
  if (ts.isIdentifier(callee)) return importedFrom(callee, family, checker, new Set([name]));
  return namespaceMember(callee, family, checker) === name;
}

function projectDeclaration(node: Node, checker: CheckerAdapter): Node | undefined {
  const symbol = resolvedSymbol(node, checker);
  return symbol?.valueDeclaration ?? symbol?.declarations?.[0];
}

function hasDecorator(declaration: Node, family: ModelFamily, name: string, checker: CheckerAdapter): boolean {
  return decoratorsOf(declaration)
    .map(decoratorCall)
    .some(
      (decorator: DecoratorCall | undefined) =>
        decorator && importedFrom(decorator.callee, family, checker, new Set([name])),
    );
}

function extendedExpression(declaration: ClassLikeDeclaration): Expression | undefined {
  return declaration.heritageClauses?.find((clause) => clause.token === ts.SyntaxKind.ExtendsKeyword)?.types[0]
    ?.expression;
}

function extendsFamilyBase(
  declaration: ClassLikeDeclaration,
  family: ModelFamily,
  baseNames: ReadonlySet<string>,
  checker: CheckerAdapter,
  depth = 0,
): boolean {
  const base = depth <= MAX_HERITAGE_DEPTH && extendedExpression(declaration);
  if (!base || !ts.isIdentifier(base)) return false;
  if (importedFrom(base, family, checker, baseNames)) return true;
  const baseDeclaration = projectDeclaration(base, checker);
  return (
    !!baseDeclaration &&
    ts.isClassDeclaration(baseDeclaration) &&
    extendsFamilyBase(baseDeclaration, family, baseNames, checker, depth + 1)
  );
}

function isTypeormEntity(declaration: Node, checker: CheckerAdapter): boolean {
  return ts.isClassDeclaration(declaration) && hasDecorator(declaration, 'typeorm', 'Entity', checker);
}

function entityNamed(identifier: Node | undefined, checker: CheckerAdapter): boolean {
  const declaration = identifier && ts.isIdentifier(identifier) && projectDeclaration(identifier, checker);
  return !!declaration && isTypeormEntity(declaration, checker);
}

// A class that is a Sequelize model by `extends Model` or by sequelize-typescript's `@Table`.
function isSequelizeModelClass(declaration: Node, checker: CheckerAdapter): boolean {
  return (
    ts.isClassDeclaration(declaration) &&
    (hasDecorator(declaration, 'sequelize', 'Table', checker) ||
      extendsFamilyBase(declaration, 'sequelize', SEQUELIZE_BASE_NAMES, checker))
  );
}

function isActiveRecordEntity(declaration: Node, checker: CheckerAdapter): boolean {
  return (
    ts.isClassDeclaration(declaration) &&
    isTypeormEntity(declaration, checker) &&
    extendsFamilyBase(declaration, 'typeorm', TYPEORM_BASE_NAMES, checker)
  );
}

function typeReferenceFamily(typeNode: TypeNode | undefined, checker: CheckerAdapter): ModelFamily | undefined {
  if (!typeNode || !ts.isTypeReferenceNode(typeNode) || !ts.isIdentifier(typeNode.typeName)) return;
  const [argument] = typeNode.typeArguments ?? [];
  const argumentName = argument && ts.isTypeReferenceNode(argument) ? argument.typeName : undefined;
  if (importedFrom(typeNode.typeName, 'typeorm', checker, new Set(['Repository']))) {
    return entityNamed(argumentName, checker) ? 'typeorm' : undefined;
  }
  if (argument && importedFrom(typeNode.typeName, 'mongoose', checker, new Set(['Model']))) return 'mongoose';
}

function injectionFamily(declaration: Node, checker: CheckerAdapter): ModelFamily | undefined {
  if (!ts.isParameter(declaration) && !ts.isPropertyDeclaration(declaration)) return;
  for (const decorator of decoratorsOf(declaration).map(decoratorCall)) {
    if (!decorator) continue;
    const injection: NestInjection | undefined = NEST_INJECTION[decorator.name];
    // Only a decorator named in NEST_INJECTION can be an injection; any other decorator has no
    // `injection` to compare.
    const imported = injection && importOf(decorator.callee, checker);
    if (imported && imported.module === injection.module && imported.name === decorator.name) return injection.family;
  }
}

function sequelizeInstance(identifier: Node, checker: CheckerAdapter, depth: number): boolean {
  const declaration = projectDeclaration(identifier, checker);
  const initializer = declaration && ts.isVariableDeclaration(declaration) && declaration.initializer;
  if (!initializer) return false;
  const value = ts.skipOuterExpressions(initializer);
  if (ts.isNewExpression(value)) return importedFrom(value.expression, 'sequelize', checker, new Set(['Sequelize']));
  return depth < MAX_ALIAS_HOPS && ts.isIdentifier(value) && sequelizeInstance(value, checker, depth + 1);
}

function initializerFamily(initializer: Expression, checker: CheckerAdapter): ModelFamily | undefined {
  const value = ts.skipOuterExpressions(initializer);
  if (ts.isBinaryExpression(value)) {
    return initializerFamily(value.right, checker) ?? initializerFamily(value.left, checker);
  }
  if (!ts.isCallExpression(value)) return;
  const callee = value.expression;
  if (calleeIsFromFamily(callee, 'mongoose', 'model', checker)) return 'mongoose';
  const calleeName = ts.isPropertyAccessExpression(callee) ? callee.name.text : ts.isIdentifier(callee) && callee.text;
  if (calleeName === 'getRepository') {
    const isTypeormCall = ts.isPropertyAccessExpression(callee) || importedFrom(callee, 'typeorm', checker);
    return isTypeormCall && entityNamed(value.arguments[0], checker) ? 'typeorm' : undefined;
  }
  if (calleeName === 'define' && ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)) {
    return sequelizeInstance(callee.expression, checker, 0) ? 'sequelize' : undefined;
  }
}

function declarationFamily(declaration: Node, checker: CheckerAdapter): ModelFamily | undefined {
  if (ts.isClassDeclaration(declaration)) {
    if (isSequelizeModelClass(declaration, checker)) return 'sequelize';
    return isActiveRecordEntity(declaration, checker) ? 'typeorm' : undefined;
  }
  const fromType = typeReferenceFamily(declaredTypeOf(declaration), checker) ?? injectionFamily(declaration, checker);
  if (fromType) return fromType;
  if (ts.isVariableDeclaration(declaration) || ts.isPropertyDeclaration(declaration)) {
    return declaration.initializer && initializerFamily(declaration.initializer, checker);
  }
}

// The ORM whose project model the receiver names, such as `userRepository`, `UserModel` or
// `this.users`.
function modelReceiverFamily(receiver: Expression, checker: CheckerAdapter): ModelFamily | undefined {
  const value = ts.skipOuterExpressions(receiver);
  const name = ts.isPropertyAccessExpression(value) ? value.name : value;
  if (!ts.isIdentifier(name)) return;
  const declaration = projectDeclaration(name, checker);
  return declaration && declarationFamily(declaration, checker);
}

// `const users = pgTable('users', { ... })` in the project.
function isDrizzleTable(identifier: Node, checker: CheckerAdapter): boolean {
  const declaration = ts.isIdentifier(identifier) && projectDeclaration(identifier, checker);
  const initializer = declaration && ts.isVariableDeclaration(declaration) && declaration.initializer;
  const value = initializer && ts.skipOuterExpressions(initializer);
  if (!value || !ts.isCallExpression(value)) return false;
  const callee = value.expression;
  const tableFunction = ts.isIdentifier(callee)
    ? callee.text
    : ts.isPropertyAccessExpression(callee) && callee.name.text;
  if (typeof tableFunction !== 'string' || !DRIZZLE_TABLE_FUNCTIONS.has(tableFunction)) return false;
  const root = ts.isPropertyAccessExpression(callee) ? callee.expression : callee;
  return importedFrom(root, 'drizzle', checker);
}

function drizzleClient(identifier: Node, checker: CheckerAdapter, depth: number): boolean {
  const declaration = projectDeclaration(identifier, checker);
  if (!declaration) return false;
  const declaredType = declaredTypeOf(declaration);
  const typeName = declaredType && ts.isTypeReferenceNode(declaredType) && declaredType.typeName;
  if (typeName && ts.isIdentifier(typeName) && importedFrom(typeName, 'drizzle', checker)) return true;
  if (ts.isParameter(declaration)) return isDrizzleTransactionParameter(declaration, checker, depth);
  const initializer = ts.isVariableDeclaration(declaration) && declaration.initializer;
  const value = initializer && ts.skipOuterExpressions(initializer);
  if (!value) return false;
  if (ts.isCallExpression(value) && ts.isIdentifier(value.expression)) {
    return importedFrom(value.expression, 'drizzle', checker, new Set(['drizzle']));
  }
  return depth < MAX_ALIAS_HOPS && ts.isIdentifier(value) && drizzleClient(value, checker, depth + 1);
}

// `db.transaction(async (tx) => ...)`: the callback parameter is untyped when drizzle's types are
// missing.
function isDrizzleTransactionParameter(
  parameter: ParameterDeclaration,
  checker: CheckerAdapter,
  depth: number,
): boolean {
  const callback = parameter.parent;
  const call = callback.parent;
  if (
    !ts.isFunctionLike(callback) ||
    !ts.isCallExpression(call) ||
    !call.arguments.some((argument) => argument === callback)
  )
    return false;
  const access = call.expression;
  return (
    depth < MAX_ALIAS_HOPS &&
    ts.isPropertyAccessExpression(access) &&
    access.name.text === 'transaction' &&
    drizzleRoot(access.expression, checker, depth + 1)
  );
}

// The identifier a chain such as `db.select().from(users)` or `db.query.users` starts from.
function drizzleRoot(expression: Expression, checker: CheckerAdapter, depth = 0): boolean {
  let current: Expression = ts.skipOuterExpressions(expression);
  while (ts.isPropertyAccessExpression(current) || ts.isCallExpression(current)) {
    current = ts.skipOuterExpressions(current.expression);
  }
  return ts.isIdentifier(current) && drizzleClient(current, checker, depth);
}

function drizzleFamily(
  access: PropertyAccessExpression,
  call: CallExpression | undefined,
  checker: CheckerAdapter,
): ModelFamily | undefined {
  const [tableArgument] = call?.arguments ?? [];
  const namesTable =
    DRIZZLE_TABLE_ARGUMENT_METHODS.has(access.name.text) && tableArgument && isDrizzleTable(tableArgument, checker);
  return namesTable || drizzleRoot(access.expression, checker) ? 'drizzle' : undefined;
}

// `{ orm, packages }` when the member access reads like a call on a project model of an ORM whose
// package types are missing, otherwise undefined. A name the checker does resolve is never
// second-guessed.
function modelFallback(access: Node, checker: CheckerAdapter): ModelFallback | undefined {
  if (!ts.isPropertyAccessExpression(access) || checker.getSymbolAtLocation(access.name)?.declarations?.length) return;
  const call = ts.isCallExpression(access.parent) && access.parent.expression === access ? access.parent : undefined;
  const orm = modelReceiverFamily(access.expression, checker) ?? drizzleFamily(access, call, checker);
  return orm && { orm, packages: FAMILY_PACKAGES[orm] };
}

function modelFallbackInPackages(access: Node, checker: CheckerAdapter, packages: readonly string[]): boolean {
  const fallback = modelFallback(access, checker);
  return !!fallback && packages.some((name: string) => fallback.packages.includes(name));
}

export { modelFallback, modelFallbackInPackages, isDrizzleTable, isTypeormEntity };
