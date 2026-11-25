// TypeScript helpers that exist at run time but are missing from the published typings. Types only:
// nothing imports this file; the compiler picks the declaration up by including it.
import type { JSDoc } from 'typescript';

declare module 'typescript' {
  interface Node {
    /** The doc comments the parser attached to this node. */
    jsDoc?: readonly JSDoc[];
  }
}
