// dependency-cycle: an import whose names are only used as types becomes `import type`, which is
// erased at compile time and so removes that edge from the runtime cycle.
import { ts, ancestor } from './helpers.js';
import type { Identifier, ImportClause, ImportDeclaration, Node, SourceFile } from 'typescript';
import type { Finding, LoadedFile, SiteFixBuilder, SiteFixInput, TextEdit } from '../../shared/types.js';

interface ParsedFile extends LoadedFile {
  sourceFile: SourceFile;
}

function hasSourceFile(entry: LoadedFile | null): entry is ParsedFile {
  return entry?.sourceFile !== undefined;
}

function literalAt(entry: ParsedFile, location: Finding): ImportDeclaration | undefined {
  if (location.line === undefined || location.column === undefined) return;
  if (!(location.line >= 1 && location.line <= entry.lineStarts.length)) return;
  const offset = entry.lineStarts[location.line - 1] + location.column - 1;
  return entry.sourceFile.statements.find(
    (statement): statement is ImportDeclaration =>
      ts.isImportDeclaration(statement) && statement.moduleSpecifier.getStart(entry.sourceFile) === offset,
  );
}

function bindingNames(clause: ImportClause): Identifier[] {
  const names: Identifier[] = [];
  if (clause.name) names.push(clause.name);
  const bound = clause.namedBindings;
  if (bound && ts.isNamespaceImport(bound)) names.push(bound.name);
  if (bound && ts.isNamedImports(bound)) for (const element of bound.elements) names.push(element.name);
  return names;
}

function propertyKey(identifier: Identifier): boolean {
  const parent = identifier.parent;
  return (
    (ts.isPropertyAccessExpression(parent) && parent.name === identifier) ||
    ((ts.isPropertyAssignment(parent) ||
      ts.isPropertyDeclaration(parent) ||
      ts.isPropertySignature(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isMethodSignature(parent)) &&
      parent.name === identifier)
  );
}

// A class's `extends` clause is typed as an expression with type arguments but evaluates it at run
// time.
function inTypePosition(identifier: Identifier): boolean {
  const typeNode = ancestor(identifier, ts.isTypeNode);
  if (!typeNode) return false;
  const clause =
    ts.isExpressionWithTypeArguments(typeNode) && ts.isHeritageClause(typeNode.parent) ? typeNode.parent : undefined;
  return !(clause && clause.token === ts.SyntaxKind.ExtendsKeyword && ts.isClassLike(clause.parent));
}

// Every other mention of the names sits in a type position. Decorator metadata can turn parameter
// types into runtime references, so files with decorators are left alone.
function typeOnlyUse(sourceFile: SourceFile, declaration: ImportDeclaration, names: readonly Identifier[]): boolean {
  const wanted = new Set(names.map((name) => name.text));
  let runtime = false;
  (function visit(node: Node): void {
    if (runtime || node === declaration) return;
    if (ts.isDecorator(node)) runtime = true;
    else if (ts.isIdentifier(node) && wanted.has(node.text) && !propertyKey(node) && !inTypePosition(node))
      runtime = true;
    else ts.forEachChild(node, visit);
  })(sourceFile);
  return !runtime;
}

function typeImportEdit(entry: ParsedFile, location: Finding): TextEdit | undefined {
  const declaration = literalAt(entry, location);
  const clause = declaration?.importClause;
  if (!clause || clause.isTypeOnly) return;
  const names = bindingNames(clause);
  if (!names.length || !typeOnlyUse(entry.sourceFile, declaration, names)) return;
  // A default import plus named imports cannot be written as one `import type`.
  if (clause.name && clause.namedBindings) return;
  // Inline `type` markers are not allowed inside `import type { ... }`.
  const bound = clause.namedBindings;
  if (bound && ts.isNamedImports(bound) && bound.elements.some((element) => element.isTypeOnly)) return;
  const start = declaration.getStart(entry.sourceFile);
  const importKeyword = 'import';
  if (entry.text.slice(start, start + importKeyword.length) !== importKeyword) return;
  return { start: start + importKeyword.length, end: start + importKeyword.length, text: ' type' };
}

const buildCycle: SiteFixBuilder = ({ finding, load }: SiteFixInput) => {
  if (!finding.file || !/\.[cm]?tsx?$/i.test(finding.file)) return;
  const related: readonly Finding[] = Array.isArray(finding.related) ? finding.related : [];
  for (const location of [finding, ...related]) {
    if (!location.file || !/\.[cm]?tsx?$/i.test(location.file)) continue;
    const entry = load(location.file);
    const edit = hasSourceFile(entry) ? typeImportEdit(entry, location) : undefined;
    if (edit)
      return {
        targets: [{ file: location.file, edits: [edit] }],
        requiresReview: true,
        note: 'The imported names are only used as types, so this import is erased and the cycle no longer loads at run time.',
      };
  }
};

export default { 'dependency-cycle': buildCycle };
