import type { SourceAnalyzer } from '../../lib/performance/types/source-analyzer.js';

/** A tsconfig.json body written next to the fixture files. */
export interface FixtureTsconfig {
  compilerOptions?: Record<string, string | number | boolean | readonly string[] | Record<string, readonly string[]>>;
  include?: readonly string[];
  files?: readonly string[];
  [option: string]: unknown;
}

export interface ScanWithFixesOptions {
  tsconfig?: FixtureTsconfig;
  analyzers?: SourceAnalyzer[];
}

/** The before/after text of a single fix change, dedented. */
export interface FixSides {
  before: string;
  after: string;
}
