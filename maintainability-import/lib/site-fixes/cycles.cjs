'use strict';

// dependency-cycle: an import whose names are only used as types becomes `import type`, which is erased at
// compile time and so removes that edge from the runtime cycle.
const { ts, ancestor } = require('./helpers.cjs');

function literalAt(entry, location) {
  if (!(location.line >= 1 && location.line <= entry.lineStarts.length)) return;
  const offset = entry.lineStarts[location.line - 1] + location.column - 1;
  return entry.sourceFile.statements.find(
    (statement) => ts.isImportDeclaration(statement) && statement.moduleSpecifier.getStart(entry.sourceFile) === offset,
  );
}

function bindingNames(clause) {
  const names = [];
  if (clause.name) names.push(clause.name);
  const bound = clause.namedBindings;
  if (bound && ts.isNamespaceImport(bound)) names.push(bound.name);
  if (bound && ts.isNamedImports(bound)) for (const element of bound.elements) names.push(element.name);
  return names;
}

function propertyKey(identifier) {
  const parent = identifier.parent;
  return (
    ((ts.isPropertyAccessExpression(parent) || ts.isQualifiedName(parent)) && parent.name === identifier) ||
    ((ts.isPropertyAssignment(parent) ||
      ts.isPropertyDeclaration(parent) ||
      ts.isPropertySignature(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isMethodSignature(parent)) &&
      parent.name === identifier)
  );
}

// Every other mention of the names sits in a type position. Decorator metadata can turn parameter types into
// runtime references, so files with decorators are left alone.
function typeOnlyUse(sourceFile, declaration, names) {
  const wanted = new Set(names.map((name) => name.text));
  let runtime = false;
  (function visit(node) {
    if (runtime || node === declaration) return;
    if (ts.isDecorator(node)) runtime = true;
    else if (ts.isIdentifier(node) && wanted.has(node.text) && !propertyKey(node) && !ancestor(node, ts.isTypeNode))
      runtime = true;
    else ts.forEachChild(node, visit);
  })(sourceFile);
  return !runtime;
}

function typeImportEdit(entry, location) {
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

function buildCycle({ finding, load }) {
  if (!/\.[cm]?tsx?$/i.test(finding.file)) return;
  for (const location of [finding, ...(finding.related ?? [])]) {
    if (!/\.[cm]?tsx?$/i.test(location.file)) continue;
    const entry = load(location.file);
    const edit = entry?.sourceFile && typeImportEdit(entry, location);
    if (edit)
      return {
        targets: [{ file: location.file, edits: [edit] }],
        note: 'The imported names are only used as types, so this import is erased and the cycle no longer loads at run time.',
      };
  }
}

module.exports = { 'dependency-cycle': buildCycle };
