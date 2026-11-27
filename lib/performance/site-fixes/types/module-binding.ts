import type { ImportDeclaration, ImportEqualsDeclaration, VariableStatement } from 'typescript';

/** The statements that bring a module in. */
export type ModuleBindingStatement = ImportDeclaration | VariableStatement | ImportEqualsDeclaration;
