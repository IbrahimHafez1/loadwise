import type { Node } from 'typescript';
import { findLineIndex } from '../performance/sql/locations.js';
import { innermostNodeAt } from './fix-hunks.js';
import { splitRows } from './fix-presentation-rows.js';
import { fixRationaleByRule } from './fix-rationales.js';
import { wrapWords } from './fix-terminal.js';
import type { Finding, FindingFix, FixChange, TextEdit } from './types.js';
import type { CommentableEdit } from './types/fix-hunks.js';
import type {
  ChangedRowRange,
  CommentedEdits,
  ParsedSource,
  RuleDescriptions,
  TypeScript,
  WhyCommentInput,
  WhyCommentResult,
} from './types/fix-presentation.js';

// Prettier leaves comments as written, so the why-comment is wrapped here to stay readable beside
// the code.
const commentLineWidth = 80;

function firstSentence(text: string): string {
  const flat = text.replaceAll(/\s+/g, ' ').trim();
  return /^.+?[.!?](?=\s|$)/.exec(flat)?.[0] ?? flat;
}

// `text` as `//` lines, joined by `\n`, the first starting `// Loadwise <rule-id>:`.
function formatComment(ruleId: string, text: string): string {
  return wrapWords(`Loadwise ${ruleId}: ${text}`, commentLineWidth - '// '.length)
    .map((line) => '// ' + line)
    .join('\n');
}

// The hunk's text without the why-comment, for limits that measure the code. Only a whole run of
// the comment's lines is removed, so a project comment that matches one wrapped line stays.
function withoutComment(text: string, comment: string | undefined): string {
  if (!comment) return text;
  const commentLines = comment.split('\n');
  const lines = text.split('\n');
  const kept: string[] = [];
  for (let index = 0; index < lines.length; index++) {
    const isComment = commentLines.every(
      (commentLine: string, offset: number) => lines[index + offset]?.trim() === commentLine,
    );
    if (isComment) index += commentLines.length - 1;
    else kept.push(lines[index]);
  }
  return kept.join('\n');
}

const templateOrJsx = (ts: TypeScript, node: Node): boolean =>
  ts.isTemplateExpression(node) ||
  ts.isTaggedTemplateExpression(node) ||
  ts.isJsxElement(node) ||
  ts.isJsxFragment(node) ||
  ts.isJsxSelfClosingElement(node);

// The statement, class member or interface member that holds the node. Undefined inside a template
// or JSX, and in a catch block, where any comment counts as handling the error.
function holdingStatement(ts: TypeScript, node: Node | undefined): Node | undefined {
  let statement: Node | undefined = node;
  while (statement && !ts.isSourceFile(statement)) {
    const parent = statement.parent;
    if (
      ts.isSourceFile(parent) ||
      ts.isBlock(parent) ||
      ts.isModuleBlock(parent) ||
      ts.isCaseClause(parent) ||
      ts.isDefaultClause(parent) ||
      (ts.isClassElement(statement) && ts.isClassLike(parent)) ||
      (ts.isTypeElement(statement) && ts.isInterfaceDeclaration(parent))
    )
      break;
    statement = parent;
  }
  if (!statement || ts.isSourceFile(statement)) return;
  if (ts.isBlock(statement.parent) && ts.isCatchClause(statement.parent.parent)) return;
  for (let ancestor = statement.parent; ancestor; ancestor = ancestor.parent) {
    if (templateOrJsx(ts, ancestor)) return;
  }
  return statement;
}

const containers = (ts: TypeScript, node: Node): boolean =>
  ts.isSourceFile(node) || ts.isBlock(node) || ts.isModuleBlock(node) || ts.isCaseBlock(node) || ts.isClassLike(node);

// Statements that hold the fixed site, most direct first: the finding's own statement when the fix
// edits it, then the statement at each edit nearest the finding. An edit that only deletes, or
// starts between statements, holds none.
function candidateStatements(
  ts: TypeScript,
  entry: ParsedSource,
  edits: readonly TextEdit[],
  findingOffset: number,
): Node[] {
  const { sourceFile, text } = entry;
  const candidates: Node[] = [];
  const findingStatement = holdingStatement(ts, innermostNodeAt(ts, sourceFile, findingOffset));
  const touches = (edit: TextEdit, node: Node) => edit.start <= node.end && edit.end >= node.getStart(sourceFile);
  if (findingStatement && edits.some((edit: TextEdit) => touches(edit, findingStatement)))
    candidates.push(findingStatement);
  const distance = (edit: TextEdit) => Math.max(0, edit.start - findingOffset, findingOffset - edit.end);
  for (const edit of [...edits].sort((left, right) => distance(left) - distance(right))) {
    if (!edit.text) continue;
    const codeStart =
      edit.start + (/^\s*/.exec(text.slice(edit.start, Math.max(edit.start, edit.end)))?.[0].length ?? 0);
    const node = innermostNodeAt(ts, sourceFile, codeStart);
    if (!node || containers(ts, node)) continue;
    const statement = holdingStatement(ts, node);
    if (statement && !candidates.includes(statement)) candidates.push(statement);
  }
  return candidates;
}

