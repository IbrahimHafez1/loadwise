// Name helpers shared by the per-item query rewrites: pluralising, casing and picking identifiers
// that are free in the file.
import { ts, freshName } from './helpers.cjs';
import type { SourceFile } from 'typescript';

export const typeScriptFile = /\.[cm]?tsx?$/i;

export const identifierPattern = /^[A-Za-z_$][\w$]*$/;

export function plural(name: string): string {
  if (/[^aeiou]y$/.test(name)) return name.slice(0, -1) + 'ies';
  if (/(?:s|x|ch|sh)$/.test(name)) return name + 'es';
  return name + 's';
}

export function capitalized(name: string): string {
  return name[0].toUpperCase() + name.slice(1);
}

export function camelCase(name: string): string {
  return name.replaceAll(/_+([a-z0-9])/g, (_match: string, letter: string) => letter.toUpperCase());
}

export function usableName(sourceFile: SourceFile, base: string): string | undefined {
  if (!identifierPattern.test(base) || ts.stringToToken(base) !== undefined) return;
  return freshName(sourceFile, base);
}

export function asConst(sourceFile: SourceFile): string {
  return typeScriptFile.test(sourceFile.fileName) ? ' as const' : '';
}

// `base`, or `existingBase` when the file already uses `base`, before falling back to a numbered
// name.
export function rowsName(sourceFile: SourceFile, base: string): string | undefined {
  if (!identifierPattern.test(base) || ts.stringToToken(base) !== undefined) return;
  if (freshName(sourceFile, base) === base) return base;
  return freshName(sourceFile, `existing${capitalized(base)}`);
}
