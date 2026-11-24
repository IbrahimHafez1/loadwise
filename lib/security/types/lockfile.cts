/** The lockfile parts a finding reports: where it is and which package manager owns it. */
export interface Lockfile {
  filename: string;
  /** `npm`, `pnpm` or `yarn`. */
  manager: string;
}

/** One package@version a lockfile pins. */
export interface LockfilePackage {
  name: string;
  version: string;
  /** Declared by a project manifest rather than reached through another package. */
  direct: boolean;
  /** Development-only in every occurrence. */
  dev: boolean;
  line: number;
  manifestDirectories: string[];
}
