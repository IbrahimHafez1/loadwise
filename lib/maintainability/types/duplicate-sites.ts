import type { Block, FunctionDeclaration, Identifier, ImportDeclaration, SourceFile, StringLiteral } from 'typescript';
import type { LoadedFile } from '../../shared/types.js';
import type { FunctionWithBody } from './site-fix-nodes.js';

/** A function whose body is a block, so its statements can be replaced. */
export type BlockBodiedFunction = FunctionWithBody & { readonly body: Block };

/** A top-level function declaration with a name and a body. */
export type NamedFunctionDeclaration = FunctionDeclaration & { readonly name: Identifier; readonly body: Block };

/** One function a duplicate-implementation finding points at, with the file it was parsed from. */
export interface DuplicateSite {
  file: string;
  entry: LoadedFile;
  sourceFile: SourceFile;
  fn: BlockBodiedFunction;
}

/** A named function declaration and the file that holds it. */
export interface FunctionInFile {
  fn: NamedFunctionDeclaration;
  sourceFile: SourceFile;
}

/** A duplicate site that can serve as the one shared implementation. */
export interface NamedFunctionSite extends DuplicateSite {
  fn: NamedFunctionDeclaration;
}

/** An import whose module specifier is a string literal. */
export interface StringLiteralImport extends ImportDeclaration {
  moduleSpecifier: StringLiteral;
}
