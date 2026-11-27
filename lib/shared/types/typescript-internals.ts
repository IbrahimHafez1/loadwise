// TypeScript helpers that exist at run time but are missing from the published typings. Types only:
// nothing here exists at runtime, so nothing imports this file; the compiler picks the declaration
// up by including it.
import type { Expression, Node, OuterExpressionKinds } from 'typescript';

declare module 'typescript' {
  function skipOuterExpressions(node: Expression, kinds?: OuterExpressionKinds): Expression;
  function skipOuterExpressions(node: Node, kinds?: OuterExpressionKinds): Node;
  function isDeclarationName(name: Node): boolean;
}
