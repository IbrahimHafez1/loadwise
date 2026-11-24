import type { ModuleImport } from './module-usage.cjs';

/** Files that runbooks and container commands name, split by how strong the evidence is. */
export interface OperatorScripts {
  commands: ReadonlySet<string>;
  mentions: ReadonlySet<string>;
}

/**
 * What the scan learned about which files tools, frameworks or people run without importing them.
 */
export interface EntryPoints {
  isEntryPoint(file: string): boolean;
  isToolingFile(file: string): boolean;
  isPrivateApplication(file: string): boolean;
  operatorScripts: OperatorScripts;
  siblingUsages: ModuleImport[];
  workspacePackages: ReadonlyMap<string, string>;
}
