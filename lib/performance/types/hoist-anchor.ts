// Where a hoisted line can go. Types only.
import type { ArrowFunction, Statement } from 'typescript';

/** Before this statement, which always runs the hoisted expression. */
export interface StatementAnchor {
  statement: Statement;
  arrow?: undefined;
}

/** Into the concise body of this arrow function. */
export interface ArrowAnchor {
  arrow: ArrowFunction;
  statement?: undefined;
}

export type HoistAnchor = StatementAnchor | ArrowAnchor;
