import { ts } from './compiler.js';
import { modelFallbackInPackages } from './models/index.js';
import type { PropertyAccessExpression, SourceFile } from 'typescript';
import type { CheckerAdapter, TypeAdapter } from '../shared/types.js';

const NODE_MODULES_MARKER = '/node_modules/';
const withinNodeModulesCache = new WeakMap<SourceFile, string | null>();

function withinNodeModules(sourceFile: SourceFile): string | null {
  const cached = withinNodeModulesCache.get(sourceFile);
  if (cached !== undefined) return cached;
  const filename = sourceFile.fileName.replaceAll('\\', '/');
  const start = filename.lastIndexOf(NODE_MODULES_MARKER);
  const result = start < 0 ? null : filename.slice(start + NODE_MODULES_MARKER.length);
  withinNodeModulesCache.set(sourceFile, result);
  return result;
}

// True when the type (every non-null member of a union) is declared by one of `packages` under
// node_modules, optionally with one of `typeNames`.
function typeFromPackage(type: TypeAdapter, packages: readonly string[], typeNames?: readonly string[]): boolean {
  if (type.isUnion()) {
    const nullish = ts.TypeFlags.Null | ts.TypeFlags.Undefined;
    let hasNonNull = false;
    for (const member of type.types ?? []) {
      if (member.flags & nullish) continue;
      hasNonNull = true;
      if (!typeFromPackage(member, packages, typeNames)) return false;
    }
    return hasNonNull;
  }
  const symbol = type.getSymbol();
  if (!symbol || (typeNames && !typeNames.includes(symbol.name))) return false;
  return (
    symbol.declarations?.some((declaration) => {
      const withinModules = withinNodeModules(declaration.getSourceFile());
      if (withinModules === null) return false;
      return packages.some((name) => withinModules.startsWith(name + '/'));
    }) ?? false
  );
}

// True when `access` (`receiver.method`) calls a project model of one of `packages`' ORM and the
// package's types are missing, so `typeFromPackage` cannot see it. Reduced precision: the model is
// recognised from source.
function receiverFromModel(access: PropertyAccessExpression, checker: CheckerAdapter, packages: readonly string[]) {
  return modelFallbackInPackages(access, checker, packages);
}

export { typeFromPackage, receiverFromModel };
