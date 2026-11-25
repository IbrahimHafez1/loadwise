import type { CallExpression, ConciseBody, FunctionLikeDeclaration, Node } from 'typescript';

/** A function the project defines, with a body to read. */
export type FunctionWithBody = FunctionLikeDeclaration & { body: ConciseBody };

export type ValidationKind = 'url' | 'path' | 'id';

/**
 * How a function validates its argument: 'throws' returns only for a valid one, 'boolean' returns
 * true only for a valid one, 'returns' hands back the validated argument or a value derived from
 * it.
 */
export type ValidationMode = 'throws' | 'boolean' | 'returns';

export interface Validation {
  parameterIndex: number;
  kind: ValidationKind;
  mode: ValidationMode;
}

/**
 * A return value that reads request input from a parameter; `path` such as 'query.next', empty for
 * a whole body.
 */
export interface RequestData {
  parameterIndex: number;
  path: string;
}

export interface EffectSite {
  file: string;
  line: number;
  column: number;
}

/** A database, cache, queue or HTTP call a function makes. */
export interface QueryFact extends EffectSite {
  kind: string;
  family: string;
  label: string;
}

/** A call that blocks the event loop. */
export interface BlockingFact extends EffectSite {
  kind: string;
  label: string;
}

/**
 * An effect reached through project calls; `via` names the functions between the summarised one and
 * the effect.
 */
export type Reached<Fact> = Fact & { via: string[] };

export interface FunctionSummary {
  declaration: FunctionWithBody;
  readonly queries: Reached<QueryFact>[];
  readonly blocking: Reached<BlockingFact>[];
  /** False when the call depth bound left project functions that do work unvisited. */
  readonly complete: boolean;
  readonly validates: Validation[];
  readonly returnsRequestData: RequestData | undefined;
}

export interface FunctionSummaries {
  summaryOf(declaration: Node | undefined): FunctionSummary | undefined;
  summaryOfCall(call: CallExpression): FunctionSummary | undefined;
  calleeOf(call: CallExpression): FunctionWithBody | undefined;
}
