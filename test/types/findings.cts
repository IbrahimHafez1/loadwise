import type { Finding, FindingFix } from '../../lib/shared/types.cjs';

/** A finding that carries an automatic fix. */
export type FixableFinding = Finding & { fix: FindingFix };

export function hasFix(finding: Finding): finding is FixableFinding {
  return finding.fix !== undefined;
}
