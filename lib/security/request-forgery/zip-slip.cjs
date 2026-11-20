'use strict';

// zip-slip-extraction: an archive entry name joined into a write path without a containment check. The taint engine
// has no archive-entry source yet, so entry names are recognised here from the archive libraries' shapes.
const { syntax: ts } = require('../../performance/compiler.cjs');
const { importedFrom } = require('../bindings.cjs');
const { strip, calleeName, constantDeclaration, hasValidationEvidence } = require('./shared.cjs');

const ruleId = 'zip-slip-extraction';
const message =
  'This archive entry name is joined into a write path without a containment check, so an entry named `../../x` writes outside the target folder. Resolve the path and skip entries that leave the destination directory.';

const archiveModules = new Set([
  'adm-zip',
  'yauzl',
  'yauzl-promise',
  'unzipper',
  'tar-stream',
  'jszip',
  'node-stream-zip',
]);
const fsModules = new Set(['fs', 'fs/promises', 'fs-extra', 'graceful-fs']);
const writeFunctions = new Set([
  'appendFile',
  'createWriteStream',
  'ensureDir',
  'ensureFile',
  'mkdir',
  'mkdirp',
  'mkdirs',
  'outputFile',
  'writeFile',
]);
// Entry fields that hold the name stored in the archive: adm-zip entryName, yauzl fileName, unzipper path,
// tar-stream header.name, node-stream-zip and jszip name.
const nameFields = new Set(['entryName', 'fileName', 'path', 'name']);
// Iterables of entries: `zip.getEntries()`, `Object.values(zip.files)`, `await zip.entries()`.
const entryCollections = new Set(['getEntries', 'entries', 'files']);
// Path helpers whose result contains every argument.
const joiningFunctions = new Set(['join', 'resolve', 'normalize']);
const maxDepth = 6;
// `entry.fileName.endsWith('/')` tells directories from files; it does not contain the path.
const notContainmentChecks = new Set(['endsWith']);

function importsArchiveLibrary(sourceFile) {
  return sourceFile.statements.some((statement) => {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier))
      return archiveModules.has(statement.moduleSpecifier.text);
    return archiveModules.has(requiredModule(statement));
  });
}

function requiredModule(statement) {
  if (!ts.isVariableStatement(statement)) return;
  for (const declaration of statement.declarationList.declarations) {
    const initializer = declaration.initializer && strip(declaration.initializer);
    if (
      initializer &&
      ts.isCallExpression(initializer) &&
      ts.isIdentifier(initializer.expression) &&
      initializer.expression.text === 'require' &&
      initializer.arguments[0] &&
      ts.isStringLiteralLike(initializer.arguments[0])
    )
      return initializer.arguments[0].text;
  }
}

function mentionsEntryCollection(expression) {
  let found = false;
  (function visit(node) {
    if (found) return;
    if (ts.isPropertyAccessExpression(node) && entryCollections.has(node.name.text)) found = true;
    ts.forEachChild(node, visit);
  })(expression);
  return found;
}

// Is this parameter or loop variable an archive entry? `(entry) => ...` passed to `.on('entry', ...)` or to
// `.forEach` on entries, the tar-stream header, or `for (const entry of zip.getEntries())`.
function isEntryDeclaration(declaration) {
  if (ts.isParameter(declaration)) {
    const fn = declaration.parent;
    const call = fn.parent;
    if (!ts.isCallExpression(call) || !call.arguments.includes(fn)) return false;
    const name = calleeName(call);
    if (name === 'on' || name === 'once') {
      const [event] = call.arguments;
      return (
        Boolean(event && ts.isStringLiteralLike(event) && event.text === 'entry') && fn.parameters[0] === declaration
      );
    }
    return name === 'forEach' && mentionsEntryCollection(call.expression);
  }
  if (ts.isVariableDeclaration(declaration) && ts.isForOfStatement(declaration.parent.parent))
    return mentionsEntryCollection(declaration.parent.parent.expression);
  return false;
}

// The archive entry name inside `expression`, through const aliases and path joins, or undefined.
function entryName(expression, checker, depth = 0) {
  const node = strip(expression);
  if (!node || depth > maxDepth) return;
  const next = (child) => entryName(child, checker, depth + 1);
  if (ts.isPropertyAccessExpression(node) && nameFields.has(node.name.text)) {
    const receiver = strip(node.expression);
    const declaration = ts.isIdentifier(receiver) && checker.getSymbolAtLocation(receiver)?.valueDeclaration;
    if (declaration && isEntryDeclaration(declaration)) return node;
    return next(node.expression) && node;
  }
  if (ts.isIdentifier(node)) {
    const declaration = checker.getSymbolAtLocation(node)?.valueDeclaration;
    // jszip's forEach passes the relative path as the first parameter.
    if (declaration && ts.isParameter(declaration) && isEntryDeclaration(declaration)) {
      const call = declaration.parent.parent;
      return calleeName(call) === 'forEach' && declaration.parent.parameters[0] === declaration ? node : undefined;
    }
    const constant = constantDeclaration(node, checker);
    return constant && next(constant.initializer);
  }
  if (ts.isTemplateExpression(node)) {
    for (const span of node.templateSpans) {
      const found = next(span.expression);
      if (found) return found;
    }
    return;
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken)
    return next(node.left) ?? next(node.right);
  if (ts.isCallExpression(node)) {
    const callee = strip(node.expression);
    const pathCall =
      ts.isPropertyAccessExpression(callee) &&
      joiningFunctions.has(callee.name.text) &&
      ts.isIdentifier(strip(callee.expression)) &&
      importedFrom(strip(callee.expression), checker)?.module === 'path';
    const importedJoin =
      ts.isIdentifier(callee) && joiningFunctions.has(callee.text) && importedFrom(callee, checker)?.module === 'path';
    if (!pathCall && !importedJoin) return;
    for (const argument of node.arguments) {
      const found = next(argument);
      if (found) return found;
    }
  }
}

function isWriteCall(call, context) {
  const library = context.libraryCall(call);
  if (!library || !fsModules.has(library.module)) return false;
  return writeFunctions.has((library.method ?? library.exported)?.replace(/Sync$/, ''));
}

function checkArchiveWrite(call, context) {
  if (!importsArchiveLibrary(context.sourceFile) || !isWriteCall(call, context)) return;
  const [target] = call.arguments;
  if (!target || !entryName(target, context.checker)) return;
  const carriesEntryName = (node) => Boolean(entryName(node, context.checker));
  if (hasValidationEvidence(call, target, carriesEntryName, context.checker, notContainmentChecks)) return;
  context.report(call, ruleId, message);
}

module.exports = { ruleId, checkArchiveWrite };
