'use strict';

const path = require('node:path');

// The CLI selects its compiler once, before loading the shared source rules.
let syntax;
function selectNativeSyntax(nativeSyntax) {
  if (syntax && syntax !== nativeSyntax) throw new Error('Run --native in a fresh process.');
  syntax = nativeSyntax;
}

// TypeScript 6 dropped the no-default-lib marker from its lib files, so they are recognized by location.
let defaultLibraryFolder;
function isBundledLibrary(fileName) {
  defaultLibraryFolder ??= path.dirname(module.exports.syntax.getDefaultLibFilePath({})).replaceAll('\\', '/') + '/';
  const normalized = fileName.replaceAll('\\', '/');
  return (
    normalized.startsWith(defaultLibraryFolder) &&
    /^lib\.[^/]*\.d\.ts$/.test(normalized.slice(defaultLibraryFolder.length))
  );
}

function isDefaultLibrary(checker, sourceFile) {
  if (checker.isDefaultLibrary) return checker.isDefaultLibrary(sourceFile);
  return sourceFile.hasNoDefaultLib || isBundledLibrary(sourceFile.fileName);
}

// Loads `modulePath` and the lib modules it requires as private copies that see `chosenSyntax`, so code that
// works on another compiler's nodes (site fixes parse with the bundled TypeScript) can reuse rule helpers.
function requireWithSyntax(modulePath, chosenSyntax) {
  if (module.exports.syntax === chosenSyntax) return require(modulePath);
  const libraryFolder = __dirname + path.sep;
  const isPrivate = (key) => key.startsWith(libraryFolder) && key !== __filename;
  const shared = Object.keys(require.cache).filter(isPrivate);
  const saved = shared.map((key) => [key, require.cache[key]]);
  shared.forEach((key) => delete require.cache[key]);
  const selected = syntax;
  syntax = chosenSyntax;
  try {
    return require(modulePath);
  } finally {
    syntax = selected;
    Object.keys(require.cache)
      .filter(isPrivate)
      .forEach((key) => delete require.cache[key]);
    for (const [key, cached] of saved) require.cache[key] = cached;
  }
}

module.exports = {
  get syntax() {
    return (syntax ??= require('typescript'));
  },
  isDefaultLibrary,
  selectNativeSyntax,
  requireWithSyntax,
};
