'use strict';

const path = require('node:path');
const fs = require('node:fs');
const ts = require('typescript');

// The file is checked alone against the standard library: imports stay unresolved, and the checks below treat
// their types as unknown. The library files are parsed once per process.
const libDirectory = path.dirname(require.resolve('typescript'));
const libFiles = new Map();
function libFile(fileName) {
  const full = path.join(libDirectory, path.basename(fileName));
  if (!libFiles.has(full)) {
    const text = fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : undefined;
    libFiles.set(full, text === undefined ? undefined : ts.createSourceFile(full, text, ts.ScriptTarget.Latest));
  }
  return libFiles.get(full);
}

const compilerOptions = {
  noResolve: true,
  allowJs: true,
  noEmit: true,
  strict: true,
  target: ts.ScriptTarget.ES2022,
  lib: ['lib.es2022.d.ts'],
  jsx: ts.JsxEmit.Preserve,
  types: [],
};

function programFor(sourceFile) {
  const host = {
    getSourceFile: (name) => (name === sourceFile.fileName ? sourceFile : libFile(name)),
    getDefaultLibFileName: () => path.join(libDirectory, 'lib.es2022.d.ts'),
    writeFile() {},
    getCurrentDirectory: () => '',
    getCanonicalFileName: (name) => name,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => '\n',
    fileExists: (name) => name === sourceFile.fileName || libFile(name) !== undefined,
    readFile: () => undefined,
  };
  return ts.createProgram({ rootNames: [sourceFile.fileName], options: compilerOptions, host });
}

const originalPrograms = new WeakMap();
function originalProgram(sourceFile) {
  if (!originalPrograms.has(sourceFile)) originalPrograms.set(sourceFile, programFor(sourceFile));
  return originalPrograms.get(sourceFile);
}

// Type errors of a file as `code:message` counts, so a rewrite that adds one shows up wherever it sits.
function typeErrors(sourceFile, program) {
  const counts = new Map();
  for (const diagnostic of program.getSemanticDiagnostics(sourceFile)) {
    const key = diagnostic.code + ':' + ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

const originalErrors = new WeakMap();
function originalTypeErrors(sourceFile) {
  if (!originalErrors.has(sourceFile))
    originalErrors.set(sourceFile, typeErrors(sourceFile, originalProgram(sourceFile)));
  return originalErrors.get(sourceFile);
}

function typeChecksAsBefore(sourceFile, rewrittenText) {
  const rewritten = ts.createSourceFile(
    sourceFile.fileName,
    rewrittenText,
    ts.ScriptTarget.Latest,
    true,
    sourceFile.scriptKind,
  );
  const before = originalTypeErrors(sourceFile);
  for (const [key, count] of typeErrors(rewritten, programFor(rewritten)))
    if (count > (before.get(key) ?? 0)) return false;
  return true;
}

module.exports = { originalProgram, typeChecksAsBefore };
