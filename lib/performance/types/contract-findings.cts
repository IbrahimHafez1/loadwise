// What the contract comparers (OpenAPI, GraphQL, DTO classes) report and what `contracts` hands
// them.

/** Which version of a file a finding's line belongs to: removals point at the base version. */
export type ContractSide = 'old' | 'new';

/** How a controller uses a class: as a request body or as a response. */
export type ContractRole = 'input' | 'output';

/** A breaking change found by comparing two versions of one file. */
export interface ContractFinding {
  ruleId: string;
  side: ContractSide;
  line: number;
  column: number;
  message: string;
}

/** Compares the base text with the working-tree text of one file. */
export type ContractCompare = (oldText: string, newText: string) => ContractFinding[];

/** A relative module read from the working tree or the base commit. */
export interface ModuleSource {
  file: string;
  text: string;
}

export type ModuleReader = (side: ContractSide, fromFile: string, specifier: string) => ModuleSource | null;
