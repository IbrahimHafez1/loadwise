// Stable finding ids let an agent or a script name one finding across runs. The id hashes the rule,
// the file and the flagged line's text, never the line number, so it survives edits above the
// finding.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Finding } from '../shared/types.js';

const idLength = 12;

// Finding files are relative to the scanned root.
type LineReader = (file: string, line: number) => string;

function createLineReader(root: string): LineReader {
  const files = new Map<string, string[]>();
  return function lineText(file, line) {
    const absolute = path.resolve(root, file);
    if (!files.has(absolute)) {
      let lines: string[] = [];
      try {
        lines = fs.readFileSync(absolute, 'utf8').split(/\r?\n/);
      } catch {
        // An unreadable file still gets an id from the rule and the path.
      }
      files.set(absolute, lines);
    }
    return (files.get(absolute)?.[line - 1] ?? '').trim();
  };
}

function hashParts(parts: readonly string[]): string {
  return crypto.createHash('sha1').update(parts.join('\0')).digest('hex').slice(0, idLength);
}

function baseFindingId(finding: Finding, root: string, lineText: LineReader): string {
  const file = finding.file ?? '';
  const relative = path.relative(root, path.resolve(root, file)).split(path.sep).join('/');
  return hashParts([finding.ruleId, relative, lineText(file, finding.line ?? 0)]);
}

// Identical findings on identical lines share a hash; later ones get -2, -3 and so on, in output
// order.
function assignFindingIds(findings: Finding[], root: string): Finding[] {
  const lineText = createLineReader(root);
  const seen = new Map<string, number>();
  for (const finding of findings) {
    const base = baseFindingId(finding, root, lineText);
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    finding.id = count === 1 ? base : `${base}-${count}`;
  }
  return findings;
}

export { assignFindingIds };
