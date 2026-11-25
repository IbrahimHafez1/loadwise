import type { AnalysisOptions, SourceAnalysis } from './source-analysis.js';

/** What the scan hands each worker thread when it starts it. */
export interface ScanWorkerData {
  root: string;
  jsFiles: readonly string[];
  analysisOptions: AnalysisOptions;
}

/** A batch of project-relative files, starting at position `batch` of the scan's file list. */
export interface BatchRequest {
  batch: number;
  files: string[];
}

/** The analyses of one batch, in the order the files were sent. */
export interface BatchReply {
  batch: number;
  results: SourceAnalysis[];
}
