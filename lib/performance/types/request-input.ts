import type { Expression, Node, ParameterDeclaration } from 'typescript';

/**
 * A request field a value is computed from: the field's name, where it is read, and the schema
 * validating it.
 */
export interface InputSource {
  name: string | undefined;
  node: Node;
  schema?: Expression;
}

/** What a source callback adds to a parameter it accepts, next to the schema that validates it. */
export interface InputSchema {
  schema?: Expression;
}

/**
 * Says whether reading `node` off a parameter counts as an input, and which schema validates it.
 * `Extra` carries what a caller wants to know about the parameter, such as its position; it comes
 * back on every traced source.
 */
export type InputSourceOf<Extra extends object = object> = (
  parameter: ParameterDeclaration,
  node: Node,
) => (Extra & InputSchema) | undefined;
