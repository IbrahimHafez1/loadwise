// Moves the release of a file handle, query runner or browser into a finally block. The statements
// after the acquisition keep their indentation so the change stays a small, reviewable hunk; the
// project's formatter re-indents them.
import { ts, ancestor, indentationAt } from '../../performance/site-fixes/helpers.js';
import { walkNodes } from '../walk.js';
import type { CallExpression, ExpressionStatement, Node, SourceFile, Statement, VariableDeclaration } from 'typescript';
import type { FixResult, SiteFixInput, TextEdit } from '../../shared/types.js';

const reviewNote =
  'The statements after the acquisition now sit in a try block, so the release also runs when one of them throws. Re-indent them with your formatter and check that nothing declared inside is used after the block.';

interface ReleaseSpec {
  // Methods that already count as releasing, such as `close` for a launched browser.
  methods: readonly string[];
  // The call written into a new finally block.
  call: string;
}

function releaseSpecFor(ruleId: string, declaration: VariableDeclaration): ReleaseSpec | undefined {
  if (ruleId === 'query-runner-not-released') return { methods: ['release'], call: 'release' };
  if (ruleId === 'file-handle-not-closed') return { methods: ['close'], call: 'close' };
  const initializer = declaration.initializer && ts.skipOuterExpressions(declaration.initializer);
  const call =
    initializer && ts.isAwaitExpression(initializer) ? ts.skipOuterExpressions(initializer.expression) : undefined;
  const callee = call && ts.isCallExpression(call) ? ts.skipOuterExpressions(call.expression) : undefined;
  const connects = callee !== undefined && ts.isPropertyAccessExpression(callee) && callee.name.text === 'connect';
  const connectsByName = callee !== undefined && ts.isIdentifier(callee) && callee.text === 'connect';
  return connects || connectsByName
    ? { methods: ['disconnect', 'close'], call: 'disconnect' }
    : { methods: ['close'], call: 'close' };
}

function isAsyncContext(statement: Statement): boolean {
  const owner = ancestor(statement.parent, ts.isFunctionLike);
  if (!owner) return true;
  return Boolean(ts.getCombinedModifierFlags(owner) & ts.ModifierFlags.Async);
}

function callsOnVariable(statements: readonly Statement[], name: string, methods: readonly string[]): CallExpression[] {
  const calls: CallExpression[] = [];
  const collect = (node: Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === name &&
      methods.includes(node.expression.name.text)
    )
      calls.push(node);
  };
  for (const statement of statements) walkNodes(statement, collect);
  return calls;
}

function declaresVar(statement: Statement): boolean {
  return (
    ts.isVariableStatement(statement) &&
    !(statement.declarationList.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const | ts.NodeFlags.Using))
  );
}

// `return handle.readFile();` hands back a promise that is still running when the finally block
// closes the handle, so the release would come too early.
function returnsUnawaitedCall(statement: Statement): boolean {
  let found = false;
  const visit = (node: Node): void => {
    if (found || ts.isFunctionLike(node)) return;
    if (ts.isReturnStatement(node) && node.expression && containsUnawaitedCall(node.expression)) found = true;
    ts.forEachChild(node, visit);
  };
  visit(statement);
  return found;
}

function containsUnawaitedCall(expression: Node): boolean {
  if (ts.isAwaitExpression(expression) || ts.isFunctionLike(expression)) return false;
  if (ts.isCallExpression(expression) || ts.isNewExpression(expression) || ts.isTaggedTemplateExpression(expression))
    return true;
  return ts.forEachChild(expression, (child) => containsUnawaitedCall(child) || undefined) ?? false;
}

// The whole statement `await x.close();` when `call` is all of it.
function releaseStatementOf(call: CallExpression): ExpressionStatement | undefined {
  const parent = call.parent;
  const statement = ts.isAwaitExpression(parent) ? parent.parent : parent;
  return ts.isExpressionStatement(statement) ? statement : undefined;
}

function wrapInFinally({ finding, node, sourceFile, text }: SiteFixInput): FixResult | undefined {
  if (!node || !sourceFile || text === undefined) return;
  const declaration = ancestor(node, ts.isVariableDeclaration);
  if (!declaration || !ts.isIdentifier(declaration.name)) return;
  const statement = declaration.parent.parent;
  if (!ts.isVariableStatement(statement) || statement.modifiers || statement.declarationList.declarations.length !== 1)
    return;
  // Module level is left alone: wrapping would pull exports, imports and declarations into the try
  // block and relies on top-level await, which only ES modules have.
  const block = statement.parent;
  if (!ts.isBlock(block)) return;
  const following = block.statements.slice(block.statements.indexOf(statement) + 1);
  const last = following.at(-1);
  const spec = releaseSpecFor(finding.ruleId, declaration);
  if (!last || !spec || following.some(declaresVar) || !isAsyncContext(statement)) return;
  if (following.some(returnsUnawaitedCall)) return;
  return buildEdits({ sourceFile, text, name: declaration.name.text, statement, following, last, spec });
}

interface WrapPlan {
  sourceFile: SourceFile;
  text: string;
  name: string;
  statement: Statement;
  following: readonly Statement[];
  last: Statement;
  spec: ReleaseSpec;
}

function buildEdits({ sourceFile, text, name, statement, following, last, spec }: WrapPlan): FixResult | undefined {
  const indentation = indentationAt(text, statement.getStart(sourceFile));
  const existing = callsOnVariable(following, name, spec.methods);
  const releaseText = `await ${name}.${spec.call}();`;
  const open: TextEdit = { start: statement.end, end: statement.end, text: `\n${indentation}try {` };
  if (existing.length === 0) {
    const close: TextEdit = {
      start: last.end,
      end: last.end,
      text: `\n${indentation}} finally {\n${indentation}  ${releaseText}\n${indentation}}`,
    };
    return { edits: [open, close], note: reviewNote, requiresReview: true };
  }
  // Only a release that is a whole statement ending the block can be moved without reordering code.
  const [release] = existing;
  const releaseStatement = existing.length === 1 ? releaseStatementOf(release) : undefined;
  if (!releaseStatement || releaseStatement !== last || following.length < 2) return;
  const releaseSource = releaseStatement.getText(sourceFile);
  const close: TextEdit = {
    start: releaseStatement.getStart(sourceFile),
    end: releaseStatement.end,
    text: `} finally {\n${indentation}  ${releaseSource}\n${indentation}}`,
  };
  return { edits: [open, close], note: reviewNote, requiresReview: true };
}

export default {
  'file-handle-not-closed': wrapInFinally,
  'query-runner-not-released': wrapInFinally,
  'browser-not-closed': wrapInFinally,
};
