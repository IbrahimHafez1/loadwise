'use strict';

// duplicate-implementation: keeps one top-level function and makes every other copy call it. Applied only when
// each name the copies use resolves to the same binding, so the call runs exactly the code the copy ran.
const path = require('node:path');
const { ts, flaggedFunction, lineStart, nextLineStart, indentationAt, newlineOf, nameUsed } = require('./helpers.cjs');
const { testFile } = require('../duplicates.cjs');

const sourceExtension = /\.[cm]?[jt]sx?$/i;
const forbiddenKinds = new Set([
  ts.SyntaxKind.ThisKeyword,
  ts.SyntaxKind.SuperKeyword,
  ts.SyntaxKind.YieldExpression,
  ts.SyntaxKind.MetaProperty,
]);

function innermostAt(sourceFile, offset) {
  let found;
  (function visit(node) {
    if (node.getStart(sourceFile) <= offset && offset < node.end) {
      found = node;
      ts.forEachChild(node, visit);
    }
  })(sourceFile);
  return found;
}

function siteAt(load, location) {
  const entry = load(location.file);
  if (!entry?.sourceFile || !(location.line >= 1 && location.line <= entry.lineStarts.length)) return;
  const node = innermostAt(entry.sourceFile, entry.lineStarts[location.line - 1] + location.column - 1);
  const fn = node && flaggedFunction(node);
  if (fn && ts.isBlock(fn.body)) return { file: location.file, entry, sourceFile: entry.sourceFile, fn };
}

// Code that depends on how the function is called, so a plain call from elsewhere would behave differently.
function callSensitive(fn) {
  let found = false;
  (function visit(node) {
    if (found) return;
    if (forbiddenKinds.has(node.kind) || (ts.isIdentifier(node) && node.text === 'arguments')) found = true;
    else ts.forEachChild(node, visit);
  })(fn.body);
  return found || Boolean(fn.asteriskToken);
}

function isValueReference(identifier) {
  const parent = identifier.parent;
  if ((ts.isPropertyAccessExpression(parent) || ts.isQualifiedName(parent)) && parent.name === identifier) return false;
  if (ts.isBindingElement(parent) && parent.propertyName === identifier) return false;
  if ((ts.isLabeledStatement(parent) || ts.isBreakOrContinueStatement(parent)) && parent.label === identifier)
    return false;
  if (ts.isJsxAttribute(parent)) return false;
  const keyed =
    ts.isPropertyAssignment(parent) ||
    ts.isMethodDeclaration(parent) ||
    ts.isPropertyDeclaration(parent) ||
    ts.isGetAccessorDeclaration(parent) ||
    ts.isSetAccessorDeclaration(parent);
  return !(keyed && parent.name === identifier);
}

// Identifiers read at run time, in syntax order. Two copies with equal syntax list them in the same order.
function runtimeIdentifiers(fn) {
  const identifiers = [];
  const visit = (node) => {
    if (ts.isTypeNode(node)) return;
    if (ts.isIdentifier(node) && isValueReference(node)) identifiers.push(node);
    ts.forEachChild(node, visit);
  };
  for (const parameter of fn.parameters) visit(parameter);
  visit(fn.body);
  return identifiers;
}

function stripExtension(file) {
  return file.replace(sourceExtension, '').replace(/[\\/]index$/, '');
}

function moduleKey(fromFile, specifier) {
  if (!specifier.startsWith('.')) return specifier;
  return stripExtension(path.resolve(path.dirname(fromFile), specifier));
}

function importedBinding(declaration) {
  let name;
  let clause;
  if (ts.isImportSpecifier(declaration)) {
    name = (declaration.propertyName ?? declaration.name).text;
    clause = declaration.parent.parent;
  } else if (ts.isImportClause(declaration)) {
    name = 'default';
    clause = declaration;
  } else if (ts.isNamespaceImport(declaration)) {
    name = '*';
    clause = declaration.parent;
  } else return;
  const specifier = clause.parent.moduleSpecifier;
  if (!ts.isStringLiteral(specifier)) return;
  return moduleKey(declaration.getSourceFile().fileName, specifier.text) + '#' + name;
}

