import type { FolderBoundary } from './module-graph.js';

/**
 * Thresholds for the size rules; the "maintainability" config section can override each one under "limits".
 */
export interface SizeLimits {
  largeModuleLines: number;
  largeClassMembers: number;
  longParameterCount: number;
}

/** A placement rule as written in the policy file, before it is validated. */
export interface PlacementRule {
  suffix?: unknown;
  under?: unknown;
}

/**
 * The validated `dataAccess` section: packages and project paths only approved folders may import.
 */
export interface DataAccessPolicy {
  modules: ReadonlySet<string>;
  localPaths: readonly string[];
  allowedPaths: readonly string[];
}

/** The project policy the scan modes read. */
export interface MaintainabilityPolicy {
  exclude: string[];
  boundaries: FolderBoundary[];
  placement: PlacementRule[];
  dataAccess?: DataAccessPolicy;
  limits: SizeLimits;
  /** Set by the CLI when the workspace config ignores files. */
  isIgnored?: (file: string) => boolean;
}
