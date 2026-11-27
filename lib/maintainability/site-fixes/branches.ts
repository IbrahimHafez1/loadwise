// high-branch-complexity: exact rewrites that each remove one decision the checker counts, applied
// together. Nested ifs merge into one condition, adjacent ifs with the same exit share one
// condition, `x ? true : false` becomes a conversion and `if (!x) x = value` becomes `x ||= value`.
import {
  ts,
  hasBlockBody,
  ownsLines,
  hasComments,
  nameUsed,
  logicalOperand,
  singleLine,
  flaggedFunction,
  indentationAt,
  clauseCount,
  readableCondition,
} from './helpers.js';
import { mergeNestedIf, editLines, cleanHeader, jumpKinds } from './if-rewrites.js';
import { extractionEdit, fitsHunks, measuredEdits, ownStatements, decisionCount } from './extract-block.js';
import { booleanGuardReturns } from './boolean-returns.js';
import type {
  Block,
  ConditionalExpression,
  Expression,
  IfStatement,
  Node,
  NodeArray,
  SourceFile,
  Statement,
} from 'typescript';
import type { FixResult, SiteFixBuilder, SiteFixInput, TextEdit } from '../../shared/types.js';
import type { BlockBodiedFunction } from '../types/duplicate-sites.js';
import type { ExtractionDraft } from '../types/extraction-drafts.js';
import type { CountedEdit } from '../types/site-fix-edits.js';

// A statement of an else-if chain that tests one name against a string literal.
interface LiteralCase {
  branch: IfStatement;
  literal: string;
  elseStatement: Statement;
}

// The statements that run as part of a function's own body, moved into a named function.
interface BlockExtraction extends Pick<ExtractionDraft, 'name' | 'edits'> {
  decisions: number;
}

const ruleId = 'high-branch-complexity';
// The checker reports functions at this complexity or above.
const branchLimit = 15;
// A helper holding a single decision adds a name without making the function easier to follow.
const minExtractedDecisions = 2;
const minClearReduction = 3;

// Larger edits stop reading as an inline fix; site-fix also rejects the whole fix when one hunk is
// too long.
const maxEditLines = 10;

// Inline decoding is common when imported data may already be a parsed value. Share the operation,
// while leaving the three reads at their respective sites and within their original error handlers.
const inlineJsonDecode = /^typeof\s+([a-zA-Z_$][\w$]*)\s*===\s*(['"])string\2\s*\?\s*JSON\.parse\(\s*\1\s*\)\s*:\s*\1$/;

function jsonDecodeSites(
  block: Block,
  sourceFile: SourceFile,
  helper: string,
): { firstStatement: Statement | undefined; edits: TextEdit[] } {
  const initialized = new Set<string>();
  const edits: TextEdit[] = [];
  let firstStatement: Statement | undefined;
  for (const statement of block.statements) {
    if (!ts.isVariableStatement(statement) || !(statement.declarationList.flags & ts.NodeFlags.Const)) continue;
    const declarations = statement.declarationList.declarations;
    if (declarations.length !== 1) continue;
    const [declaration] = declarations;
    if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
    const expression = declaration.initializer;
    const eligible =
      ts.isConditionalExpression(expression) &&
      declaration.type?.kind === ts.SyntaxKind.UnknownKeyword &&
      ownsLines(statement) &&
      !hasComments(statement);
    const match = eligible && inlineJsonDecode.exec(expression.getText(sourceFile));
    if (match && initialized.has(match[1])) {
      firstStatement ??= statement;
      edits.push({ start: expression.getStart(sourceFile), end: expression.end, text: `${helper}(${match[1]})` });
    }
    initialized.add(declaration.name.text);
  }
  return { firstStatement, edits };
}

function repeatedJsonDecode(fn: BlockBodiedFunction, sourceFile: SourceFile): FixResult | undefined {
  const helper = 'parseJsonIfString';
  if (!/\.[cm]?tsx?$/i.test(sourceFile.fileName) || nameUsed(fn, helper) || nameUsed(fn.body, 'eval')) return;
  for (const block of ownNodes(fn.body).filter(ts.isBlock)) {
    const { firstStatement, edits } = jsonDecodeSites(block, sourceFile, helper);
    if (!firstStatement || edits.length < minClearReduction) continue;
    // A project-specific JSON binding may accept narrower types than the standard parser.
    const usesCustomJson = (node: Node): boolean =>
      (ts.isIdentifier(node) && node.text === 'JSON' && 'name' in node.parent && node.parent.name === node) ||
      Boolean(ts.forEachChild(node, (child) => usesCustomJson(child) || undefined));
    if (usesCustomJson(sourceFile)) return;
    const start = firstStatement.getStart(sourceFile);
    if (ts.getLeadingCommentRanges(sourceFile.text, firstStatement.pos)?.length) continue;
    const indent = indentationAt(sourceFile.text, start);
    const newline = sourceFile.text.includes('\r\n') ? '\r\n' : '\n';
    const text = `const ${helper} = (value: unknown): unknown =>${newline}${indent}  typeof value === 'string' ? JSON.parse(value) : value;`;
    const result = [{ start, end: start, text: text + newline + indent }, ...edits];
    if (fitsHunks(sourceFile, result))
      return {
        edits: result,
        note: 'Shares repeated JSON decoding within the block. Each value is parsed at its original site.',
      };
  }
}

// Nodes of the function body that count toward its complexity: nested functions and classes count
// separately.
function ownNodes(body: Node): Node[] {
  const nodes: Node[] = [];
  (function visit(node: Node): void {
    nodes.push(node);
    ts.forEachChild(node, (child) => {
      if (!ts.isFunctionLike(child) && !ts.isClassLike(child)) visit(child);
    });
  })(body);
  return nodes;
}

function singleJump(statement: Statement): boolean {
  if (ts.isBlock(statement)) return statement.statements.length === 1 && singleJump(statement.statements[0]);
  return jumpKinds.has(statement.kind);
}

// An operand of `||`. An `&&` operand is grouped explicitly, so the reader never has to recall
// precedence.
function orOperand(expression: Expression, sourceFile: SourceFile): string {
  const text = expression.getText(sourceFile);
  if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.BarBarToken) return text;
  if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken)
    return '(' + text + ')';
  return logicalOperand(expression, sourceFile);
}

