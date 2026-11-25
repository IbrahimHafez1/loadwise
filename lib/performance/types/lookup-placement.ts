import type { Node } from 'typescript';
import type { TextEdit } from '../../shared/types.js';

// Where a lookup is built: the code that then runs after it, that code's indentation, and the edits
// inserting the lines.
export interface Placement {
  region: Node;
  indentation: string;
  edits: (...lines: string[]) => TextEdit[];
}
