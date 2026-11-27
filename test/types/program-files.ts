import assert from 'node:assert/strict';
import path from 'node:path';
import type { Program, SourceFile } from 'typescript';
import type { ProgramAdapter } from '../../lib/shared/types.js';

/** The source file of a program by path; the test expects the program to contain it. */
export function sourceFileOf(program: ProgramAdapter, file: string): SourceFile {
  const wanted = path.normalize(file);
  const found = program.getSourceFiles?.().find((sourceFile) => path.normalize(sourceFile.fileName) === wanted);
  assert.ok(found, 'expected the program to contain ' + file);
  return found;
}

function isTypeScriptProgram(program: ProgramAdapter): program is Program {
  return 'getSemanticDiagnostics' in program;
}

/** The TypeScript program behind an adapter, for tests that ask the compiler for diagnostics. */
export function typeScriptProgramOf(program: ProgramAdapter): Program {
  assert.ok(isTypeScriptProgram(program), 'expected a TypeScript program');
  return program;
}

/**
 * The source file of a program whose path ends with the given file name; the test expects the
 * program to contain it.
 */
export function sourceFileEndingWith(program: ProgramAdapter, filename: string): SourceFile {
  const found = program.getSourceFiles?.().find((item) => item.fileName.replaceAll('\\', '/').endsWith('/' + filename));
  assert.ok(found, 'expected the program to contain ' + filename);
  return found;
}
