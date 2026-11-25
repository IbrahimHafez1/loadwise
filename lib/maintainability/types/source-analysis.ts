import type { Finding } from '../../shared/types.js';
import type { DataAccessPolicy, SizeLimits } from './policy.js';
import type { ExtractedImplementations } from './duplicates.js';
import type { ModuleEdge } from './module-graph.js';
import type { ModuleUsage } from './module-usage.js';
import type { SourceFacts } from './source-facts.js';

/**
 * A file's size on disk and whether it was UTF-16, which later steps need to treat it as the disk
 * does.
 */
export interface DiskFacts {
  size: number;
  utf16?: boolean;
}

/** One file as read from disk; `text` is undefined when it could not be read. */
export type SourceRead =
  (DiskFacts & { text: string | undefined }) | { text: undefined; size?: undefined; utf16?: undefined };

/** What `analyzeSource` needs besides the file itself. */
export interface AnalysisOptions {
  dataAccess?: DataAccessPolicy;
  limits?: SizeLimits;
  indexIdentifiers?: boolean;
  disk?: SourceRead;
}

/** A file that does not parse: its imports are still read from the recovered tree. */
export interface UnparsableSource {
  parseError: string;
  usage: ModuleUsage;
  facts: SourceFacts;
  failure?: undefined;
}

/**
 * Everything computed from one parsed source file, as plain data so it can cross a thread boundary.
 */
export interface AnalyzedSource {
  parseError?: undefined;
  failure?: undefined;
  generated: boolean;
  duplicates: ExtractedImplementations | undefined;
  findings: Finding[];
  edges: ModuleEdge[];
  constEnums: string[];
  usage: ModuleUsage;
  facts: SourceFacts;
}

/** A file a worker thread could not analyse, with the reason. */
export interface FailedSource {
  failure: string;
  parseError?: undefined;
  facts?: undefined;
}

export type SourceAnalysis = UnparsableSource | AnalyzedSource | FailedSource;
