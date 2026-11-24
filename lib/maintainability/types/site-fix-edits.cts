import type { TextEdit } from '../../shared/types.cjs';

/** An edit that also says how many branches, conditions or statements it removes. */
export interface CountedEdit extends TextEdit {
  removed: number;
}

/**
 * An edit that may delete the jump a rewritten branch ended with, which the hunk size must allow
 * for.
 */
export interface JumpRemovingEdit extends TextEdit {
  removesTrailingJump?: boolean;
}
