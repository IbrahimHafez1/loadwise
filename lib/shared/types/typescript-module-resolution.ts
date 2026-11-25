// TypeScript module-resolution members that exist at run time but are missing from the published
// typings: the import literals the parser collected, and the resolution a program recorded for one
// of them. Types only: nothing imports this file; the compiler picks the declaration up by
// including it.
import type { ResolutionMode, ResolvedModuleWithFailedLookupLocations, StringLiteralLike } from 'typescript';

declare module 'typescript' {
  interface SourceFile {
    imports?: readonly StringLiteralLike[];
  }
  interface Program {
    getResolvedModule(
      file: SourceFile,
      moduleName: string,
      mode: ResolutionMode,
    ): ResolvedModuleWithFailedLookupLocations | undefined;
  }
}
