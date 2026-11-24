// `ts.stringToToken` exists at run time but is missing from the published typings. Types only:
// nothing imports this file; the compiler picks the declaration up by including it.
import type { SyntaxKind } from 'typescript';

declare module 'typescript' {
  function stringToToken(text: string): SyntaxKind | undefined;
}
