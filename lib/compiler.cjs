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

module.exports = {
  get syntax() {
    return (syntax ??= require('typescript'));
  },
  isDefaultLibrary,
  selectNativeSyntax,
};
