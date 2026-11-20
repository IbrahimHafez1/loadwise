'use strict';

const ts = require('typescript');
const { traversalLeaf } = require('./traversal-context.cjs');
const { textChoiceContext, loopGuard, patchMappingContext } = require('./advisory-context.cjs');

const nestingLimit = 4;
const branchComplexityLimit = 15;

function annotatedInstanceQuery(node, parent) {
  return (
    node.jsDoc &&
    ts.isMethodDeclaration(node) &&
    ts.isClassLike(parent) &&
    !node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword) &&
    node.jsDoc.some((comment) => comment.tags?.some((tag) => tag.tagName.text === 'maintainabilityQuery'))
  );
}

function writesThroughThis(target) {
  let receiver = target;
  while (ts.isPropertyAccessExpression(receiver) || ts.isElementAccessExpression(receiver)) {
    receiver = ts.skipOuterExpressions(receiver.expression);
    if (receiver.kind === ts.SyntaxKind.ThisKeyword) return true;
  }
  return false;
}

function functionAnchor(node, parent) {
  if (node.name) return node.name;
  if ((ts.isVariableDeclaration(parent) || ts.isPropertyAssignment(parent)) && parent.initializer === node)
    return parent.name;
  return node;
}

function analyzeFunctions(sourceFile, relativePath) {
  const findings = [];
  const invokedQueryArrows = new WeakSet();

  function report(node, ruleId, message, contextualReason) {
    const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    findings.push({
      file: relativePath,
      line: start.line + 1,
      column: start.character + 1,
      ruleId,
      message,
      ...(contextualReason && { contextualReason }),
    });
  }

  function checkWriteTarget(target, writes) {
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
      report(
        expression,
        'query-mutates-state',
        'This method is marked @maintainabilityQuery and writes through this. Move the write to a command or remove the annotation if the change is intentional.',
      );
    }
  }

  function visit(node, scope, depth, parent) {
    if (ts.isFunctionLike(node) && node.body) {
      const writes = annotatedInstanceQuery(node, parent)
        ? new WeakSet()
        : invokedQueryArrows.has(node)
          ? scope?.writes
          : undefined;
      const inner = {
        complexity: 1,
        maxDepth: 0,
        deepest: undefined,
        hasTraversalLeaf: false,
        traversalOnly: true,
        loops: 0,
        writes,
      };
      // Defaults execute on invocation, but do not contribute to the body's complexity.
      ts.forEachChild(node, (child) => {
        if (writes && ts.isParameter(child)) {
          const parameterScope = { complexity: 1, maxDepth: 0, writes };
          ts.forEachChild(child, (part) =>
            visit(part, part === child.name || part === child.initializer ? parameterScope : undefined, 0, child),
          );
        } else visit(child, child === node.body ? inner : undefined, 0, node);
      });
      if (inner.maxDepth >= nestingLimit) {
        report(
          inner.deepest,
          'deep-control-flow',
          `Control flow reaches ${inner.maxDepth} nested levels. Review whether a guard clause or a named operation would clarify this path.`,
          inner.hasTraversalLeaf &&
            inner.traversalOnly &&
            inner.complexity < branchComplexityLimit &&
            'The deepest nested loop branches retain an extreme value or enqueue an unseen item, with optional iteration guards.',
        );
      }
      if (inner.complexity >= branchComplexityLimit) {
        report(
          functionAnchor(node, parent),
          'high-branch-complexity',
          `This function has a branch complexity of ${inner.complexity}. Review whether distinct decisions belong in smaller functions.`,
          textChoiceContext(node.body, inner.complexity, branchComplexityLimit) ||
            patchMappingContext(node.body, inner.complexity, branchComplexityLimit),
        );
      }
      return;
    }

    // A locally declared class can initialize fields and execute methods after the outer function returns.
    if (!scope || ts.isClassLike(node)) {
      ts.forEachChild(node, (child) => visit(child, undefined, 0, node));
      return;
    }

    if (scope.writes) {
      if (ts.isBinaryExpression(node) && ts.isAssignmentOperator(node.operatorToken.kind)) {
        checkWriteTarget(node.left, scope.writes);
      } else if (
        (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
        (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)
      ) {
        checkWriteTarget(node.operand, scope.writes);
      } else if (ts.isDeleteExpression(node)) {
        checkWriteTarget(node.expression, scope.writes);
      } else if (ts.isForInStatement(node) || ts.isForOfStatement(node)) {
        checkWriteTarget(node.initializer, scope.writes);
      } else if (ts.isCallExpression(node)) {
        const callee = ts.skipOuterExpressions(node.expression);
        if (ts.isArrowFunction(callee)) invokedQueryArrows.add(callee);
      }
    }

    let nestedBody;
    if (ts.isIfStatement(node)) nestedBody = node.thenStatement;
    else if (ts.isIterationStatement(node, false)) nestedBody = node.statement;
    else if (ts.isSwitchStatement(node)) nestedBody = node.caseBlock;
    else if (ts.isCatchClause(node)) nestedBody = node.block;

    if (nestedBody) {
      scope.complexity++;
      const nestedDepth = depth + 1;
      if (nestedDepth >= nestingLimit && scope.traversalOnly) {
        if (nestedDepth > nestingLimit) scope.traversalOnly = false;
        else if (traversalLeaf(node, scope.loops)) scope.hasTraversalLeaf = true;
        else if (!loopGuard(node, scope.loops)) scope.traversalOnly = false;
      }
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
      return;
    }

    if (ts.isConditionalExpression(node)) scope.complexity++;
    ts.forEachChild(node, (child) => visit(child, scope, depth, node));
  }

  visit(sourceFile, undefined, 0);
  return findings;
}

module.exports = { analyzeFunctions };
