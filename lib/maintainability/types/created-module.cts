import type { FixResult } from '../../shared/types.cjs';

/** A new module a fix writes next to the flagged file. */
export interface CreatedModule {
  file: string;
  text: string;
}

/** A fix result that may move code into a new module. */
export interface ModuleCreatingFix extends FixResult {
  createdModule?: CreatedModule;
}
