/**
 * One `parallelReads` policy group: a module and the named exports of it that may be started
 * together.
 */
export interface ParallelReadGroup {
  from: string;
  exports: string[];
}

/**
 * The validated groups, by module and then by exported name; a name can belong to several groups.
 */
export type ParallelReadGroups = Map<string, Map<string, Set<ParallelReadGroup>>>;
