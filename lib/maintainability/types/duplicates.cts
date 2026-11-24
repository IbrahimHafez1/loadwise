import type { SourceFile } from 'typescript';
import type { LocatedFinding } from './module-graph.cjs';

/** One function body reduced to its comparison key and where it is declared. */
export interface Implementation {
  key: string;
  line: number;
  column: number;
}

/**
 * What one source file contributes to duplicate detection, as plain data that can cross a thread
 * boundary.
 */
export interface ExtractedImplementations {
  implementations: Implementation[];
  documentsReference: boolean;
}

/** Groups identical implementations across files and reports each group once. */
export interface ImplementationIndex {
  addExtracted(relativePath: string, extracted: ExtractedImplementations | undefined): void;
  add(file: SourceFile, relativePath: string): void;
  findings(): LocatedFinding[];
}
