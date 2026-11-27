import type { MaintainabilityPolicy } from '../../lib/maintainability/types/policy.js';
import type { PerformancePolicy } from '../../lib/performance/types/performance-policy.js';
import type { FileMap } from './project-files.js';

/** Set on a sample that is known to fail; node:test reports it as a todo instead of a failure. */
type TodoMarker = boolean | string;

/** One sample project for a performance or security fix builder. */
export interface FixVerificationCase {
  ruleId: string;
  files: FileMap;
  policy?: PerformancePolicy;
  /** Also run the checks of `loadwise perf migrations`. */
  migrations?: boolean;
  todo?: TodoMarker;
}

/** One sample project for a maintainability fix builder. */
export interface MaintainabilityVerificationCase {
  ruleId: string;
  files: FileMap;
  policy?: MaintainabilityPolicy;
  todo?: TodoMarker;
}

export type VerifyFixRequest =
  | ({ pillar: 'maintainability' } & Omit<MaintainabilityVerificationCase, 'todo'>)
  | ({ pillar: 'performance' | 'security' | 'reliability' | 'accessibility' } & Omit<FixVerificationCase, 'todo'>);
