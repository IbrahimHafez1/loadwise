import type { Expression } from 'typescript';

/** A batch sibling of a single keyed read. */
export interface ReadBatch {
  kind: 'read';
  itemIndex: number;
  parameterNames: string[];
  listName: string;
  lines: string[];
  bare: boolean;
  single: boolean;
  needsIn: boolean;
  note: string;
}

/** A batch sibling of a single write. */
export interface WriteBatch {
  kind: 'write';
  receiver: string;
  parameterNames: string[];
  batchCall: (list: string, parameter: string) => string;
  handler: Expression | undefined;
  used: string[];
  typed: boolean;
}

export type BatchPlan = ReadBatch | WriteBatch;
