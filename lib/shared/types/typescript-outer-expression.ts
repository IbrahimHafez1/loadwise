// `ts.isOuterExpression` exists at run time but is missing from the published typings. Types only:
// nothing imports this file; the compiler picks the declaration up by including it.
import type {
  AsExpression,
  NonNullExpression,
  Node,
  OuterExpressionKinds,
  ParenthesizedExpression,
  PartiallyEmittedExpression,
  SatisfiesExpression,
  TypeAssertion,
} from 'typescript';

declare module 'typescript' {
  function isOuterExpression(
    node: Node,
    kinds?: OuterExpressionKinds,
  ): node is
    | ParenthesizedExpression
    | TypeAssertion
    | AsExpression
    | SatisfiesExpression
    | NonNullExpression
    | PartiallyEmittedExpression;
}
