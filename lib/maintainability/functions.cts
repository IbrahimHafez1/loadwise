import ts from 'typescript';
import { nestingAdvice, sectionAdvice, loopGuardComparison } from './branch-advice.cjs';
import { traversalLeaf } from './traversal-context.cjs';
import { checklistContext } from './checklist-context.cjs';
import { textChoiceContext, loopGuard, patchMappingContext } from './advisory-context.cjs';
import type { Block, ConciseBody, Node, SignatureDeclaration, SourceFile, Statement } from 'typescript';
import type { Finding } from '../shared/types.cjs';
import type { FindingComparison } from './types/finding-comparison.cjs';

// The running totals one function body accumulates while it is walked.
interface FunctionScope {
  complexity: number;
  maxDepth: number;
  // The most deeply nested branch seen so far.
  deepest?: Node;
  // The top-level statement that added the most decisions.
  busiestStatement?: Statement;
  hasTraversalLeaf: boolean;
  traversalOnly: boolean;
  loops: number;
  // Set for @maintainabilityQuery methods and the arrows they invoke: the writes seen so far.
  writes?: WeakSet<Node>;
}

interface FindingSite {
  node: Node;
  ruleId: string;
  message: string;
}

// One reused buffer with a static callback avoids allocating per node. Callers copy the children
// out before visiting anything else.
const childBuffer: Node[] = [];
let childCount = 0;
function bufferChild(child: Node): void {
  childBuffer[childCount++] = child;
}

// Buffers the node's children in forEachChild order and returns how many there are.
function bufferChildren(node: Node): number {
  childCount = 0;
  ts.forEachChild(node, bufferChild);
  return childCount;
}

const nestingLimit = 4;
const branchComplexityLimit = 15;

function annotatedInstanceQuery(node: Node, parent: Node | undefined): boolean {
  return Boolean(
    node.jsDoc &&
    ts.isMethodDeclaration(node) &&
    parent &&
    ts.isClassLike(parent) &&
    !node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword) &&
    node.jsDoc.some((comment) => comment.tags?.some((tag) => tag.tagName.text === 'maintainabilityQuery')),
  );
}

function writesThroughThis(target: Node): boolean {
  let receiver: Node = target;
  while (ts.isPropertyAccessExpression(receiver) || ts.isElementAccessExpression(receiver)) {
    receiver = ts.skipOuterExpressions(receiver.expression);
    if (receiver.kind === ts.SyntaxKind.ThisKeyword) return true;
  }
  return false;
}

function functionAnchor(node: SignatureDeclaration, parent: Node | undefined): Node {
  if (node.name) return node.name;
  if (parent && (ts.isVariableDeclaration(parent) || ts.isPropertyAssignment(parent)) && parent.initializer === node)
    return parent.name;
  return node;
}