// Where each runtime name of `fn` comes from: a global, a local declaration (by position in the function), an
// import (by module and exported name) or a declaration elsewhere in the same file.
function bindings(checker, fn) {
  const sourceFile = fn.getSourceFile();
  // Numbered from the parameters on: modifiers and names may differ between copies.
  const order = new Map();
  const number = (node) => {
    order.set(node, order.size);
    ts.forEachChild(node, number);
  };
  for (const parameter of fn.parameters) number(parameter);
  number(fn.body);
  return runtimeIdentifiers(fn).map((identifier) => {
    const parent = identifier.parent;
    const symbol =
      ts.isShorthandPropertyAssignment(parent) && parent.name === identifier
        ? checker.getShorthandAssignmentValueSymbol(parent)
        : checker.getSymbolAtLocation(identifier);
    const declaration = symbol?.declarations?.[0];
    if (!declaration) return 'global:' + identifier.text;
    if (declaration.getSourceFile() !== sourceFile) return;
    if (order.has(declaration)) return 'local:' + order.get(declaration);
    const imported = importedBinding(declaration);
    if (imported) return 'import:' + imported;
    return 'file:' + stripExtension(path.resolve(sourceFile.fileName)) + '#' + identifier.text;
  });
}

function checkerFor(sites) {
  const files = new Map(sites.map((site) => [path.resolve(site.sourceFile.fileName), site.sourceFile]));
  const host = {
    getSourceFile: (name) => files.get(path.resolve(name)),
    getDefaultLibFileName: () => 'lib.d.ts',
    writeFile() {},
    getCurrentDirectory: () => '',
    getCanonicalFileName: (name) => name,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => '\n',
    fileExists: (name) => files.has(path.resolve(name)),
    readFile: () => undefined,
  };
  const options = { noLib: true, noResolve: true, allowJs: true, noEmit: true, types: [] };
  return ts.createProgram({ rootNames: [...files.keys()], options, host }).getTypeChecker();
}

function exported(statement) {
  return statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
}

// A top-level function in a module that is not a test, so importing it runs no test registration.
function canonicalCandidate(site) {
  const { fn, file, sourceFile } = site;
  return (
    ts.isFunctionDeclaration(fn) &&
    fn.name &&
    ts.isSourceFile(fn.parent) &&
    !testFile.test(file) &&
    ts.isExternalModule(sourceFile) &&
    !callSensitive(fn)
  );
}

function simpleParameters(fn) {
  return fn.parameters.every(
    (parameter) => ts.isIdentifier(parameter.name) && !parameter.initializer && parameter.name.text !== 'this',
  );
}

// Local names that an import or a top-level declaration would clash with.
function bindingDeclared(sourceFile, name, except) {
  let declared = false;
  (function visit(node) {
    if (declared || node === except) return;
    const named =
      ts.isVariableDeclaration(node) ||
      ts.isFunctionDeclaration(node) ||
      ts.isClassDeclaration(node) ||
      ts.isParameter(node) ||
      ts.isImportSpecifier(node) ||
      ts.isImportClause(node) ||
      ts.isNamespaceImport(node) ||
      ts.isEnumDeclaration(node) ||
      ts.isBindingElement(node) ||
      ts.isFunctionExpression(node) ||
      ts.isClassExpression(node);
    if (named && node.name && ts.isIdentifier(node.name) && node.name.text === name) declared = true;
    else ts.forEachChild(node, visit);
  })(sourceFile);
  return declared;
}

function moduleImports(sourceFile) {
  return sourceFile.statements.filter(
    (statement) => ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier),
  );
}

// Imports used only inside `removed` would be left unused, which fails builds with noUnusedLocals.
function strandsImports(sourceFile, removed) {
  const imports = moduleImports(sourceFile);
  const names = [];
  for (const declaration of imports) {
    const clause = declaration.importClause;
    if (clause?.name) names.push(clause.name.text);
    const bound = clause?.namedBindings;
    if (bound && ts.isNamespaceImport(bound)) names.push(bound.name.text);
    if (bound && ts.isNamedImports(bound)) for (const element of bound.elements) names.push(element.name.text);
  }
  return names.some((name) => {
    if (!nameUsed(removed, name)) return false;
    let usedElsewhere = false;
    (function visit(node) {
      if (usedElsewhere || node === removed || imports.includes(node)) return;
      if (ts.isIdentifier(node) && node.text === name) usedElsewhere = true;
      else ts.forEachChild(node, visit);
    })(sourceFile);
    return !usedElsewhere;
  });
}

