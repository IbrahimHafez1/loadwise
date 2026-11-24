import assert from 'node:assert/strict';
import type { SourceFile } from 'typescript';
import type { ProgramAdapter } from '../../lib/shared/types.cjs';

// The first source file of the program the predicate accepts; the test fails when there is none.
export function findSourceFile(program: ProgramAdapter, matches: (file: SourceFile) => boolean): SourceFile {
  assert.ok(program.getSourceFiles, 'the program should list its source files');
  const found = program.getSourceFiles().find(matches);
  assert.ok(found, 'expected the program to contain the source file');
  return found;
}
