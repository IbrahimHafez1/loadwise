// `// loadwise-reviewed <rule-id> -- <reason>` on the line above a finding records a human review:
// the finding becomes contextual with that reason. A finding about a whole file is reported on line
// 1, so there the comment is line 1 itself. Declared contracts cannot be dismissed this way. The
// older `warden-reviewed`, `maintainability-reviewed` and `backend-perf-reviewed` spellings stay
// accepted so existing comments keep working.
import fs from 'node:fs';
import path from 'node:path';
import { noteUnreadable } from '../shared/coverage-notes.cjs';
import type { Node, ScriptKind, SourceFile } from 'typescript';
import type { Finding } from '../shared/types.cjs';
import type * as Typescript from 'typescript';

const directive =
  /^[\t ]*\/\/[\t ]+(?:loadwise|warden|maintainability|backend-perf)-reviewed[\t ]+([a-z][a-z0-9-]*)[\t ]+--[\t ]+(\S[^\r\n]*?)[\t ]*$/;
const protectedRules = new Set(['file-placement', 'folder-boundary', 'data-access-boundary', 'query-mutates-state']);
const scriptKinds: Record<string, ScriptKind> = {
  '.ts': 3,
  '.mts': 3,
  '.cts': 3,
  '.tsx': 4,
  '.js': 1,
  '.cjs': 1,
  '.mjs': 1,
  '.jsx': 2,
};

interface ReviewedSource {
  text: string;
  lines: string[];
  scriptKind: ScriptKind;
  sourceFile?: SourceFile;
}

function supportsReviewDirective(finding: Finding): boolean {
  return (
    !protectedRules.has(finding.ruleId) &&
    finding.file !== undefined &&
    Object.hasOwn(scriptKinds, path.extname(finding.file).toLowerCase())
  );
}

// Template text, JSX and block comments can look like a directive; only a real line comment in a
// token's leading trivia counts.
function isLineComment(sourceFile: SourceFile, offset: number): boolean {
  const ts: typeof Typescript = require('typescript');
  let found = false;
  (function visit(node: Node): void {
    if (found || offset < node.pos || offset >= node.end) return;
    if (offset < node.getStart(sourceFile)) {
      found = Boolean(
        ts
          .getLeadingCommentRanges(sourceFile.text, node.pos)
          ?.some((range) => range.pos === offset && range.kind === ts.SyntaxKind.SingleLineCommentTrivia),
      );
      return;
    }
    ts.forEachChild(node, visit);
  })(sourceFile);
  return found;
}

function createSourceLoader(root: string) {
  const files = new Map<string, ReviewedSource | undefined>();
  return function load(file: string): ReviewedSource | undefined {
    if (files.has(file)) return files.get(file);
    let entry: ReviewedSource | undefined;
    const scriptKind = scriptKinds[path.extname(file).toLowerCase()];
    try {
      if (scriptKind !== undefined) {
        const text = fs.readFileSync(path.resolve(root, file), 'utf8').replace(/^\uFEFF/, '');
        entry = { text, lines: text.split('\n'), scriptKind };
      }
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      // A file that is gone is expected; one that exists but cannot be read has its review
      // directives unseen.
      noteUnreadable({ error, location: file, consequence: 'its review directives were not seen' });
      entry = undefined;
    }
    files.set(file, entry);
    return entry;
  };
}

function applyReviewDirectives(findings: Finding[], root: string): void {
  const load = createSourceLoader(root);
  for (const finding of findings) {
    const { file, line } = finding;
    if (!supportsReviewDirective(finding) || file === undefined || line === undefined || !(line >= 1)) continue;
    const entry = load(file);
    // The comment sits above the flagged line, or is line 1 for a finding about the whole file.
    const directiveIndex = Math.max(line - 2, 0);
    const previous = entry?.lines[directiveIndex]?.replace(/\r$/, '');
    if (!entry || !previous) continue;
    const match = directive.exec(previous);
    if (!match || match[1] !== finding.ruleId) continue;
    if (!entry.sourceFile) {
      const ts: typeof Typescript = require('typescript');
      entry.sourceFile = ts.createSourceFile(file, entry.text, ts.ScriptTarget.Latest, true, entry.scriptKind);
    }
    const lineStart = entry.lines.slice(0, directiveIndex).reduce((total, text) => total + text.length + 1, 0);
    if (isLineComment(entry.sourceFile, lineStart + previous.indexOf('//')))
      finding.contextualReason = 'Reviewed in source: ' + match[2];
  }
}

export { applyReviewDirectives, supportsReviewDirective };
