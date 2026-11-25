import type { Identifier, Node, SourceFile, Statement, Symbol, TypeChecker, VariableStatement } from 'typescript';
import type { TextEdit } from '../../shared/types.cjs';
import type { FunctionWithBody } from './site-fix-nodes.cjs';

/**
 * Where the new function goes: a private method after a class member, or a function after a
 * top-level statement.
 */
export interface Placement {
  method: boolean;
  container: Node;
}

/**
 * A local variable the statement uses, with every reference and write of it in the enclosing
 * function.
 */
export interface FreeVariable {
  symbol: Symbol;
  declaration: Node;
  first: Identifier;
  references: Identifier[];
  writes: Identifier[];
}

export interface BuiltCollection {
  variable: FreeVariable;
  declarationStatement: VariableStatement;
}

/**
 * What the new function receives (`variables`) and gives back (`returned` or the collection
 * `built`).
 */
export interface DataFlow {
  returned: FreeVariable | null;
  built: BuiltCollection | undefined;
  variables: FreeVariable[];
}

export interface HelperSignature {
  name: string;
  parameters: string[];
  step: string;
}

export interface SignatureInput {
  statement: Statement;
  sourceFile: SourceFile;
  placement: Placement;
  flow: DataFlow;
  typeScript: boolean;
  checker: TypeChecker;
}

/** Everything the edits are built from, except the checker. */
export interface ExtractionPlan {
  statement: Statement;
  fn: FunctionWithBody;
  sourceFile: SourceFile;
  placement: Placement;
  flow: DataFlow;
  typeScript: boolean;
  signature: HelperSignature;
}

/** A run of edits close enough to print as one hunk. */
export interface EditGroup {
  first: number;
  last: number;
  edits: TextEdit[];
}
