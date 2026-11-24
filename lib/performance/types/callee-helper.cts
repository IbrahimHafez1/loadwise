import type { SourceFile } from 'typescript';
import type { LoadedFile } from '../../shared/types.cjs';
import type { HelperFunction } from './helper-function.cjs';

/** The helper declaration the findings point at, with the file that holds it. */
export interface CalleeHelper {
  entry: LoadedFile & { sourceFile: SourceFile };
  declaration: HelperFunction;
}