function analyzeFunctions(sourceFile: SourceFile, relativePath: string): Finding[] {
  const findings: Finding[] = [];
  const invokedQueryArrows = new WeakSet<Node>();

  // A function-level finding also records the whole function's lines, so a change anywhere inside
  // it can surface it.
  function scopeLines(scopeNode?: Node): { rangeStartLine?: number; rangeEndLine?: number } {
    if (!scopeNode) return {};
    return {
      rangeStartLine: sourceFile.getLineAndCharacterOfPosition(scopeNode.getStart(sourceFile)).line + 1,
      rangeEndLine: sourceFile.getLineAndCharacterOfPosition(scopeNode.getEnd()).line + 1,
    };
  }

  function report(
    { node, ruleId, message }: FindingSite,
    contextualReason?: string | false,
    suggestion?: string,
    comparison?: FindingComparison,
    scopeNode?: Node,
  ): void {
    const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    findings.push({
      file: relativePath,
      line: start.line + 1,
      column: start.character + 1,
      ruleId,
      message,
      ...(contextualReason && { contextualReason }),
      ...(suggestion && { suggestion }),
      ...(comparison && { comparison }),
      ...scopeLines(scopeNode),
    });
  }

  function checkWriteTarget(target: Node, writes: WeakSet<Node>): void {
    const expression = ts.skipOuterExpressions(target);
    if (ts.isArrayLiteralExpression(expression)) {
      for (const element of expression.elements) checkWriteTarget(element, writes);
    } else if (ts.isObjectLiteralExpression(expression)) {
      for (const member of expression.properties) {
        if (ts.isPropertyAssignment(member)) checkWriteTarget(member.initializer, writes);
        else if (ts.isSpreadAssignment(member)) checkWriteTarget(member.expression, writes);
      }
    } else if (ts.isSpreadElement(expression)) {
      checkWriteTarget(expression.expression, writes);
    } else if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      checkWriteTarget(expression.left, writes);
    } else if (writesThroughThis(expression) && !writes.has(expression)) {
      // A destructuring default can also be visited as an assignment expression.
      writes.add(expression);
      report({
        node: expression,
        ruleId: 'query-mutates-state',
        message:
          'This method is marked @maintainabilityQuery and writes through this. A query that changes state surprises callers who expect a read. Move the write into a separate command method that callers invoke explicitly, or remove `@maintainabilityQuery` if the write is intentional.',
      });
    }
  }

  // Walks one function body in its own scope, then reports the deep nesting and branch complexity
  // it found.
  function enterFunction(
    node: SignatureDeclaration,
    body: ConciseBody,
    scope: FunctionScope | undefined,
    parent: Node | undefined,
  ): void {
    const writes: WeakSet<Node> | undefined = annotatedInstanceQuery(node, parent)
      ? new WeakSet()
      : invokedQueryArrows.has(node)
        ? scope?.writes
        : undefined;
    const inner: FunctionScope = {
      complexity: 1,
      maxDepth: 0,
      hasTraversalLeaf: false,
      traversalOnly: true,
      loops: 0,
      writes,
    };
    // Defaults execute on invocation, but do not contribute to the body's complexity.
    ts.forEachChild(node, (child) => {
      if (writes && ts.isParameter(child)) {
        const parameterScope: FunctionScope = {
          complexity: 1,
          maxDepth: 0,
          hasTraversalLeaf: false,
          traversalOnly: false,
          loops: 0,
          writes,
        };
        ts.forEachChild(child, (part) =>
          visit(part, part === child.name || part === child.initializer ? parameterScope : undefined, 0, child),
        );
      } else visit(child, child === body ? inner : undefined, 0, node);
    });
    if (inner.maxDepth >= nestingLimit && inner.deepest) {
      report(
        {
          node: inner.deepest,
          ruleId: 'deep-control-flow',
          message: `Control flow reaches ${inner.maxDepth} nested levels. Deep nesting hides which conditions lead to the code. Invert the outer condition into an early \`continue\` or \`return\` (a guard clause), or extract the inner block into a named function. Keep side effects and cleanup on both paths.`,
        },
        inner.hasTraversalLeaf &&
          inner.traversalOnly &&
          inner.complexity < branchComplexityLimit &&
          'The deepest nested loop branches retain an extreme value or enqueue an unseen item, with optional iteration guards.',
        nestingAdvice(inner.deepest, sourceFile),
        loopGuardComparison(inner.deepest, sourceFile),
        node,
      );
    }
    if (inner.complexity >= branchComplexityLimit) {
      report(
        {
          node: functionAnchor(node, parent),
          ruleId: 'high-branch-complexity',
          message: `This function has a branch complexity of ${inner.complexity}. Many branches in one function are hard to read and to test. Extract each distinct decision into a named function, or replace a chain of mutually exclusive cases with a lookup table of handlers. Keep the behavior for unmatched cases.`,
        },
        textChoiceContext(body, inner.complexity, branchComplexityLimit) ||
          patchMappingContext(body, inner.complexity, branchComplexityLimit) ||
          checklistContext(body, inner.complexity, branchComplexityLimit),
        sectionAdvice(inner.busiestStatement, sourceFile) ??
          (ts.isBlock(body)
            ? 'Group related decisions that share an outcome. A change should simplify more than one independent guard.'
            : 'Extract related conditions in this expression into a named calculation, preserving the order of evaluation.'),
        undefined,
        node,
      );
    }
  }

  // Notes the write a node performs inside a query method, and the arrows it invokes immediately.
  function recordWrite(node: Node, writes: WeakSet<Node>): void {
    if (ts.isBinaryExpression(node) && ts.isAssignmentOperator(node.operatorToken.kind)) {
      checkWriteTarget(node.left, writes);
    } else if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)
    ) {
      checkWriteTarget(node.operand, writes);
    } else if (ts.isDeleteExpression(node)) {
      checkWriteTarget(node.expression, writes);
    } else if (ts.isForInStatement(node) || ts.isForOfStatement(node)) {
      checkWriteTarget(node.initializer, writes);
    } else if (ts.isCallExpression(node)) {
      const callee = ts.skipOuterExpressions(node.expression);
      if (ts.isArrowFunction(callee)) invokedQueryArrows.add(callee);
    }
  }

  // The body that makes a statement one more level of nesting, when it has one.
  function nestedBodyOf(node: Node): Node | undefined {
    if (ts.isIfStatement(node)) return node.thenStatement;
    if (ts.isIterationStatement(node, false)) return node.statement;
    if (ts.isSwitchStatement(node)) return node.caseBlock;
    if (ts.isCatchClause(node)) return node.block;
    return undefined;
  }

  function visitFunctionBodyStatements(body: Block, scope: FunctionScope, depth: number): void {
    // Moving an isolated one-decision guard rarely makes the function easier to follow.
    let mostDecisions = 1;
    for (const statement of body.statements) {
      const before = scope.complexity;
      visit(statement, scope, depth, body);
      const decisions = scope.complexity - before;
      if (decisions > mostDecisions) {
        mostDecisions = decisions;
        scope.busiestStatement = statement;
      }
    }
  }

  function visitNestedStatement(node: Node, nestedBody: Node, scope: FunctionScope, depth: number): void {
    scope.complexity++;
    const nestedDepth = depth + 1;
    classifyNestedTraversal(nestedDepth, scope, node);
    if (nestedDepth > scope.maxDepth) {
      scope.maxDepth = nestedDepth;
      scope.deepest = node;
    }
    ts.forEachChild(node, (child) => {
      const alternative = ts.isIfStatement(node) && child === node.elseStatement && !ts.isIfStatement(child);
      const inLoop = child === nestedBody && ts.isIterationStatement(node, false);
      if (inLoop) scope.loops++;
      visit(child, scope, child === nestedBody || alternative ? nestedDepth : depth, node);
      if (inLoop) scope.loops--;
    });
  }

  // Handles one node. Function bodies and control flow recurse through visit; returns true when the
  // caller should descend into the children as plain syntax.
  function enter(
    node: Node,
    scope: FunctionScope | undefined,
    depth: number,
    parent: Node | undefined,
  ): true | undefined {
    if (ts.isFunctionLike(node) && 'body' in node && node.body) {
      enterFunction(node, node.body, scope, parent);
      return;
    }

    // A locally declared class can initialize fields and execute methods after the outer function
    // returns.
    if (!scope || ts.isClassLike(node)) return true;

    if (scope.writes) recordWrite(node, scope.writes);

    if (ts.isBlock(node) && parent && ts.isFunctionLike(parent) && 'body' in parent && parent.body === node) {
      visitFunctionBodyStatements(node, scope, depth);
      return;
    }

    const nestedBody = nestedBodyOf(node);

    if (nestedBody) {
      visitNestedStatement(node, nestedBody, scope, depth);
      return;
    }

    if (ts.isConditionalExpression(node)) scope.complexity++;
    return true;
  }

  // Operator chains can nest thousands deep, so plain descent uses an explicit stack in
  // forEachChild order. Nested visits share the stack; each one drains only the entries above its
  // own floor.
  const pendingNodes: Node[] = [];
  const pendingScopes: (FunctionScope | undefined)[] = [];
  const pendingDepths: number[] = [];
  const pendingParents: (Node | undefined)[] = [];
  function pushPending(node: Node, scope: FunctionScope | undefined, depth: number, parent: Node | undefined): void {
    pendingNodes.push(node);
    pendingScopes.push(scope);
    pendingDepths.push(depth);
    pendingParents.push(parent);
  }
  function visit(root: Node, rootScope: FunctionScope | undefined, rootDepth: number, rootParent?: Node): void {
    const floor = pendingNodes.length;
    pushPending(root, rootScope, rootDepth, rootParent);
    while (pendingNodes.length > floor) {
      const top = pendingNodes.length - 1;
      const node = pendingNodes[top];
      const scope = pendingScopes[top];
      const depth = pendingDepths[top];
      const parent = pendingParents[top];
      pendingNodes.pop();
      pendingScopes.pop();
      pendingDepths.pop();
      pendingParents.pop();
      if (!enter(node, scope, depth, parent)) continue;
      const childScope = scope && !ts.isClassLike(node) ? scope : undefined;
      const childDepth = childScope ? depth : 0;
      for (let index = bufferChildren(node) - 1; index >= 0; index--) {
        const child = childBuffer[index];
        // Tokens have no children and enter ignores them, so skipping them keeps the walk cheap.
        if (child.kind > ts.SyntaxKind.LastToken) pushPending(child, childScope, childDepth, node);
      }
    }
  }

  visit(sourceFile, undefined, 0);
  return findings;
}

function classifyNestedTraversal(nestedDepth: number, scope: FunctionScope, node: Node): void {
  if (nestedDepth >= nestingLimit && scope.traversalOnly) {
    if (nestedDepth > nestingLimit) scope.traversalOnly = false;
    else if (traversalLeaf(node, scope.loops)) scope.hasTraversalLeaf = true;
    else if (!loopGuard(node, scope.loops)) scope.traversalOnly = false;
  }
}

export { analyzeFunctions, functionAnchor };