// Standalone comments directly above a statement (a review directive, JSDoc,
// eslint-disable-next-line) stay attached to it, so the why-comment goes above them. Returns the
// first row of that block, or `present` when it already holds this rule's comment.
function commentBlockTop(
  ts: TypeScript,
  entry: ParsedSource,
  statement: Node,
  row: number,
  comment: string,
): number | 'present' {
  const { text, lineStarts } = entry;
  const rulePrefix = comment.slice(0, comment.indexOf(':') + 1);
  let top = row;
  for (const range of [...(ts.getLeadingCommentRanges(text, statement.pos) ?? [])].reverse()) {
    const firstRow = findLineIndex(lineStarts, range.pos);
    if (findLineIndex(lineStarts, range.end - 1) !== top - 1 || /\S/.test(text.slice(lineStarts[firstRow], range.pos)))
      break;
    if (text.slice(range.pos, range.end).startsWith(rulePrefix)) return 'present';
    top = firstRow;
  }
  return top;
}

// The edits with the comment line inserted above the statement and the row it goes above, `present`
// when the comment is already there, or undefined when the statement has no line of its own or an
// edit spans the insertion point.
function commentedEdits(
  ts: TypeScript,
  entry: ParsedSource,
  edits: readonly CommentableEdit[],
  statement: Node,
  { comment, separateEdits }: { comment: string; separateEdits: boolean },
): CommentedEdits | 'present' | undefined {
  const { text, lineStarts } = entry;
  const start = statement.getStart(entry.sourceFile);
  const row = findLineIndex(lineStarts, start);
  const indentation = text.slice(lineStarts[row], start);
  // Code before the statement on its line, such as `} else {`, leaves no line of its own to
  // comment.
  if (/\S/.test(indentation)) return;
  const top = commentBlockTop(ts, entry, statement, row, comment);
  if (top === 'present') return top;
  const offset = lineStarts[top];
  const lineBreak = text.includes('\r\n') ? '\r\n' : '\n';
  const line = comment
    .split('\n')
    .map((commentLine) => indentation + commentLine + lineBreak)
    .join('');
  if (edits.some((edit: CommentableEdit) => edit.start < offset && offset < edit.end)) return;
  const atOffset = edits.filter((edit: CommentableEdit) => edit.start === offset);
  if (!atOffset.length)
    return { edits: [...edits, { start: offset, end: offset, text: line, comment: true }], row: top };
  // A shared insertion must stay identical across the fixes that make it, so it takes no comment.
  if (atOffset.length > 1 || (separateEdits && atOffset[0].end === offset)) return;
  return {
    edits: edits.map((edit: CommentableEdit) => (edit === atOffset[0] ? { ...edit, text: line + edit.text } : edit)),
    row: top,
  };
}

interface WhyCommentTools {
  ruleWhy(ruleId: string): string | undefined;
  whyComment(ruleId: string): string | undefined;
  withWhyComment(input: WhyCommentInput): WhyCommentResult;
  rememberCommentRow(fix: FindingFix, file: string, row: number): void;
  dropConflictingComments(findings: Finding[]): void;
  withoutWhyComment(fix: FindingFix, ruleId: string): FindingFix;
  withoutWhyComment(fix: FindingFix | undefined, ruleId: string): FindingFix | undefined;
}

