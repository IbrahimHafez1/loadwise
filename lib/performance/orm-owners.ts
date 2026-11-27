import { ts } from './compiler.js';
import type { ClassLikeDeclaration, Expression, Identifier, Node } from 'typescript';
import type { CheckerAdapter, SymbolAdapter } from '../shared/types.js';

const mikroOrmOwners = new Set(['EntityManager', 'SqlEntityManager', 'EntityRepository', 'SqlEntityRepository']);
const typeormOwnerNames = new Map([
  ['Repository', 'TypeORM'],
  ['EntityManager', 'TypeORM EntityManager'],
  ['DataSource', 'TypeORM DataSource'],
  ['QueryRunner', 'TypeORM QueryRunner'],
]);
// TypeORM and forks published under a scope, such as @n8n/typeorm; @nestjs/typeorm only wires
// TypeORM into Nest.
const typeormPackage = /^(?:@[^/]+\/)?typeorm$/;
const MAX_HERITAGE_DEPTH = 4;

function isTypeormPackage(name: string | undefined): boolean {
  return !!name && name !== '@nestjs/typeorm' && typeormPackage.test(name);
}

function packageNameOf(specifier: string) {
  const [first, second] = specifier.split('/');
  return first.startsWith('@') ? `${first}/${second}` : first;
}

// The exported name an identifier imports from TypeORM, whether or not the package's types are
// installed.
function typeormImportOf(identifier: Identifier, checker: CheckerAdapter): string | undefined {
  const declaration = checker.getSymbolAtLocation(identifier)?.declarations?.[0];
  if (!declaration || !ts.isImportSpecifier(declaration)) return;
  const specifier = declaration.parent.parent.parent.moduleSpecifier;
  if (ts.isStringLiteral(specifier) && isTypeormPackage(packageNameOf(specifier.text)))
    return (declaration.propertyName ?? declaration.name).text;
}

function extendedClass(declaration: ClassLikeDeclaration | undefined): Expression | undefined {
  return declaration?.heritageClauses?.find((clause) => clause.token === ts.SyntaxKind.ExtendsKeyword)?.types[0]
    ?.expression;
}

// `Repository` imported from TypeORM, or a project class such as `class UserRepository extends
// Repository<User>`.
function classTypeormOwner(name: Node | undefined, checker: CheckerAdapter, depth = 0): string | undefined {
  if (depth > MAX_HERITAGE_DEPTH || !name || !ts.isIdentifier(name)) return;
  const imported = typeormImportOf(name, checker);
  if (imported) return typeormOwnerNames.get(imported);
  let symbol = checker.getSymbolAtLocation(name);
  if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
  return classTypeormOwner(extendedClass(symbol?.declarations?.find(ts.isClassDeclaration)), checker, depth + 1);
}

function enclosingClass(node: Node): ClassLikeDeclaration | undefined {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isClassLike(current)) return current;
    if (ts.isFunctionLike(current) && !ts.isArrowFunction(current) && !ts.isClassLike(current.parent)) return;
  }
}

// Without TypeORM's types a method call resolves to nothing, but the receiver's declared type, such
// as an injected
// `Repository<User>` or `this` inside a class extending it, still names its owner.
function declaredTypeormOwner(receiver: Expression, checker: CheckerAdapter): string | undefined {
  const value = ts.skipOuterExpressions(receiver);
  if (value.kind === ts.SyntaxKind.ThisKeyword) return classTypeormOwner(extendedClass(enclosingClass(value)), checker);
  const name = ts.isPropertyAccessExpression(value) ? value.name : value;
  if (!ts.isIdentifier(name)) return;
  const declaration = checker.getSymbolAtLocation(name)?.valueDeclaration;
  const type =
    declaration &&
    (ts.isParameter(declaration) || ts.isPropertyDeclaration(declaration) || ts.isVariableDeclaration(declaration)) &&
    declaration.type;
  if (type && ts.isTypeReferenceNode(type)) return classTypeormOwner(type.typeName, checker);
}

const typeormOwnerFamilies: ReadonlyMap<string, string> = new Map([
  ['Repository', 'TypeORM'],
  ['EntityManager', 'TypeORM EntityManager'],
  ['DataSource', 'TypeORM DataSource'],
  ['QueryRunner', 'TypeORM QueryRunner'],
]);

interface PackageOwnerRule {
  readonly packagePrefix: string;
  readonly families: ReadonlyMap<string, string>;
}

// The declaring class name decides the family, but only inside the package that ships it.
const packageOwnerRules: readonly PackageOwnerRule[] = [
  { packagePrefix: 'sequelize/', families: new Map([['Model', 'Sequelize']]) },
  {
    packagePrefix: '@sequelize/core/',
    families: new Map([
      ['Model', 'Sequelize'],
      ['ModelTypeScript', 'Sequelize'],
    ]),
  },
  {
    packagePrefix: 'mongoose/',
    families: new Map([
      ['Model', 'Mongoose Model'],
      ['Query', 'Mongoose Query'],
    ]),
  },
  {
    packagePrefix: 'knex/',
    families: new Map([
      ['QueryInterface', 'Knex'],
      ['QueryBuilder', 'Knex'],
    ]),
  },
  {
    packagePrefix: 'kysely/',
    families: new Map([
      ['SelectQueryBuilder', 'Kysely'],
      ['QueryCreator', 'Kysely'],
    ]),
  },
  {
    packagePrefix: '@mikro-orm/',
    families: new Map(Array.from(mikroOrmOwners, (name): [string, string] => [name, 'MikroORM'])),
  },
  { packagePrefix: 'payload/', families: new Map([['BasePayload', 'Payload']]) },
];

function declaredOwner(declaration: Node): string | undefined {
  const owner = declaration.parent;
  if ((!ts.isClassDeclaration(owner) && !ts.isInterfaceDeclaration(owner)) || !owner.name) return;
  const file = declaration.getSourceFile();
  if (!file.isDeclarationFile) return;
  const segments = file.fileName.replaceAll('\\', '/').split('/node_modules/');
  if (segments.length < 2) return;
  const packagePath = segments[segments.length - 1];
  if (isTypeormPackage(packageNameOf(packagePath))) {
    const typeormFamily = typeormOwnerFamilies.get(owner.name.text);
    if (typeormFamily) return typeormFamily;
  }
  const rule = packageOwnerRules.find((candidate) => packagePath.startsWith(candidate.packagePrefix));
  return rule?.families.get(owner.name.text);
}

function symbolOwner(symbol: SymbolAdapter | undefined) {
  const declarations = symbol?.declarations;
  if (!declarations?.length) return;
  const owner = declaredOwner(declarations[0]);
  if (owner && declarations.every((declaration) => declaredOwner(declaration) === owner)) return owner;
}

function methodOwner(name: Node, checker: CheckerAdapter) {
  return symbolOwner(checker.getSymbolAtLocation(name));
}

export { declaredTypeormOwner, isTypeormPackage, methodOwner, symbolOwner, typeormImportOf };
