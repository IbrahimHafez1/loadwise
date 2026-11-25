import type { RulePolicy } from '../../shared/types.js';
import type { ParallelReadGroups } from './parallel-reads.js';

/** The project policy once validated: `parallelReads` is already indexed by module and export. */
export interface PerformancePolicy extends RulePolicy {
  parallelReads?: ParallelReadGroups;
}