function createWhyCommentTools({
  checkerFor,
  loadTs,
}: {
  checkerFor: (ruleId: string) => RuleDescriptions | undefined;
  loadTs: () => TypeScript;
}): WhyCommentTools {
  const commentByRule = new Map<string, string | undefined>();
  // The file and original row each built fix's why-comment goes above, so fixes that share it can
  // be found.
  const commentAnchors = new WeakMap<FindingFix, { file: string; row: number }>();

  // Why a fix for the rule changed the code: its fix rationale, which describes the code after the
  // fix, or else the first sentence of the rule's description. Both are site-neutral, unlike the
  // example note, which names the example's variables rather than the fixed code's.
  function ruleWhy(ruleId: string): string | undefined {
    if (Object.hasOwn(fixRationaleByRule, ruleId)) return fixRationaleByRule[ruleId];
    return firstSentence(checkerFor(ruleId)?.descriptionByRule[ruleId] ?? '') || undefined;
  }

  // The rule's why as a comment, the same for every fix of the rule.
  function whyComment(ruleId: string): string | undefined {
    if (commentByRule.has(ruleId)) return commentByRule.get(ruleId);
    const why = ruleWhy(ruleId);
    const comment = why ? formatComment(ruleId, why) : undefined;
    // loadwise-reviewed unbounded-module-cache -- The keys are rule ids, a fixed set shipped with Loadwise, so the cache cannot grow past it.
    commentByRule.set(ruleId, comment);
    return comment;
  }

  // Adds the rule's why-comment above the statement holding the primary fixed site. Returns the
  // edits unchanged and no comment when the comment is already there or there is no safe place for
  // it.
  function withWhyComment({
    ruleId,
    entry,
    edits,
    findingOffset,
    separateEdits = false,
  }: WhyCommentInput): WhyCommentResult {
    const comment = whyComment(ruleId);
    if (!comment || !entry?.sourceFile || !edits?.length) return { edits };
    const ts = loadTs();
    const source: ParsedSource = { sourceFile: entry.sourceFile, text: entry.text, lineStarts: entry.lineStarts };
    for (const statement of candidateStatements(ts, source, edits, findingOffset)) {
      const commented = commentedEdits(ts, source, edits, statement, { comment, separateEdits });
      if (commented === 'present') break;
      if (commented) return { ...commented, comment };
    }
    return { edits };
  }

  function rememberCommentRow(fix: FindingFix, file: string, row: number): void {
    commentAnchors.set(fix, { file, row });
  }

  // `--no-comments`: the fix as it would be built without its why-comment. A fix that wrote its
  // own comment for this site, such as naming the index it removed, carries that text as
  // `fix.comment`.
  function withoutWhyComment(fix: FindingFix, ruleId: string): FindingFix;
  function withoutWhyComment(fix: FindingFix | undefined, ruleId: string): FindingFix | undefined;
  function withoutWhyComment(fix: FindingFix | undefined, ruleId: string): FindingFix | undefined {
    const comment = fix?.comment ?? whyComment(ruleId);
    if (!fix || !comment) return fix;
    const changes: FixChange[] = [];
    for (const change of fix.changes) {
      if (change.create || withoutComment(change.before, comment) !== change.before) changes.push(change);
      else {
        const after = withoutComment(change.after, comment);
        if (after !== change.before) changes.push({ ...change, after });
      }
    }
    return { ...fix, changes };
  }

  // Fixes are built one finding at a time, but applied together. When a fix's comment would go
  // above a row that an earlier fix already comments with a different change, or whose code
  // another fix changes differently, applying both would overlap, so the later fix keeps its edits
  // without the comment. Identical commented changes stay, as they apply once.
  function dropConflictingComments(findings: Finding[]): void {
    const changedRows = new Map<string, ChangedRowRange[]>();
    for (const finding of findings) {
      if (!finding.fix) continue;
      for (const change of withoutWhyComment(finding.fix, finding.ruleId).changes) {
        if (change.create) continue;
        let ranges = changedRows.get(change.file);
        if (!ranges) {
          ranges = [];
          changedRows.set(change.file, ranges);
        }
        const key = JSON.stringify(change);
        ranges.push({ finding, key, start: change.line - 1, end: change.line - 1 + splitRows(change.before).length });
      }
    }
    const commentedChanges = new Map<string, Set<string>>();
    for (const finding of findings) {
      const { fix } = finding;
      const anchor = fix && commentAnchors.get(fix);
      if (!fix || !anchor) continue;
      const comment = fix.comment ?? whyComment(finding.ruleId);
      const withComment = fix.changes
        .filter((change: FixChange) => withoutComment(change.after, comment) !== change.after)
        .map((change: FixChange) => JSON.stringify(change));
      const own = new Set(
        withoutWhyComment(fix, finding.ruleId).changes.map((change: FixChange) => JSON.stringify(change)),
      );
      const overlapsOther = (changedRows.get(anchor.file) ?? []).some(
        (range: ChangedRowRange) =>
          range.finding !== finding && !own.has(range.key) && range.start <= anchor.row && anchor.row < range.end,
      );
      const anchorKey = anchor.file + '\0' + anchor.row;
      const earlier = commentedChanges.get(anchorKey);
      if (overlapsOther || (earlier && !withComment.every((change: string) => earlier.has(change))))
        finding.fix = withoutWhyComment(fix, finding.ruleId);
      else if (!earlier) commentedChanges.set(anchorKey, new Set(withComment));
    }
  }

  return {
    ruleWhy,
    whyComment,
    withWhyComment,
    rememberCommentRow,
    dropConflictingComments,
    withoutWhyComment,
  };
}

export { createWhyCommentTools, formatComment, withoutComment };
