'use strict';

// Stable finding ids let an agent or a script name one finding across runs. The id hashes the rule, the file and the
// flagged line's text, never the line number, so it survives edits above the finding.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const idLength = 12;

// Finding files are relative to the scanned root.
function createLineReader(root) {
  const files = new Map();
  return function lineText(file, line) {
    const absolute = path.resolve(root, file);
    if (!files.has(absolute)) {
      let lines = [];
      try {
        lines = fs.readFileSync(absolute, 'utf8').split(/\r?\n/);
      } catch {
        // An unreadable file still gets an id from the rule and the path.
      }
      files.set(absolute, lines);
    }
    return (files.get(absolute)[line - 1] ?? '').trim();
  };
}

function hashParts(parts) {
  return crypto.createHash('sha1').update(parts.join('\0')).digest('hex').slice(0, idLength);
}

function baseFindingId(finding, root, lineText) {
  const relative = path.relative(root, path.resolve(root, finding.file)).split(path.sep).join('/');
  return hashParts([finding.ruleId, relative, lineText(finding.file, finding.line)]);
}

// Identical findings on identical lines share a hash; later ones get -2, -3 and so on, in output order.
function assignFindingIds(findings, root) {
  const lineText = createLineReader(root);
  const seen = new Map();
  for (const finding of findings) {
    const base = baseFindingId(finding, root, lineText);
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    finding.id = count === 1 ? base : `${base}-${count}`;
  }
  return findings;
}

module.exports = { assignFindingIds };
