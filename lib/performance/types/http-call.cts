// How an outgoing HTTP call is written: which library it uses and where its options and limits
// live.
import type { Identifier } from 'typescript';

export type HttpLibrary = 'fetch' | 'axios';

export interface HttpCallDescription {
  library: HttpLibrary;
  /** The `fetch` or `axios` identifier the call goes through. */
  receiver: Identifier;
  /** Which argument holds the options object. */
  optionsIndex: number;
  /** Option keys that put a limit on the call. */
  limitKeys: readonly string[];
  /** The option a fix adds to give the call a limit. */
  limitProperty: string;
}
