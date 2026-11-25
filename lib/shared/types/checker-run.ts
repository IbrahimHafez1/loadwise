import type { Pillar } from '../types.js';
import type { PillarName } from './pillar-name.js';
import type { FormatReport } from './report-formats.js';

/** What a checker run as a child process left behind. */
export interface ChildRun {
  code: number;
  stdout: string;
  stderr: string;
}

/** What `loadwise check` hands each pillar. */
export interface PillarRunOptions {
  directory: string;
  flags: string[];
  workspaces: readonly string[];
  relative: (target: string) => string;
  online?: boolean;
  contractFlags?: string[];
}

/** A checker `loadwise check` can run. */
export interface PillarDefinition {
  name: Pillar;
  title: string;
  jsonKey: PillarName;
  ruleIds(): ReadonlySet<string>;
  /** The folder the checker's finding paths are relative to. */
  findingRoot(directory: string): string;
  /**
   * Resolves to the child's run, or to undefined when the pillar does not apply to the directory.
   */
  run(options: PillarRunOptions): Promise<ChildRun | undefined>;
}

/** The scan reports a checker prints with `--json`. */
export interface CheckerReport extends FormatReport {
  [detail: string]: unknown;
}