function mergedRun(run: readonly IfStatement[], sourceFile: SourceFile): CountedEdit | undefined {
  const operands = run.map((statement) =>
    singleLine(orOperand(statement.expression, sourceFile), statement.expression),
  );
  if (operands.includes(undefined)) return;
  const first = run[0];
  const rewritten = `if (${operands.join(' || ')}) ${first.thenStatement.getText(sourceFile)}`;
  const clauses = run.reduce((sum, statement) => sum + clauseCount(statement.expression), 0);
  const line = indentationAt(sourceFile.text, first.getStart(sourceFile)) + rewritten;
  if (!readableCondition(line, clauses)) return;
  return { start: first.getStart(sourceFile), end: run[run.length - 1].end, text: rewritten, removed: run.length - 1 };
}

function eligibleExit(statement: Statement): statement is IfStatement {
  return (
    ts.isIfStatement(statement) &&
    !statement.elseStatement &&
    singleJump(statement.thenStatement) &&
    ownsLines(statement) &&
    !hasComments(statement)
  );
}

// The index after the run of adjacent ifs that start at `index` and leave the block the same way.
function sameExitRunEnd(statements: NodeArray<Statement>, index: number, sourceFile: SourceFile): number {
  const first = statements[index];
  let end = index + 1;
  if (!eligibleExit(first)) return end;
  const exit = first.thenStatement.getText(sourceFile);
  while (end < statements.length) {
    const next = statements[end];
    if (
      !eligibleExit(next) ||
      next.thenStatement.getText(sourceFile) !== exit ||
      sourceFile.text.slice(statements[end - 1].end, next.getStart(sourceFile)).trim()
    )
      break;
    end++;
  }
  return end;
}

// if (a) return x;  if (b) return x;  →  if (a || b) return x;
// Each branch leaves the block, so the second condition only ever ran when the first was false.
function sameExitRuns(block: Block, sourceFile: SourceFile): CountedEdit[] {
  const edits: CountedEdit[] = [];
  const statements = block.statements;
  for (let index = 0; index < statements.length;) {
    let end = sameExitRunEnd(statements, index, sourceFile);
    // A run too long for one readable condition merges its longest readable prefix; the rest starts
    // a new run.
    for (; end - index > 1; end--) {
      const edit = mergedRun(statements.slice(index, end).filter(ts.isIfStatement), sourceFile);
      if (edit) {
        edits.push(edit);
        break;
      }
    }
    index = Math.max(end, index + 1);
  }
  return edits;
}

