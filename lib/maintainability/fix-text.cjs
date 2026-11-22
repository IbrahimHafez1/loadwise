'use strict';

const { diffLines, labelledLines } = require('../shared/fix-terminal.cjs');

function fixLines(fix) {
  const lines = [];
  for (const change of fix.changes) {
    lines.push(`  Fix (${change.file}:${change.line}):`, ...diffLines(change.before, change.after));
  }
  if (fix.note) lines.push(...labelledLines('Note', fix.note));
  return lines;
}

module.exports = { diffLines, fixLines };
