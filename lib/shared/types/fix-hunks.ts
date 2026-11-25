import type { TextEdit } from '../types.js';

/** An edit; a why-comment insertion is flagged `comment` and never widens a hunk. */
export interface CommentableEdit extends TextEdit {
  comment?: boolean;
}
