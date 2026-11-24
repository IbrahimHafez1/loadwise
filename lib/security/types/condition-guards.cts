import type { Expression } from 'typescript';

/** Whether an expression is the value a guard protects, and nothing else. */
export type SubjectTest = (expression: Expression) => boolean;

/** Whether a condition, taken as true or false, is evidence of the property a caller looks for. */
export type EvidenceTest = (condition: Expression, truth: boolean) => boolean;
