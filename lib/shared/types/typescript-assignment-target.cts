// `ts.isAssignmentTarget` exists at run time but is missing from the published typings. Types only:
// nothing imports this file; the compiler picks the declaration up by including it.
import type { Node } from 'typescript';

declare module 'typescript' {
  function isAssignmentTarget(node: Node): boolean;
}
