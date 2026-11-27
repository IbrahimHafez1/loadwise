import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { replaceNode, ts } from './helpers.js';
import type { ImportClause, ImportDeclaration, Statement } from 'typescript';
import type { FixResult, SiteFixInput } from '../../shared/types.js';

// The only bindings whose async API is identical in `bcrypt`.
const COMPATIBLE_NAMED_IMPORTS = new Set(['hash', 'compare', 'genSalt']);

function isCompatibleImport(importClause: ImportClause | undefined): boolean {
  if (!importClause || importClause.isTypeOnly) return false;
  const bindings = importClause.namedBindings;
  if (!bindings) return !!importClause.name;
  if (ts.isNamespaceImport(bindings)) return !importClause.name;
  return (
    !importClause.name &&
    bindings.elements.every((element) => COMPATIBLE_NAMED_IMPORTS.has((element.propertyName ?? element.name).text))
  );
}

const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];

function readJson(file: string): Record<string, Record<string, unknown> | undefined> | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

// Swapping the specifier only compiles when `bcrypt` is installed; the nearest package.json
// decides, like Node's lookup.
function declaresNativeBcrypt(fileName: string): boolean {
  for (let directory = path.dirname(fileName); ; directory = path.dirname(directory)) {
    const manifest = readJson(path.join(directory, 'package.json'));
    if (manifest) return DEPENDENCY_FIELDS.some((field) => manifest[field]?.bcrypt !== undefined);
    if (directory === path.dirname(directory)) return false;
  }
}

const resolveFrom = createRequire(import.meta.url);

function resolvesNativeBcrypt(fileName: string): boolean {
  try {
    resolveFrom.resolve('bcrypt/package.json', { paths: [path.dirname(fileName)] });
    return true;
  } catch {
    return false;
  }
}

// Without `bcrypt` installed there is no safe one-click edit: the finding message tells the user to
// install it first.
function switchToNativeBcrypt({ sourceFile }: SiteFixInput): FixResult | undefined {
  if (!sourceFile) return;
  if (!declaresNativeBcrypt(sourceFile.fileName) && !resolvesNativeBcrypt(sourceFile.fileName)) return;
  const imports = sourceFile.statements.filter(
    (statement: Statement): statement is ImportDeclaration =>
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text === 'bcryptjs',
  );
  if (imports.length !== 1 || !isCompatibleImport(imports[0].importClause)) return;
  const specifier = imports[0].moduleSpecifier;
  const quote = specifier.getText(sourceFile)[0];
  return {
    edits: [replaceNode(specifier, `${quote}bcrypt${quote}`)],
    requiresReview: true,
    note: 'Native `bcrypt` is a compiled dependency: install `bcrypt` and `@types/bcrypt` (and remove `bcryptjs`). hash, compare and genSalt behave the same and existing hashes still verify.',
  };
}

export default { 'password-hash-pure-js': switchToNativeBcrypt };
