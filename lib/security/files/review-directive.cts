import type * as TypeScript from 'typescript';
import type * as Compiler from '../../performance/compiler.cjs';
import type * as ReviewContext from '../../performance/review-context.cjs';
// `# loadwise-reviewed <rule-id> -- reason` on the line above a finding, or at the end of its line,
// for the files whose comments start with # (env files, Dockerfiles, compose files).
const directive = /#[\t ]+loadwise-reviewed[\t ]+([a-z][a-z0-9-]*)[\t ]+--[\t ]+(\S[^\r\n]*?)[\t ]*$/;
const standaloneComment = /^[\t ]*#/;

function directiveFor(line: string | undefined, ruleId: string) {
  const match = line === undefined ? null : directive.exec(line);
  return match?.[1] === ruleId ? match[2] : undefined;
}

// `lines` are the file's lines; `lineNumber` is 1-based. Returns the contextual reason or
// undefined.
function reviewedReason(lines: readonly string[], lineNumber: number, ruleId: string) {
  const previous = lines[lineNumber - 2];
  const reason =
    (previous !== undefined && standaloneComment.test(previous) ? directiveFor(previous, ruleId) : undefined) ??
    directiveFor(lines[lineNumber - 1], ruleId);
  return reason && 'Reviewed in source: ' + reason;
}

// The reviewed reason of one finding, looked up by its line and rule id.
type ReviewLookup = (finding: { line: number; ruleId: string }) => string | undefined;

function fileReviewReason(file: string, text: string): ReviewLookup | undefined {
  if (!text.includes('loadwise-reviewed')) return;
  if (/\.[cm]?[jt]sx?$/i.test(file)) {
    const ts: typeof TypeScript = require('typescript');
    const { requireWithSyntax }: typeof Compiler = require('../../performance/compiler.cjs');
    const { reviewedReason: sourceReview } = requireWithSyntax<typeof ReviewContext>(
      require.resolve('../../performance/review-context.cjs'),
      ts,
    );
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    return ({ line, ruleId }) => sourceReview(source, line - 1, ruleId);
  }
  const lines = text.split(/\r?\n/);
  return ({ line, ruleId }) => reviewedReason(lines, line, ruleId);
}

export { reviewedReason, fileReviewReason };
