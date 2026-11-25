import assert from 'node:assert/strict';
import type { SourceFile } from 'typescript';
import type { NativeProgram } from '../../lib/performance/types/native-typescript.js';

/** The source file of a native program, which the test expects to exist. */
export function requireNativeSourceFile(program: NativeProgram, fileName: string): SourceFile {
  const sourceFile = program.getSourceFile(fileName);
  assert.ok(sourceFile, `the native program should contain ${fileName}`);
  return sourceFile;
}
