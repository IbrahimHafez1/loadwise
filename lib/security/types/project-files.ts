/**
 * Whether a file is outside the scan: ignored by the project's ignore rules, or not one of the
 * changed files.
 */
export type PathPredicate = (absolute: string) => boolean;

/** The files of a project for the file checks. */
export interface ProjectFiles {
  /** Absolute paths. */
  files: string[];
  /** Whether the files come from git. */
  tracked: boolean;
  /**
   * Files directly in the git top-level above the project, where a monorepo keeps shared
   * configuration.
   */
  topLevelFiles: string[];
  /** Git pathspecs for ignored folders, so a repository-wide search can skip them. */
  exclusions?: Set<string>;
}
