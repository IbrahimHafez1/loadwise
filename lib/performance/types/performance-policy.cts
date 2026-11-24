import type { RulePolicy } from '../../shared/types.cjs';
import type { ParallelReadGroups } from './parallel-reads.cjs';

/** The project policy once validated: `parallelReads` is already indexed by module and export. */
export interface PerformancePolicy extends RulePolicy {
  parallelReads?: ParallelReadGroups;
}
