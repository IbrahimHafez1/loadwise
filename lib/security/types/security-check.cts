import type { Node } from 'typescript';
import type { SecurityRuleContext } from '../../shared/types.cjs';

/**
 * One security check. Declared through a method so a check may ask for a narrower node type than `Node`: the
 * analyzer only hands it nodes of the syntax kind it is registered under.
 */
interface SecurityCheckMethod {
  check(node: Node, context: SecurityRuleContext): void;
}
export type SecurityCheck = SecurityCheckMethod['check'];

/** The checks of one rule group, keyed by `ts.SyntaxKind` name. */
export interface SecurityCheckModule {
  checks: Readonly<Record<string, readonly SecurityCheck[]>>;
}