const booleanKinds = new Set([ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword]);

// The operators use JavaScript truthiness even when the global Boolean constructor is shadowed.
function booleanConditional(expression: ConditionalExpression, sourceFile: SourceFile): CountedEdit | undefined {
  const { condition, whenTrue, whenFalse } = expression;
  if (!booleanKinds.has(whenTrue.kind) || !booleanKinds.has(whenFalse.kind) || whenTrue.kind === whenFalse.kind) return;
  if (hasComments(expression)) return;
  const conditionText = condition.getText(sourceFile);
  const tight =
    ts.isIdentifier(condition) || ts.isPropertyAccessExpression(condition) || ts.isCallExpression(condition);
  // Any tighter operator around the conditional already needed parentheses, so the shorter form
  // fits in place.
  const operator = whenTrue.kind === ts.SyntaxKind.TrueKeyword ? '!!' : '!';
  const text = operator + (tight ? conditionText : `(${conditionText})`);
  return { start: expression.getStart(sourceFile), end: expression.end, text, removed: 1 };
}

// The statements a node directly holds, for the nodes that hold a list of them.
function statementsOf(node: Node): NodeArray<Statement> | undefined {
  return ts.isBlock(node) || ts.isSourceFile(node) || ts.isModuleBlock(node) || ts.isCaseOrDefaultClause(node)
    ? node.statements
    : undefined;
}

function localConstBefore(statement: Statement, name: string): boolean {
  const siblings = statementsOf(statement.parent);
  if (!siblings) return false;
  return siblings
    .slice(0, siblings.indexOf(statement))
    .some(
      (node: Node) =>
        ts.isVariableStatement(node) &&
        node.declarationList.flags & ts.NodeFlags.Const &&
        node.declarationList.declarations.some((item) => ts.isIdentifier(item.name) && item.name.text === name),
    );
}

function simpleTarget(expression: Expression, statement: Statement): boolean {
  if (ts.isIdentifier(expression)) {
    // A with-object can resolve the name differently on the subsequent write.
    return !ts.findAncestor(statement, ts.isWithStatement);
  }
  return (
    ts.isPropertyAccessExpression(expression) &&
    !expression.questionDotToken &&
    (expression.expression.kind === ts.SyntaxKind.ThisKeyword ||
      (ts.isIdentifier(expression.expression) && localConstBefore(statement, expression.expression.text)))
  );
}

// if (!x) x = value;  →  x ||= value;
function logicalAssignment(statement: IfStatement, sourceFile: SourceFile): CountedEdit | undefined {
  if (statement.elseStatement || !ownsLines(statement) || hasComments(statement) || !cleanHeader(statement, sourceFile))
    return;
  const condition = statement.expression;
  if (!ts.isPrefixUnaryExpression(condition) || condition.operator !== ts.SyntaxKind.ExclamationToken) return;
  let body: Statement = statement.thenStatement;
  if (ts.isBlock(body)) {
    if (body.statements.length !== 1) return;
    body = body.statements[0];
  }
  if (!ts.isExpressionStatement(body) || !ts.isBinaryExpression(body.expression)) return;
  const assignment = body.expression;
  if (assignment.operatorToken.kind !== ts.SyntaxKind.EqualsToken || !simpleTarget(assignment.left, statement)) return;
  const target = assignment.left.getText(sourceFile);
  if (condition.operand.getText(sourceFile) !== target) return;
  return {
    start: statement.getStart(sourceFile),
    end: statement.end,
    text: `${target} ||= ${assignment.right.getText(sourceFile)};`,
    removed: 1,
  };
}

// The value a statement returns or assigns to a name.
function valueOf(node: Node): Expression | undefined {
  if (ts.isReturnStatement(node)) return node.expression;
  if (
    ts.isExpressionStatement(node) &&
    ts.isBinaryExpression(node.expression) &&
    ts.isIdentifier(node.expression.left) &&
    ts.isAssignmentOperator(node.expression.operatorToken.kind)
  )
    return node.expression.right;
}

// An else-if chain of distinct `name === 'literal'` tests, with the final else it ends in.
interface LiteralChain {
  cases: LiteralCase[];
  name: string | undefined;
  last: Statement;
}

