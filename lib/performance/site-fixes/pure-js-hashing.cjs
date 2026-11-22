'use strict';

const fs = require('node:fs');
const path = require('node:path');
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

const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

// Swapping the specifier only compiles when `bcrypt` is installed; the nearest package.json decides, like Node's lookup.
function declaresNativeBcrypt(fileName) {
  for (let directory = path.dirname(fileName); ; directory = path.dirname(directory)) {
    const manifest = readJson(path.join(directory, 'package.json'));
    if (manifest) return DEPENDENCY_FIELDS.some((field) => manifest[field]?.bcrypt !== undefined);
    if (directory === path.dirname(directory)) return false;
  }
}

function resolvesNativeBcrypt(fileName) {
  try {
    require.resolve('bcrypt/package.json', { paths: [path.dirname(fileName)] });
    return true;
  } catch {
    return false;
  }
}

// Without `bcrypt` installed there is no safe one-click edit: the finding message tells the user to install it first.
function switchToNativeBcrypt({ sourceFile }) {
  if (!declaresNativeBcrypt(sourceFile.fileName) && !resolvesNativeBcrypt(sourceFile.fileName)) return;
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
    requiresReview: true,
    note: 'Native `bcrypt` is a compiled dependency: install `bcrypt` and `@types/bcrypt` (and remove `bcryptjs`). hash, compare and genSalt behave the same and existing hashes still verify.',
  };
}

module.exports = { 'password-hash-pure-js': switchToNativeBcrypt };