// Loading a module with no runtime imports and no top-level calls has no side effects and cannot close a cycle.
function inertModule(sourceFile) {
  return sourceFile.statements.every((statement) => {
    if (ts.isImportDeclaration(statement)) return Boolean(statement.importClause?.isTypeOnly);
    if (
      ts.isFunctionDeclaration(statement) ||
      ts.isInterfaceDeclaration(statement) ||
      ts.isTypeAliasDeclaration(statement)
    )
      return true;
    if (ts.isExportDeclaration(statement)) return !statement.moduleSpecifier || statement.isTypeOnly;
    if (!ts.isVariableStatement(statement)) return false;
    let effect = false;
    (function visit(node) {
      if (effect || (ts.isFunctionLike(node) && node !== statement)) return;
      if (
        ts.isCallExpression(node) ||
        ts.isNewExpression(node) ||
        ts.isTaggedTemplateExpression(node) ||
        ts.isAwaitExpression(node)
      )
        effect = true;
      else ts.forEachChild(node, visit);
    })(statement);
    return !effect;
  });
}

function relativeSpecifier(fromFile, toFile, sourceFile) {
  let specifier = path.relative(path.dirname(fromFile), toFile).replaceAll('\\', '/');
  const explicitExtensions = moduleImports(sourceFile).some((declaration) =>
    /^\.{1,2}\/.*\.[cm]?js$/.test(declaration.moduleSpecifier.text),
  );
  specifier = explicitExtensions ? specifier.replace(/\.([cm]?)tsx?$/, '.$1js') : stripExtension(specifier);
  return specifier.startsWith('.') ? specifier : './' + specifier;
}

function quoteOf(sourceFile) {
  const first = moduleImports(sourceFile)[0];
  return first && first.moduleSpecifier.getText(sourceFile).startsWith('"') ? '"' : "'";
}

// The edit that makes `localName` refer to the canonical function in the copy's file, or { local } when it is
// already imported. Undefined when the import cannot be added without changing load order.
function importEdit(copy, canonical, removedDeclaration) {
  const { sourceFile } = copy;
  const text = sourceFile.text;
  const targetKey = stripExtension(path.resolve(canonical.sourceFile.fileName));
  const name = canonical.fn.name.text;
  const existing = moduleImports(sourceFile).find(
    (declaration) =>
      !declaration.importClause?.isTypeOnly &&
      moduleKey(sourceFile.fileName, declaration.moduleSpecifier.text) === targetKey,
  );
  const named = existing?.importClause?.namedBindings;
  const already =
    named && ts.isNamedImports(named)
      ? named.elements.find((element) => !element.isTypeOnly && (element.propertyName ?? element.name).text === name)
      : undefined;
  if (already) return { local: already.name.text };
  if (!existing && !inertModule(canonical.sourceFile)) return;
  let local = name;
  if (bindingDeclared(sourceFile, name, removedDeclaration)) {
    local = 'shared' + name[0].toUpperCase() + name.slice(1);
    if (nameUsed(sourceFile, local)) return;
  }
  const specifier = local === name ? name : `${name} as ${local}`;
  if (named && ts.isNamedImports(named) && named.elements.length) {
    const last = named.elements.at(-1);
    const multiline = text.slice(named.getStart(sourceFile), named.end).includes('\n');
    const trailingComma = named.elements.hasTrailingComma;
    if (multiline) {
      const indentation = indentationAt(text, last.getStart(sourceFile));
      const anchor = trailingComma ? text.indexOf(',', last.end) + 1 : last.end;
      return {
        local,
        edit: {
          start: anchor,
          end: anchor,
          text: (trailingComma ? '' : ',') + newlineOf(text) + indentation + specifier + (trailingComma ? ',' : ''),
        },
      };
    }
    return { local, edit: { start: last.end, end: last.end, text: ', ' + specifier } };
  }
  const imports = moduleImports(sourceFile);
  const quote = quoteOf(sourceFile);
  const line = `import { ${specifier} } from ${quote}${relativeSpecifier(sourceFile.fileName, canonical.sourceFile.fileName, sourceFile)}${quote};`;
  const at = imports.length ? nextLineStart(text, imports.at(-1).end) : 0;
  return { local, edit: { start: at, end: at, text: line + newlineOf(text) } };
}

// Removes a whole top-level function with its leading comments and one surrounding blank line.
function removal(fn, sourceFile) {
  const text = sourceFile.text;
  const comments = ts.getLeadingCommentRanges(text, fn.pos) ?? [];
  let start = lineStart(text, comments.length ? comments[0].pos : fn.getStart(sourceFile));
  const end = nextLineStart(text, fn.end);
  const before = text.slice(lineStart(text, Math.max(0, start - 1)), start);
  if (start > 0 && !before.trim()) start = lineStart(text, start - 1);
  return { start, end, text: '' };
}

