import type { FixChange } from '../../shared/types.cjs';

// What the unused-module rules know about one source file's imports and exports.

/** `'all'` for a namespace or side-effect use of a module, otherwise the names taken from it. */
export type ImportedNames = 'all' | readonly string[];

export interface ModuleImport {
  to: string;
  names: ImportedNames;
}

/** A bare specifier that did not resolve, which may still name a workspace package. */
export interface UnresolvedImport {
  specifier: string;
  names: ImportedNames;
}

export interface ReexportPair {
  exported: string;
  local: string;
}

/** `export * from`, `export * as name from`, or `export { a as b } from`. */
export interface ModuleReexport {
  to: string;
  star?: boolean;
  namespace?: string;
  pairs?: readonly ReexportPair[];
}

/**
 * A non-literal import or require; `directory` is where it can load from, undefined when anywhere.
 */
export interface DynamicLoadSite {
  line: number;
  column: number;
  directory?: string;
}

export interface UncertainTypeImport {
  specifier: string;
  names: ImportedNames;
}

export interface ExportedName {
  name: string;
  line: number;
  column: number;
  exposedBy?: readonly string[];
  makePrivate?: FixChange;
  forwardsImportedType?: boolean;
  runtime?: boolean;
  needsCompiler?: boolean;
  usedInModule?: boolean;
}

/**
 * A declaration file's usage carries only the import side, so the export-side members are optional.
 */
export interface DeclarationUsage {
  imports: readonly ModuleImport[];
  unresolved: readonly UnresolvedImport[];
  reexports: readonly ModuleReexport[];
  uncertainTypeImports?: readonly UncertainTypeImport[];
  uncertainRuntimeImports?: readonly string[];
}

export interface ModuleUsage extends DeclarationUsage {
  executable: boolean;
  reportsCliFailure: boolean;
  exports: readonly ExportedName[];
  dynamicUnresolved: readonly DynamicLoadSite[];
  exportEquals: boolean;
}
