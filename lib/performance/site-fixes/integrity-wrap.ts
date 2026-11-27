// Text helpers shared by the integrity site fixes: line endings, indentation unit and statement
// wrapping.
import { hasMultilineTemplate, indentationAt, lineStart } from './helpers.js';
import type { Node, SourceFile } from 'typescript';
import type { TextEdit } from '../../shared/types.js';

// What wrapStatements wraps: the statements from `first` to `last`, the lines around them, and the
// edits inside.
export interface WrapRequest {
  text: string;
  sourceFile: SourceFile;
  first: Node;
  last: Node;
  header: readonly string[];
  footer: readonly string[];
  replacements: TextEdit[];
}

export interface WrappedStatements {
  edits: TextEdit[];
  reindented: boolean;
}

// site-fix.cjs drops hunks longer than this, so longer rewrites use the in-place form.
const maxInlineLines = 14;

export function eolOf(text: string): string {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

export function unitFor(indentation: string): string {
  return indentation.includes('\t') ? '\t' : '  ';
}

// Wraps the statements from `first` to `last` in `header` and `footer` lines, applying
// `replacements` inside. Re-indents the statements when the result stays a readable hunk; otherwise
// wraps them in place.
export function wrapStatements({
  text,
  sourceFile,
  first,
  last,
  header,
  footer,
  replacements,
}: WrapRequest): WrappedStatements | undefined {
  const start = first.getStart(sourceFile);
  const end = last.end;
  const firstLineStart = lineStart(text, start);
  if (text.slice(firstLineStart, start).trim()) return;
  const indentation = indentationAt(text, start);
  const unit = unitFor(indentation);
  const eol = eolOf(text);
  const outer = (lines: readonly string[]): string[] => lines.map((line) => indentation + line);
  let body = text.slice(start, end);
  for (const replacement of [...replacements].sort((left, right) => right.start - left.start)) {
    body = body.slice(0, replacement.start - start) + replacement.text + body.slice(replacement.end - start);
  }
  const bodyLines = body.split(/\r?\n/);
  if (
    !hasMultilineTemplate(sourceFile, start, end) &&
    header.length + bodyLines.length + footer.length <= maxInlineLines
  ) {
    const inner = bodyLines.map((line, index) => (index === 0 ? indentation + unit + line : line && unit + line));
    const lines = [...outer(header), ...inner, ...outer(footer)];
    return { edits: [{ start, end, text: lines.join(eol).slice(indentation.length) }], reindented: true };
  }
  return {
    edits: [
      { start: firstLineStart, end: firstLineStart, text: outer(header).join(eol) + eol },
      ...replacements,
      { start: end, end, text: eol + outer(footer).join(eol) },
    ],
    reindented: false,
  };
}

export const formatterNote = ' Run your formatter to re-indent the wrapped statements.';
