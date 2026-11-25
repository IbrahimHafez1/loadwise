import { diffLines, labelledLines } from '../shared/fix-terminal.js';
import type { FindingFix } from '../shared/types.js';

function fixLines(fix: Pick<FindingFix, 'changes' | 'note'>): string[] {
  const lines: string[] = [];
  for (const change of fix.changes) {
    lines.push(`  Fix (${change.file}:${change.line}):`, ...diffLines(change.before, change.after));
  }
  if (fix.note) lines.push(...labelledLines('Note', fix.note));
  return lines;
}

export { diffLines, fixLines };