function literalChain(statement: IfStatement): LiteralChain | undefined {
  const cases: LiteralCase[] = [];
  const literals = new Set<string>();
  let current: Statement = statement;
  let name: string | undefined;
  while (ts.isIfStatement(current)) {
    const condition = current.expression;
    if (
      !ts.isBinaryExpression(condition) ||
      condition.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken ||
      !ts.isIdentifier(condition.left) ||
      !ts.isStringLiteral(condition.right) ||
      !ts.isBlock(current.thenStatement) ||
      !current.elseStatement
    )
      return;
    name ??= condition.left.text;
    if (condition.left.text !== name || literals.has(condition.right.text)) return;
    literals.add(condition.right.text);
    cases.push({ branch: current, literal: condition.right.text, elseStatement: current.elseStatement });
    current = current.elseStatement;
  }
  return { cases, name, last: current };
}

// Whether a case only repeats what the fallback block does for its own literal.
function repeatsFallback(literalCase: LiteralCase, fallback: Block, name: string, sourceFile: SourceFile): boolean {
  const { branch, literal, elseStatement } = literalCase;
  const body = branch.thenStatement;
  if (!ts.isBlock(body)) return false;
  const value = body.statements.length ? valueOf(body.statements[0]) : undefined;
  if (!value || !ts.isStringLiteral(value) || value.text !== literal) return false;
  const start = body.getStart(sourceFile);
  const normalized =
    sourceFile.text.slice(start, value.getStart(sourceFile)) + name + sourceFile.text.slice(value.end, body.end);
  if (normalized !== fallback.getText(sourceFile)) return false;
  const removed = sourceFile.text.slice(branch.getStart(sourceFile), elseStatement.getStart(sourceFile));
  return !/\/\/|\/\*/.test(removed);
}

// A literal case such as `if (ch === 'x') value += 'x'` already takes the default
// action `value += ch`. The remaining tests must be distinct, side-effect-free comparisons.
function redundantLiteralCases(statement: IfStatement, sourceFile: SourceFile): CountedEdit | undefined {
  if (!ts.isBlock(statement.parent) || !statement.elseStatement || !ts.isIfStatement(statement.elseStatement)) return;
  const chain = literalChain(statement);
  if (!chain) return;
  const { cases, name, last: current } = chain;
  if (!ts.isBlock(current) || !current.statements.length) return;
  // Globals may be accessors. A local const is stable even if evaluating a destination has effects.
  if (name === undefined || !localConstBefore(statement, name)) return;
  const fallbackValue = valueOf(current.statements[0]);
  if (!fallbackValue || !ts.isIdentifier(fallbackValue) || fallbackValue.text !== name) return;
  // Compare exact statements including their order. Later statements must not rely on the narrowed
  // type.
  if (current.statements.slice(1).some((node) => nameUsed(node, name))) return;
  let count = 0;
  for (const literalCase of cases.slice(0, -1)) {
    if (!repeatsFallback(literalCase, current, name, sourceFile)) break;
    count++;
  }
  if (count)
    return {
      start: statement.getStart(sourceFile),
      end: cases[count].branch.getStart(sourceFile),
      text: '',
      removed: count,
    };
}

// a ? 'ready' : (b ? 'ready' : 'pending') tests b only when a is falsy.
function sharedConditionalResult(node: ConditionalExpression, sourceFile: SourceFile): CountedEdit | undefined {
  if (!ts.isStringLiteral(node.whenTrue)) return;
  let fallback: Expression = node.whenFalse;
  while (ts.isParenthesizedExpression(fallback)) fallback = fallback.expression;
  if (
    !ts.isConditionalExpression(fallback) ||
    !ts.isStringLiteral(fallback.whenTrue) ||
    node.whenTrue.text !== fallback.whenTrue.text ||
    !ts.isStringLiteral(fallback.whenFalse) ||
    /[\r\n]|\/\/|\/\*/.test(node.getText(sourceFile))
  )
    return;
  const condition = orOperand(node.condition, sourceFile) + ' || ' + orOperand(fallback.condition, sourceFile);
  const text = condition + ' ? ' + node.whenTrue.getText(sourceFile) + ' : ' + fallback.whenFalse.getText(sourceFile);
  if (!readableCondition(text, clauseCount(node.condition) + clauseCount(fallback.condition))) return;
  return { start: node.getStart(sourceFile), end: node.end, text, removed: 1 };
}

