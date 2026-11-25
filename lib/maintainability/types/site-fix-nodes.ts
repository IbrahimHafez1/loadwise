import type { Block, Expression, FunctionLikeDeclaration, Identifier, ParameterDeclaration } from 'typescript';

/**
 * A function, method or arrow whose body is present, so a site fix can rewrite statements inside
 * it.
 */
export type FunctionWithBody = FunctionLikeDeclaration & { readonly body: Block | Expression };

/** A parameter written as a plain name, so its name has text. */
export type IdentifierParameter = ParameterDeclaration & { readonly name: Identifier };
