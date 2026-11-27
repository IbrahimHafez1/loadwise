import type {
  ArrowFunction,
  BinaryExpression,
  Expression,
  FunctionExpression,
  Identifier,
  Node,
  ObjectLiteralElementLike,
  ParameterDeclaration,
  PropertyAccessExpression,
  TupleTypeNode,
  TypeOperatorNode,
  VariableDeclaration,
} from 'typescript';
import type { SymbolAdapter, TypeAdapter } from '../../shared/types.js';
import type { FindLookupFacts } from './find-lookup-facts.js';

/**
 * What a loop or callback writes to the bindings it can reach, for proving a lookup array stays
 * unchanged.
 */
export interface WrittenBindings {
  mutated: Set<SymbolAdapter | undefined>;
  /** The earliest position at which a binding is handed to a callee that could change it. */
  passed: Map<SymbolAdapter | undefined, number>;
  /**
   * Each reassigned binding and its only assignment target; undefined once it is assigned more than
   * once.
   */
  reassigned: Map<SymbolAdapter | undefined, Identifier | undefined>;
  aliases: Set<string>;
}

export type BoundFunction = (child: Expression | undefined) => number;
export type CallbackFunction = ArrowFunction | FunctionExpression;
export type ReadonlyTuple = TypeOperatorNode & { type: TupleTypeNode };
export type ConstantDeclaration = VariableDeclaration & { initializer: Expression };
export type IdentifierParameter = ParameterDeclaration & { name: Identifier };

/** A const declaration nobody changes before the use, with the scope that holds it. */
export interface UnchangedConstant {
  binding: ConstantDeclaration;
  scope: Node;
  imported: boolean;
}

/**
 * `find((item) => item.key === probe)`: the `===` comparison and the predicate's single item
 * parameter.
 */
export interface FindComparison {
  innerBinding: IdentifierParameter;
  comparison: BinaryExpression;
}

/** The item side, its key path after the parameter, and the probe of such a comparison. */
export interface FindKeySides {
  parameter: IdentifierParameter;
  item: PropertyAccessExpression;
  path: string;
  probe: Expression;
}

/** A type that can list its properties; the shared type adapter does not declare the method. */
export interface TypeWithProperties extends TypeAdapter {
  getProperties(): readonly SymbolAdapter[];
}

/** A copy of an accumulator target that adds properties through Object.assign. */
export interface ObjectAssignCopy {
  copied: Expression;
  properties: ObjectLiteralElementLike[];
}

export type FindDetails = { narrowsFindResult: true } | { findLookup: FindLookupFacts };
