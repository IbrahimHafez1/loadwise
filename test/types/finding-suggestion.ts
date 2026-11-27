import type { Finding } from '../../lib/shared/types.js';

// The suggestion text of a finding, or an empty string when it carries none.
export function suggestionOf(finding: Finding): string {
  return typeof finding.suggestion === 'string' ? finding.suggestion : '';
}
