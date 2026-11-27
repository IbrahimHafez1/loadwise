import type { ClassElement, Statement } from 'typescript';

/** A declaration beside the helper: a class member or a statement of the file. */
export type SiblingDeclaration = ClassElement | Statement;
