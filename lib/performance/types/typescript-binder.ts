// TypeScript internals the migration extractor relies on: running the binder on a bare syntax tree
// fills every scope's
// `locals`, which resolves a name to its declaration without building a program. Types only:
// nothing imports this file; the compiler picks the declaration up by including it.
import type { __String, CompilerOptions, SourceFile } from 'typescript';

declare module 'typescript' {
  interface Node {
    /** The names declared directly in this scope; set once the binder has run. */
    locals?: Map<__String, Symbol>;
  }
  interface Symbol {
    exportSymbol?: Symbol;
  }
  function bindSourceFile(file: SourceFile, options: CompilerOptions): void;
}
