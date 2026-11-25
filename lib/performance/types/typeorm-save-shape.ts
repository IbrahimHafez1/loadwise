import type {
  Expression,
  ExpressionStatement,
  IfStatement,
  NodeArray,
  PropertyAccessExpression,
  Statement,
  VariableDeclaration,
  VariableStatement,
} from 'typescript';

export type UpdateStepKind = 'set' | 'increment' | 'decrement';

/**
 * One property write between a load and its save: `x.a = value`, `x.n += value`, `x.n -= value` or
 * `x.n++`.
 */
export interface UpdateStep {
  statement: Statement;
  kind: UpdateStepKind;
  access: PropertyAccessExpression;
  field: string;
  value: Expression | undefined;
}

/** `if (!x) throw ...` or `if (!x) return ...` with nothing else. */
export interface NullGuard {
  statement: IfStatement;
  throws: boolean;
}

/** A null guard together with its position among the statements. */
export interface IndexedNullGuard extends NullGuard {
  index: number;
}

/** `const x = await repo.findOne({ where: W })`. */
export interface EntityLoad {
  statement: VariableStatement;
  declaration: VariableDeclaration;
  method: string;
  where: Expression;
}

/** The syntactic shape of `load; assign...; await repo.save(x)` around a save call. */
export interface LoadThenSaveShape extends EntityLoad {
  repositoryText: string;
  name: string;
  saveStatement: ExpressionStatement;
  saveIndex: number;
  loadIndex: number;
  statements: NodeArray<Statement>;
  steps: UpdateStep[];
  guards: IndexedNullGuard[];
}
