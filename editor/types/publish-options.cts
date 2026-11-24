import type { DismissalEntry } from './dismissal.cjs';

/** How a published report is filtered and graded. */
export interface PublishOptions {
  isDismissed?(entry: DismissalEntry): boolean;
  /** The loadwise.severity setting: one level for every finding, or 'default'. */
  severity?: string;
}
