import type { Program } from 'typescript';
import type { ProgramAdapter, SkippedFile } from '../../shared/types.js';
import type { PerformancePolicy } from './performance-policy.js';
import type { SourceAnalyzer } from './source-analyzer.js';

/** What `analyzeProgram` scans and how; everything but the program has a default. */
export interface ProgramScanOptions {
  program: Program;
  /** The root files to report on; defaults to all of the program's roots. */
  inputs?: readonly string[];
  /** Canonical names of files already scanned, shared across programs. */
  scanned?: Set<string>;
  policy?: PerformancePolicy;
  forEachSourceCandidate?: ProgramAdapter['forEachSourceCandidate'];
  unresolvedPackages?: Set<string>;
  analyzers?: SourceAnalyzer[];
  /** Where unparsable files are recorded; without it they throw. */
  skippedFiles?: SkippedFile[];
}
