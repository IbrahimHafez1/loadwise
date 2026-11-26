import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as ts from 'typescript';
import type { CompilerHost, CompilerOptions, Program, SourceFile } from 'typescript';

// The file is checked alone against the standard library: imports stay unresolved, and the checks
// below treat their types as unknown. The library files are parsed once per process.
const libDirectory = path.dirname(fileURLToPath(import.meta.resolve('typescript')));
const libFiles = new Map<string, SourceFile | undefined>();
function libFile(fileName: string): SourceFile | undefined {
  const full = path.join(libDirectory, path.basename(fileName));
  if (!libFiles.has(full)) {
    const text = fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : undefined;
    libFiles.set(full, text === undefined ? undefined : ts.createSourceFile(full, text, ts.ScriptTarget.Latest));
  }
  return libFiles.get(full);
}

const compilerOptions: CompilerOptions = {
  noResolve: true,
  allowJs: true,
  noEmit: true,
  strict: true,
  target: ts.ScriptTarget.ES2022,
  lib: ['lib.es2022.d.ts'],
  jsx: ts.JsxEmit.Preserve,
  types: [],
};

let previousProgram: WeakRef<Program> | undefined;

function programFor(sourceFile: SourceFile): Program {
  const host: CompilerHost = {
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
  const program = ts.createProgram({
    rootNames: [sourceFile.fileName],
    options: compilerOptions,
    host,
    oldProgram: previousProgram?.deref(),
  });
  previousProgram = new WeakRef(program);
  return program;
}

const originalPrograms = new WeakMap<SourceFile, Program>();
function originalProgram(sourceFile: SourceFile): Program {
  let program = originalPrograms.get(sourceFile);
  if (!program) {
    program = programFor(sourceFile);
    originalPrograms.set(sourceFile, program);
  }
  return program;
}

// Type errors of a file as `code:message` counts, so a rewrite that adds one shows up wherever it
// sits.
function typeErrors(sourceFile: SourceFile, program: Program): Map<string, number> {
  const counts = new Map<string, number>();
  for (const diagnostic of program.getSemanticDiagnostics(sourceFile)) {
    const key = diagnostic.code + ':' + ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

const originalErrors = new WeakMap<SourceFile, Map<string, number>>();
function originalTypeErrors(sourceFile: SourceFile): Map<string, number> {
  let errors = originalErrors.get(sourceFile);
  if (!errors) {
    errors = typeErrors(sourceFile, originalProgram(sourceFile));
    originalErrors.set(sourceFile, errors);
  }
  return errors;
}

function typeChecksAsBefore(sourceFile: SourceFile, rewrittenText: string): boolean {
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

export { originalProgram, typeChecksAsBefore };
