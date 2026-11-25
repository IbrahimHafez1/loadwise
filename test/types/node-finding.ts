import type { Node } from 'typescript';
import type { Finding } from '../../lib/shared/types.js';

/** A finding recorded by a fake rule context, keeping the node it was reported on. */
export interface NodeFinding extends Finding {
  node: Node;
}
