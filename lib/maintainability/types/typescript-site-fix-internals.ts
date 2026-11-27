// TypeScript helpers that exist at run time but are missing from the published typings. Types only:
// nothing imports this file; the compiler picks the declaration up by including it.
export {};

declare module 'typescript' {
  interface TypeChecker {
    isArrayLikeType(type: Type): boolean;
  }
  interface SourceFile {
    scriptKind: ScriptKind;
    /** The block-scoped names of the file; set once the binder has run. */
    // oxlint-disable-next-line typescript/no-wrapper-object-types -- inside this augmentation, Symbol is the compiler's own Symbol interface, not the global wrapper
    locals?: Map<__String, Symbol>;
  }
  /** A string-literal statement at the top of a body, such as 'use strict'. */
  interface PrologueDirective extends ExpressionStatement {
    expression: StringLiteral;
  }
  function isPrologueDirective(node: Node): node is PrologueDirective;
  function isAssignmentOperator(token: SyntaxKind): boolean;
  function skipParentheses(node: Expression, excludeJSDocTypeAssertions?: boolean): Expression;
}
