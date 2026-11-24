import { requireReview, ts, ancestor, hasMultilineTemplate } from './helpers.cjs';
import type { ArrowFunction, FunctionExpression, Node, SourceFile } from 'typescript';
import type { FixResult, SiteFixInput, TextEdit } from '../../shared/types.cjs';

const DEFAULT_INDENT_UNIT = '  ';
const loggerNamesByFile = new WeakMap<SourceFile, boolean>();

function lineOf(sourceFile: SourceFile, offset: number): number {
  return sourceFile.getLineAndCharacterOfPosition(offset).line;
}

function lineStart(text: string, offset: number): number {
  return text.lastIndexOf('\n', offset - 1) + 1;
}

function indentationAt(text: string, offset: number): string {
  return (/^[ \t]*/.exec(text.slice(lineStart(text, offset))) ?? [''])[0];
}

// The flagged async arrow or function expression; the finding points at its first token.
function flaggedFunction(node: Node): ArrowFunction | FunctionExpression | undefined {
  if (!node) return;
  const start = node.getStart();
  return ancestor(
    node,
    (current): current is ArrowFunction | FunctionExpression =>
      (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) && current.getStart() === start,
  );
}

// Replaces the statements of a multi-line block body with the same statements inside try/catch.
function wrapBodyEdit(fn: ArrowFunction | FunctionExpression, catchStatement: string): TextEdit | undefined {
  const body = fn.body;
  if (!body || !ts.isBlock(body) || body.statements.length === 0) return;
  const sourceFile = fn.getSourceFile();
  const text = sourceFile.text;
  // Re-indenting lines would change the content of a multi-line template literal.
  if (hasMultilineTemplate(sourceFile, body.getStart(), body.end)) return;
  const first = body.statements[0];
  const last = body.statements[body.statements.length - 1];
  const openLine = lineOf(sourceFile, body.getStart());
  const closeLine = lineOf(sourceFile, body.end - 1);
  if (lineOf(sourceFile, first.getStart()) === openLine || lineOf(sourceFile, last.end) === closeLine) return;
  const statementIndent = indentationAt(text, first.getStart());
  const closeIndent = indentationAt(text, body.end - 1);
  const unit = statementIndent.startsWith(closeIndent)
    ? statementIndent.slice(closeIndent.length) || DEFAULT_INDENT_UNIT
    : DEFAULT_INDENT_UNIT;
  const start = lineStart(text, first.getStart());
  const statements = text
    .slice(start, last.end)
    .split('\n')
    .map((line) => (line.trim() ? unit + line : line));
  const wrapped = [
    `${statementIndent}try {`,
    ...statements,
    `${statementIndent}} catch (error) {`,
    `${statementIndent}${unit}${catchStatement}`,
    `${statementIndent}}`,
  ].join('\n');
  return { start, end: last.end, text: wrapped };
}

function routeTryCatch({ node }: SiteFixInput): FixResult | undefined {
  if (!node) return;
  const fn = flaggedFunction(node);
  if (!fn || fn.parameters.length !== 2) return;
  const wrap = wrapBodyEdit(fn, 'next(error);');
  if (!wrap) return;
  const response = fn.parameters[1];
  return {
    edits: [{ start: response.end, end: response.end, text: ', next' }, wrap],
    note: 'Errors from the handler now reach the Express error middleware through next(error). Check that a response is not already sent before the error, and type `next` as NextFunction if the parameters are annotated.',
  };
}

function usesLogger(sourceFile: SourceFile): boolean {
  const known = loggerNamesByFile.get(sourceFile);
  if (known !== undefined) return known;
  let found = false;
  (function visit(node: Node): void {
    if (found) return;
    if (ts.isIdentifier(node) && node.text === 'logger') {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  })(sourceFile);
  loggerNamesByFile.set(sourceFile, found);
  return found;
}

function callbackTryCatch({ node }: SiteFixInput): FixResult | undefined {
  if (!node) return;
  const fn = flaggedFunction(node);
  if (!fn) return;
  const log = usesLogger(fn.getSourceFile()) ? 'logger.error(error);' : 'console.error(error);';
  const wrap = wrapBodyEdit(fn, log);
  if (!wrap) return;
  return {
    edits: [wrap],
    note: 'A rejection inside the callback is now logged instead of becoming an unhandled rejection. Add any retry, cleanup or alerting the callback needs.',
  };
}

export default {
  'async-route-unhandled-rejection': requireReview(
    'The handler now forwards its errors to next(error), which changes how failed requests are answered.',
    routeTryCatch,
  ),
  'async-callback-unhandled-rejection': requireReview(
    'The callback now catches and logs its errors, which changes what happens when it fails.',
    callbackTryCatch,
  ),
};
