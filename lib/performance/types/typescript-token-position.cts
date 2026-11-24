// `ts.getTokenAtPosition` exists at run time but is missing from the published typings. Types only:
// nothing imports this file; the compiler picks the declaration up by including it.
import type { Node, SourceFile } from 'typescript';

declare module 'typescript' {
  function getTokenAtPosition(sourceFile: SourceFile, position: number): Node;
}
