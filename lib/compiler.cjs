'use strict';

// The CLI selects its compiler once, before loading the shared source rules.
let syntax;
function selectNativeSyntax(nativeSyntax) {
  if (syntax && syntax !== nativeSyntax) throw new Error('Run --native in a fresh process.');
  syntax = nativeSyntax;
}

function isDefaultLibrary(checker, sourceFile) {
  return checker.isDefaultLibrary ? checker.isDefaultLibrary(sourceFile) : sourceFile.hasNoDefaultLib;
}

module.exports = {
  get syntax() { return syntax ??= require('typescript'); },
  isDefaultLibrary, selectNativeSyntax,
};
