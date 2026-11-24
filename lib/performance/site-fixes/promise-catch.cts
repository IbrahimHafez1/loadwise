import { requireReview, ts, enclosingStatement, enclosingIteration } from './helpers.cjs';
import { calleeName } from '../call-syntax.cjs';
import { catchRepeatsEscapedCall } from '../promise-return-escapes-catch.cjs';
import type { ArrowFunction, FunctionExpression, Node, SignatureDeclaration } from 'typescript';
import type { FixResult, SiteFixInput } from '../../shared/types.cjs';

// Helpers named like events, telemetry or cache warm-ups are often meant to run in the background.
const backgroundWorkName =
  /^(?:publish|emit|notify|track|log|send|dispatch|enqueue|schedule|trigger|broadcast|warm|prefetch|refresh|report)/i;

function isAsync(owner: Node): boolean {
  return (
    ts.canHaveModifiers(owner) &&
    Boolean(ts.getModifiers(owner)?.some((item) => item.kind === ts.SyntaxKind.AsyncKeyword))
  );
}

function isGenerator(owner: SignatureDeclaration): boolean {
  return 'asteriskToken' in owner && Boolean(owner.asteriskToken);
}

function returnAwait({ node }: SiteFixInput): FixResult | undefined {
  const statement = node && enclosingStatement(node);
  if (!statement || !ts.isReturnStatement(statement) || !statement.expression) return;
  const value = statement.expression;
  if (!ts.isCallExpression(value) && !ts.isIdentifier(value)) return;
  if (catchRepeatsEscapedCall(statement)) return;
  let guarded = false;
  let closesIterator = false;
  for (let child: Node = statement, parent = child.parent; parent; child = parent, parent = parent.parent) {
    if (ts.isFunctionLike(parent)) {
      if (!guarded || isGenerator(parent) || !isAsync(parent)) return;
      return {
        edits: [{ start: value.getStart(), end: value.getStart(), text: 'await ' }],
        requiresReview: true,
        note:
          'Rejected promises will now run this catch handler. Verify its recovery, response-writing, logging and retry behavior.' +
          (closesIterator
            ? ' The surrounding for...of loop now closes its iterator after the promise settles, which matters only for generators with cleanup.'
            : ''),
      };
    }
    if (ts.isForOfStatement(parent)) closesIterator = true;
    // Waiting here would change when a `using` resource is disposed.
    if (
      ts.isBlock(parent) &&
      parent.statements.some(
        (sibling) => ts.isVariableStatement(sibling) && sibling.declarationList.flags & ts.NodeFlags.Using,
      )
    )
      return;
    if (ts.isTryStatement(parent)) {
      if (parent.finallyBlock) return;
      if (parent.catchClause && child === parent.tryBlock) guarded = true;
    }
  }
}

// Rewrites `items.forEach(async (item) => { ... });` into `for (const item of items) { ... }`
// inside an async function. The callback's own returns, `this` and `arguments` would change meaning
// in a loop, so those callbacks are left alone.
function changesMeaningInLoop(callback: ArrowFunction | FunctionExpression, parameterName: string): boolean {
  let found = false;
  (function visit(child: Node): void {
    if (found) return;
    if (ts.isReturnStatement(child) || child.kind === ts.SyntaxKind.ThisKeyword) found = true;
    else if (ts.isIdentifier(child) && child.text === 'arguments' && !ts.isArrowFunction(callback)) found = true;
    else if (isAssignmentTo(child, parameterName)) found = true;
    if (found || (ts.isFunctionLike(child) && !ts.isArrowFunction(child))) return;
    ts.forEachChild(child, visit);
  })(callback.body);
  return found;
}

function isAssignmentTo(node: Node, name: string): boolean {
  const target = ts.isBinaryExpression(node)
    ? node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
      node.left
    : (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) && node.operand;
  return !!target && ts.isIdentifier(target) && target.text === name;
}

function forEachToForOf(node: Node | undefined): FixResult | undefined {
  const access = node?.parent && ts.isPropertyAccessExpression(node.parent) ? node.parent : undefined;
  const call = access && ts.isCallExpression(access.parent) ? access.parent : undefined;
  if (!access || !call || access.name.text !== 'forEach' || call.arguments.length !== 1) return;
  const callback = call.arguments[0];
  if (!(ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) || !isAsync(callback)) return;
  const [parameter] = callback.parameters;
  if (callback.parameters.length !== 1 || !ts.isIdentifier(parameter.name) || parameter.initializer) return;
  if (!ts.isExpressionStatement(call.parent)) return;
  const owner = ts.findAncestor(call.parent, ts.isFunctionLike);
  if (!owner || !isAsync(owner) || isGenerator(owner)) return;
  const name = parameter.name.text;
  if (changesMeaningInLoop(callback, name)) return;
  const sourceFile = call.getSourceFile();
  const awaited = ts.isAwaitExpression(callback.body) ? '' : 'await ';
  const body = ts.isBlock(callback.body)
    ? callback.body.getText(sourceFile)
    : `{ ${awaited}${callback.body.getText(sourceFile)}; }`;
  return {
    edits: [
      {
        start: call.parent.getStart(sourceFile),
        end: call.parent.end,
        text: `for (const ${name} of ${access.expression.getText(sourceFile)}) ${body}`,
      },
    ],
    requiresReview: true,
    note: 'The items now run one after another and the function waits for them, so a rejection reaches the caller. Use Promise.all over a map if they are independent and may run together.',
  };
}

// `await` keeps the call in the same place, so later statements now run after it settles and its
// rejection reaches the caller instead of becoming an unhandled rejection.
function awaitFloatingCall({ finding, node }: SiteFixInput): FixResult | undefined {
  const forEachRewrite = forEachToForOf(node);
  if (forEachRewrite) return forEachRewrite;
  const statement = node && enclosingStatement(node);
  if (!statement || !ts.isExpressionStatement(statement)) return;
  const call = ts.skipOuterExpressions(statement.expression);
  // The forEach finding points at the method name; rewriting that loop is a different change.
  if (!node || !ts.isCallExpression(call) || call.getStart() !== node.getStart()) return;
  const owner = ts.findAncestor(statement, ts.isFunctionLike);
  if (!owner || !isAsync(owner) || isGenerator(owner)) return;
  const inLoop = enclosingIteration(statement)?.kind === 'loop';
  const looksLikeBackgroundWork = backgroundWorkName.test(calleeName(call) ?? '');
  const requiresReview = inLoop || looksLikeBackgroundWork || Boolean(finding.contextualReason);
  return {
    edits: [{ start: call.getStart(), end: call.getStart(), text: 'await ' }],
    ...(requiresReview && { requiresReview: true }),
    note: inLoop
      ? 'Each iteration now waits for this call before the next one starts. Use Promise.all if the calls are independent and may run together.'
      : requiresReview
        ? 'The caller now waits for this call and receives its rejection. Confirm it was not meant to run in the background; if it was, use `void` with `.catch(handler)` instead.'
        : 'The caller now waits for this call and receives its rejection instead of carrying on before it finishes.',
  };
}

export default {
  'promise-return-escapes-catch': returnAwait,
  'floating-promise': requireReview(
    'The caller now waits for the call and receives its rejection, which changes ordering and error handling.',
    awaitFloatingCall,
  ),
};
