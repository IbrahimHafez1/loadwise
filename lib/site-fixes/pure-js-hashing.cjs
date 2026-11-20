'use strict';

const ts = require('typescript');
const { replaceNode } = require('./helpers.cjs');

// The only bindings whose async API is identical in `bcrypt`.
const COMPATIBLE_NAMED_IMPORTS = new Set(['hash', 'compare', 'genSalt']);

function isCompatibleImport(importClause) {
  if (!importClause || importClause.isTypeOnly) return false;
  const bindings = importClause.namedBindings;
  if (!bindings) return !!importClause.name;
  if (ts.isNamespaceImport(bindings)) return !importClause.name;
  return (
    !importClause.name &&
    bindings.elements.every((element) => COMPATIBLE_NAMED_IMPORTS.has((element.propertyName ?? element.name).text))
  );
}

function switchToNativeBcrypt({ sourceFile }) {
  const imports = sourceFile.statements.filter(
    (statement) =>
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text === 'bcryptjs',
  );
  if (imports.length !== 1 || !isCompatibleImport(imports[0].importClause)) return;
  const specifier = imports[0].moduleSpecifier;
  const quote = specifier.getText(sourceFile)[0];
  return {
    edits: [replaceNode(specifier, `${quote}bcrypt${quote}`)],
    note: 'Native `bcrypt` is a compiled dependency: install `bcrypt` and `@types/bcrypt` (and remove `bcryptjs`). hash, compare and genSalt behave the same and existing hashes still verify.',
  };
}

module.exports = { 'password-hash-pure-js': switchToNativeBcrypt };
