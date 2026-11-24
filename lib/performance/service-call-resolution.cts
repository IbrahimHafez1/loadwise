import { loadSyntax } from './compiler.cjs';
import { isFunctionLikeDeclaration } from './request-handlers.cjs';
import { isGeneratedPrismaFile } from './prisma.cjs';
import { packageOf } from './schema/ts-helpers.cjs';
import { isTypeormPackage } from './orm-queries.cjs';
import { packageOperations, prismaOperations } from './service-loop-operations.cjs';
import type { CallExpression, Node } from 'typescript';
import type { CheckerAdapter } from '../shared/types.cjs';
import type { FunctionWithBody } from '../shared/types/function-summaries.cjs';
import type { PackageOperations } from './service-loop-operations.cjs';
const ts = loadSyntax();

function signatureDeclaration(call: CallExpression, checker: CheckerAdapter): Node | undefined {
  const declaration = checker.getResolvedSignature(call)?.declaration;
  if (declaration) return declaration;
  const name = ts.isPropertyAccessExpression(call.expression) ? call.expression.name : call.expression;
  return checker.getSymbolAtLocation(name)?.declarations?.[0];
}

function isProjectFunction(declaration: Node | undefined): declaration is FunctionWithBody {
  if (!declaration || !isFunctionLikeDeclaration(declaration) || !declaration.body) return false;
  const file = declaration.getSourceFile();
  return !file.isDeclarationFile && !file.fileName.replaceAll('\\', '/').includes('/node_modules/');
}

function methodName(call: CallExpression): string | undefined {
  const callee = call.expression;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
}

// The client family of a database or cache call, or undefined for anything else.
function operationFamily(method: string, declaration: Node): string | undefined {
  const owningPackage = packageOf(declaration);
  if (
    owningPackage === '@prisma/client' ||
    owningPackage === '.prisma' ||
    isGeneratedPrismaFile(declaration.getSourceFile())
  )
    return prismaOperations.has(method) ? 'prisma' : undefined;
  const entry = owningPackage && familyEntry(owningPackage);
  if (!entry) return;
  const typeName = enclosingTypeName(declaration);
  if (entry.owners && (typeName === undefined || !entry.owners.has(typeName))) return;
  // Redis clients expose each command in both lower and camel case.
  const command = entry.family === 'redis' ? method.toLowerCase() : method;
  if (entry.operations.has(command)) return entry.family;
}

// Forks published under a scope, such as @n8n/typeorm, keep TypeORM's API.
function familyEntry(owningPackage: string): PackageOperations | undefined {
  const name = isTypeormPackage(owningPackage) ? 'typeorm' : owningPackage;
  return packageOperations.find(({ packages }) => packages.includes(name));
}

function enclosingTypeName(declaration: Node): string | undefined {
  let current: Node | undefined = declaration;
  while (current && !ts.isClassLike(current) && !ts.isInterfaceDeclaration(current)) current = current.parent;
  return current?.name?.text;
}

export { familyEntry, isProjectFunction, methodName, operationFamily, signatureDeclaration };
