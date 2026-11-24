import type { PropertyAssignment, ShorthandPropertyAssignment } from 'typescript';

/** An object literal property whose name is known: `name: value` or the shorthand `name`. */
export type PlainProperty = PropertyAssignment | ShorthandPropertyAssignment;
