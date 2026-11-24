import type { Finding } from '../../shared/types.cjs';

/** What a project-file check knows about one finding before its rule id is attached. */
export interface FileFindingBody {
  line: number;
  column?: number;
  message: string;
  contextualReason?: string;
}

/** A finding of a project-file check (env, Dockerfile, compose): always positioned by line. */
export interface FileFinding extends Finding {
  ruleId: string;
  line: number;
  message: string;
}
