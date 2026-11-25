import { ts } from './compiler.js';
import { modelFallbackInPackages } from './models/index.js';
import type { PropertyAccessExpression } from 'typescript';
import type { CheckerAdapter, TypeAdapter } from '../shared/types.js';

// True when the type (every non-null member of a union) is declared by one of `packages` under
// node_modules, optionally with one of `typeNames`.
function typeFromPackage(type: TypeAdapter, packages: readonly string[], typeNames?: readonly string[]): boolean {
  if (type.isUnion()) {
    const members = (type.types ?? []).filter(
      (member) => !(member.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined)),
    );
    return members.length > 0 && members.every((member) => typeFromPackage(member, packages, typeNames));
  }
  const symbol = type.getSymbol();
  if (!symbol || (typeNames && !typeNames.includes(symbol.name))) return false;
  return (
    symbol.declarations?.some((declaration) => {
      const filename = declaration.getSourceFile().fileName.replaceAll('\\', '/');
      const marker = '/node_modules/';
      const start = filename.lastIndexOf(marker);
      if (start < 0) return false;
      const withinModules = filename.slice(start + marker.length);
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