function rewrites(fn: BlockBodiedFunction, sourceFile: SourceFile): CountedEdit[] {
  const edits: CountedEdit[] = [];
  for (const node of ownNodes(fn.body)) {
    if (ts.isBlock(node)) edits.push(...sameExitRuns(node, sourceFile), ...booleanGuardReturns(node, fn, sourceFile));
    if (ts.isIfStatement(node)) {
      const merged = mergeNestedIf(node, sourceFile);
      if (merged) edits.push({ ...merged, removed: 1 });
      const assigned = logicalAssignment(node, sourceFile);
      if (assigned) edits.push(assigned);
      const redundant = redundantLiteralCases(node, sourceFile);
      if (redundant) edits.push(redundant);
    }
    if (ts.isConditionalExpression(node)) {
      const converted = booleanConditional(node, sourceFile) ?? sharedConditionalResult(node, sourceFile);
      if (converted) edits.push(converted);
    }
  }
  return edits;
}

// Keeps the earliest of overlapping edits.
function disjoint<Edit extends TextEdit>(edits: readonly Edit[], text: string): Edit[] {
  const kept: Edit[] = [];
  for (const edit of [...edits].sort((left, right) => left.start - right.start || right.end - left.end)) {
    if (editLines(edit, text) > maxEditLines) continue;
    const last = kept.at(-1);
    if (last && edit.start < last.end) continue;
    kept.push(edit);
  }
  return kept;
}

// The busiest statement that moves into a named function and keeps every hunk within site-fix's
// limit. One at
// most: each new function lands after the same member or top-level statement.
function blockExtraction(
  fn: BlockBodiedFunction,
  sourceFile: SourceFile,
  edits: TextEdit[],
): BlockExtraction | undefined {
  const candidates = ownStatements(fn)
    .map((statement) => ({ statement, decisions: decisionCount(statement) }))
    .filter((candidate) => candidate.decisions >= minExtractedDecisions)
    .sort((left, right) => right.decisions - left.decisions);
  for (const { statement, decisions } of candidates) {
    const extraction = extractionEdit(statement, fn, sourceFile);
    if (extraction && fitsHunks(sourceFile, [...edits, ...extraction.edits])) return { ...extraction, decisions };
  }
}

const buildBranchComplexity: SiteFixBuilder = ({ finding, node, sourceFile }: SiteFixInput) => {
  if (!node || !sourceFile) return;
  const fn = flaggedFunction(node);
  if (!fn || !hasBlockBody(fn)) return;
  const complexity = Number(/branch complexity of (\d+)/.exec(finding.message)?.[1]);
  const edits = disjoint(rewrites(fn, sourceFile), sourceFile.text);
  const simplified = complexity - edits.reduce((sum, edit) => sum + edit.removed, 0);
  let extraction: BlockExtraction | undefined;
  if (Number.isFinite(complexity) && simplified >= branchLimit) {
    extraction = blockExtraction(fn, sourceFile, edits);
    const expected = simplified - (extraction?.decisions ?? 0);
    // A function that stays over the limit is worth it only when it moves a clear share of
    // decisions, and the checker itself must agree with the count.
    if (
      extraction &&
      ((expected >= branchLimit && extraction.decisions < minClearReduction) ||
        measuredEdits(sourceFile, fn, ruleId, [...edits, ...extraction.edits]).after !==
          (expected >= branchLimit ? expected : 0))
    )
      extraction = undefined;
  }
  const all = [...edits, ...(extraction?.edits ?? [])];
  if (!all.length) return repeatedJsonDecode(fn, sourceFile);
  const after = simplified - (extraction?.decisions ?? 0);
  const note = Number.isFinite(complexity)
    ? `Lowers the branch complexity from ${complexity} to ${after}.` +
      (extraction ? ` Moves a self-contained block into ${extraction.name}, called in its place.` : '') +
      (after >= branchLimit ? ' Extract the remaining decisions into named functions by hand.' : '')
    : undefined;
  return {
    edits: all.map(({ start, end, text }) => ({ start, end, text })),
    note,
    ...(extraction && { requiresReview: true }),
  };
};

export default { 'high-branch-complexity': buildBranchComplexity };
