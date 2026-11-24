import type { Finding } from '../../shared/types.cjs';

export type ImportKind = 'eager' | 'deferred';

/** One import between two project files, as the graph rules see it. */
export interface ModuleEdge {
  from: string;
  to: string;
  line: number;
  column: number;
  kind?: ImportKind;
  nestForwardRef?: boolean;
  constEnumNames?: readonly string[];
}

/** A folder whose files must not import from the listed folders. */
export interface FolderBoundary {
  from: string;
  disallow: readonly string[];
}

/** The names each file exports that are backed only by const enums. */
export type ConstEnumExports = ReadonlyMap<string, readonly string[]>;

/** A graph finding always points at a location. */
export interface LocatedFinding extends Finding {
  file: string;
  line: number;
  column: number;
}