// Replaces the copy's body with a call to the shared function. An async copy returns the shared promise itself.
function delegation(copy, local) {
  const { fn, sourceFile } = copy;
  const text = sourceFile.text;
  const newline = newlineOf(text);
  const indentation = indentationAt(text, fn.getStart(sourceFile));
  const firstStatement = fn.body.statements[0];
  const inner = indentationAt(text, firstStatement.getStart(sourceFile));
  if (!inner.startsWith(indentation) || inner === indentation) return;
  const argumentsText = fn.parameters
    .map((parameter) => (parameter.dotDotDotToken ? '...' : '') + parameter.name.text)
    .join(', ');
  const edits = [
    {
      start: fn.body.getStart(sourceFile),
      end: fn.body.end,
      text: `{${newline}${inner}return ${local}(${argumentsText});${newline}${indentation}}`,
    },
  ];
  const asyncModifier = fn.modifiers?.find((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword);
  if (asyncModifier) {
    const start = asyncModifier.getStart(sourceFile);
    edits.push({ start, end: start + /^async\s+/.exec(text.slice(start))[0].length, text: '' });
  }
  return edits;
}

function rewriteCopy(copy, canonical) {
  const { fn, sourceFile } = copy;
  if (fn.asteriskToken || ts.isAccessor(fn) || ts.isConstructorDeclaration(fn) || !simpleParameters(fn)) return;
  const name = canonical.fn.name.text;
  const sameFile = copy.file === canonical.file;
  const removable =
    !sameFile && ts.isFunctionDeclaration(fn) && ts.isSourceFile(fn.parent) && !exported(fn) && fn.name?.text === name;
  if (strandsImports(sourceFile, removable ? fn : fn.body)) return;
  if (sameFile) {
    if (fn.parameters.some((parameter) => parameter.name.text === name)) return;
    return delegation(copy, name);
  }
  if (!ts.isExternalModule(sourceFile)) return;
  const imported = importEdit(copy, canonical, removable ? fn : undefined);
  if (!imported) return;
  if (fn.parameters.some((parameter) => parameter.name.text === imported.local)) return;
  const edits = removable ? [removal(fn, sourceFile)] : delegation(copy, imported.local);
  return edits && [...edits, ...(imported.edit ? [imported.edit] : [])];
}

function buildDuplicate({ finding, load }) {
  const sites = [finding, ...(finding.related ?? [])].map((location) => siteAt(load, location));
  if (sites.some((site) => !site)) return;
  const checker = checkerFor(sites);
  const resolved = sites.map((site) => bindings(checker, site.fn));
  const candidates = sites.filter(canonicalCandidate);
  const canonical = candidates.find((site) => exported(site.fn)) ?? candidates[0];
  if (!canonical) return;
  const canonicalBindings = resolved[sites.indexOf(canonical)];
  const ownFileKey = 'file:' + stripExtension(path.resolve(canonical.sourceFile.fileName)) + '#';
  const editsByFile = new Map();
  const addEdits = (file, edits) => editsByFile.set(file, [...(editsByFile.get(file) ?? []), ...edits]);
  if (!exported(canonical.fn))
    addEdits(canonical.file, [
      {
        start: canonical.fn.getStart(canonical.sourceFile),
        end: canonical.fn.getStart(canonical.sourceFile),
        text: 'export ',
      },
    ]);
  for (const [index, copy] of sites.entries()) {
    if (copy === canonical) continue;
    const sameNames = canonicalBindings.every((binding, position) => {
      const other = resolved[index][position];
      if (!binding || !other) return false;
      if (binding === other) return copy.file === canonical.file || !binding.startsWith('file:');
      // A copy elsewhere may import the canonical file's own top-level name.
      return binding.startsWith(ownFileKey) && other === 'import:' + binding.slice('file:'.length);
    });
    if (!sameNames || resolved[index].length !== canonicalBindings.length) return;
    const edits = rewriteCopy(copy, canonical);
    if (!edits) return;
    addEdits(copy.file, edits);
  }
  const location = `${canonical.file}:${canonical.fn.getSourceFile().getLineAndCharacterOfPosition(canonical.fn.name.getStart(canonical.sourceFile)).line + 1}`;
  return {
    targets: [...editsByFile].map(([file, edits]) => ({ file, edits })),
    note: `Keeps ${location} as the one implementation; the other copies now call it.`,
  };
}

module.exports = { 'duplicate-implementation': buildDuplicate };
