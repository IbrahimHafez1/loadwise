import type { Expression } from 'typescript';

/**
 * `schema.parse(input)` and friends: the schema, the input it checks, and the result field holding
 * the parsed value.
 */
export interface SchemaCall {
  schema: Expression;
  input: Expression;
  wrapper?: string;
}
