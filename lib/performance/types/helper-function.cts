import type { Block, FunctionDeclaration, Identifier, MethodDeclaration, PropertyName } from 'typescript';

/**
 * A helper whose body holds the per-item query: a method or function with a name and a block body.
 */
export type HelperFunction = (MethodDeclaration | FunctionDeclaration) & {
  name: PropertyName | Identifier;
  body: Block;
};
