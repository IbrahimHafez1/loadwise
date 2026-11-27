// Import edits: TypeORM's In() where a batch read is written, and the batch function in the call
// site's import of a helper from another file.
import path from 'node:path';
import { ts, nameTaken } from './helpers.js';
import { contains, hasModifier } from './service-loop-ast.js';
import type { CallExpression, Node, SourceFile } from 'typescript';
import type { CalleeHelper } from '../types/callee-helper.js';
import type { TextEdit } from '../../shared/types.js';

// TypeORM's In() must be imported where the batch read is written.
export function inImportEdit(sourceFile: SourceFile): { edits: TextEdit[] } | undefined {
  const imports = sourceFile.statements.filter(ts.isImportDeclaration);
  const typeormImport = imports.find(
    (declaration) => ts.isStringLiteral(declaration.moduleSpecifier) && declaration.moduleSpecifier.text === 'typeorm',
  );
  const clause = typeormImport?.importClause;
  const named = clause?.namedBindings;
  if (!clause || !named || !ts.isNamedImports(named) || clause.isTypeOnly) return;
  if (named.elements.some((element) => element.name.text === 'In' && !element.isTypeOnly)) return { edits: [] };
  if (contains(sourceFile, (node: Node) => ts.isIdentifier(node) && node.text === 'In')) return;
  const position = named.elements.length
    ? named.elements[named.elements.length - 1].end
    : named.getStart(sourceFile) + 1;
  return { edits: [{ start: position, end: position, text: named.elements.length ? ', In' : ' In ' }] };
}

const resolvedExtensions = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];

// Whether a relative module specifier written in `fromFile` names `targetFile` (with or without its
// extension, a
// `.js` written for a `.ts` source, or an index file).
function specifierNames(specifier: string, fromFile: string, targetFile: string): boolean {
  if (!/^\.\.?(?:\/|$)/.test(specifier)) return false;
  const base = path.resolve(path.dirname(fromFile), specifier);
  const stem = base.replace(/\.[cm]?[jt]sx?$/i, '');
  const candidates = [
    base,
    ...resolvedExtensions.flatMap((extension) => [stem + extension, path.join(base, 'index' + extension)]),
  ];
  const target = path.resolve(targetFile).toLowerCase();
  return candidates.some((candidate) => candidate.toLowerCase() === target);
}

// The edit adding `batchName` next to `name` in the call site's named import of the helper's file.
function importBatchEdit(
  sourceFile: SourceFile,
  name: string,
  batchName: string,
  calleeFile: string,
): TextEdit[] | undefined {
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const clause = statement.importClause;
    const bindings = clause?.namedBindings;
    if (!clause || clause.isTypeOnly || !bindings || !ts.isNamedImports(bindings)) continue;
    if (!specifierNames(statement.moduleSpecifier.text, sourceFile.fileName, calleeFile)) continue;
    const element = bindings.elements.find((candidate) => candidate.name.text === name);
    if (!element || element.propertyName || element.isTypeOnly) return;
    if (bindings.elements.some((candidate) => candidate.name.text === batchName)) return [];
    if (nameTaken(sourceFile, batchName)) return;
    return [{ start: element.end, end: element.end, text: `, ${batchName}` }];
  }
}

// An exported top-level function called by its own name from another file that imports it by name.
export function crossFileImport(
  callee: CalleeHelper,
  call: CallExpression,
  sourceFile: SourceFile,
  batchName: string,
): TextEdit[] | undefined {
  const { declaration } = callee;
  if (!ts.isSourceFile(declaration.parent) || !hasModifier(declaration, ts.SyntaxKind.ExportKeyword)) return;
  if (hasModifier(declaration, ts.SyntaxKind.DefaultKeyword) || !ts.isIdentifier(call.expression)) return;
  return importBatchEdit(sourceFile, call.expression.text, batchName, callee.entry.absolute);
}
