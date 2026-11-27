import ts from 'typescript';
import type { ConciseBody, Expression, Node, VariableDeclaration } from 'typescript';

function selectorKey(expression: Expression): string | undefined {
  const node = ts.skipOuterExpressions(expression);
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
    return node.expression.text + '.' + node.name.text;
  }
  if (ts.isStringLiteralLike(node)) return JSON.stringify(node.text);
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken) {
    const left = selectorKey(node.left),
      right = selectorKey(node.right);
    if (left && right) return '(' + left + '===' + right + ')';
  }
}

// Only standalone data or static markup qualifies. A component that also performs
// business logic keeps its advisory even if most of its strings use one selector.
function textChoiceContext(body: ConciseBody, score: number, threshold: number): string | undefined {
  if (score < threshold) return;
  const locals = new Set<string>();
  let selector: string | undefined,
    choices = 0;
  function literalData(expression: Node): boolean {
    const node = ts.skipOuterExpressions(expression);
    if (ts.isConditionalExpression(node)) {
      const key = selectorKey(node.condition);
      if (
        !key ||
        (selector && key !== selector) ||
        !ts.isStringLiteralLike(node.whenTrue) ||
        !ts.isStringLiteralLike(node.whenFalse)
      )
        return false;
      selector = key;
      choices++;
      return true;
    }
    if (ts.isObjectLiteralExpression(node))
      return node.properties.every(
        (property) =>
          (ts.isPropertyAssignment(property) &&
            !ts.isComputedPropertyName(property.name) &&
            literalData(property.initializer)) ||
          (ts.isShorthandPropertyAssignment(property) &&
            locals.has(property.name.text) &&
            !property.objectAssignmentInitializer),
      );
    if (ts.isArrayLiteralExpression(node)) return node.elements.every(literalData);
    if (ts.isJsxFragment(node)) return node.children.every(literalData);
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = ts.isJsxElement(node) ? node.openingElement : node;
      return (
        ts.isIdentifier(tag.tagName) &&
        /^[a-z]/.test(tag.tagName.text) &&
        tag.attributes.properties.every(
          (attribute) =>
            ts.isJsxAttribute(attribute) && (!attribute.initializer || ts.isStringLiteral(attribute.initializer)),
        ) &&
        (!ts.isJsxElement(node) || node.children.every(literalData))
      );
    }
    if (ts.isJsxExpression(node)) return !node.dotDotDotToken && (!node.expression || literalData(node.expression));
    return (
      ts.isStringLiteralLike(node) ||
      ts.isNumericLiteral(node) ||
      ts.isJsxText(node) ||
      node.kind === ts.SyntaxKind.TrueKeyword ||
      node.kind === ts.SyntaxKind.FalseKeyword ||
      node.kind === ts.SyntaxKind.NullKeyword ||
      (ts.isIdentifier(node) && locals.has(node.text))
    );
  }
  // A local counts only when it is a plain identifier bound to a selector or literal data.
  function acceptLocal(declaration: VariableDeclaration): boolean {
    if (
      !ts.isIdentifier(declaration.name) ||
      !declaration.initializer ||
      (!selectorKey(declaration.initializer) && !literalData(declaration.initializer))
    )
      return false;
    locals.add(declaration.name.text);
    return true;
  }
  let result: Node = body;
  if (ts.isBlock(body)) {
    const last = body.statements.at(-1);
    if (!last || !ts.isReturnStatement(last) || !last.expression) return;
    for (const statement of body.statements.slice(0, -1)) {
      if (!ts.isVariableStatement(statement) || !(statement.declarationList.flags & ts.NodeFlags.Const)) return;
      if (!statement.declarationList.declarations.every(acceptLocal)) return;
    }
    result = last.expression;
  }
  if (literalData(result) && choices >= threshold - 1 && score === choices + 1) {
    return 'This function returns literal data or static markup, repeatedly selecting text with the same condition.';
  }
}

function loopGuard(node: Node, ancestors: number): boolean {
  if (ancestors < 2 || !ts.isIfStatement(node) || node.elseStatement) return false;
  const body = node.thenStatement;
  const guard = ts.isBlock(body) && body.statements.length === 1 ? body.statements[0] : body;
  return ts.isContinueStatement(guard) && !guard.label;
}

function patchMappingContext(body: ConciseBody, score: number, threshold: number): string | undefined {
  if (!ts.isBlock(body) || body.statements.length < threshold - 1) return;
  const copied = new Set<string>();
  const written = new Set<string>();
  let source: string | undefined, target: string | undefined;
  function omissionGuard(condition: Expression): boolean {
    condition = ts.skipOuterExpressions(condition);
    if (!ts.isBinaryExpression(condition)) return false;
    if (condition.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
      return omissionGuard(condition.left) && omissionGuard(condition.right);
    }
    const field = condition.left;
    if (
      condition.operatorToken.kind !== ts.SyntaxKind.ExclamationEqualsEqualsToken ||
      !ts.isIdentifier(condition.right) ||
      condition.right.text !== 'undefined' ||
      !ts.isPropertyAccessExpression(field) ||
      !ts.isIdentifier(field.expression)
    )
      return false;
    source ??= field.expression.text;
    return field.expression.text === source;
  }
  function projection(expression: Expression): boolean {
    if (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression)) {
      return expression.expression.text === source;
    }
    if (expression.kind === ts.SyntaxKind.NullKeyword) return true;
    if (ts.isConditionalExpression(expression))
      return projection(expression.condition) && projection(expression.whenTrue) && projection(expression.whenFalse);
    if (
      ts.isBinaryExpression(expression) &&
      [
        ts.SyntaxKind.QuestionQuestionToken,
        ts.SyntaxKind.AmpersandAmpersandToken,
        ts.SyntaxKind.ExclamationEqualsEqualsToken,
        ts.SyntaxKind.EqualsEqualsEqualsToken,
      ].includes(expression.operatorToken.kind)
    ) {
      return projection(expression.left) && projection(expression.right);
    }
    if (ts.isNewExpression(expression))
      return (
        ts.isIdentifier(expression.expression) &&
        expression.expression.text === 'Date' &&
        expression.arguments?.length === 0
      );
    return (
      ts.isCallExpression(expression) &&
      !expression.arguments.length &&
      ts.isPropertyAccessExpression(expression.expression) &&
      ['trim', 'toLowerCase', 'toUpperCase'].includes(expression.expression.name.text) &&
      projection(expression.expression.expression)
    );
  }
  for (const clause of body.statements) {
    if (!ts.isIfStatement(clause) || clause.elseStatement || !omissionGuard(clause.expression)) return;
    const writes = ts.isBlock(clause.thenStatement) ? clause.thenStatement.statements : [clause.thenStatement];
    if (!writes.length) return;
    for (const statement of writes) {
      const store = ts.isExpressionStatement(statement) && statement.expression;
      if (
        !store ||
        !ts.isBinaryExpression(store) ||
        store.operatorToken.kind !== ts.SyntaxKind.EqualsToken ||
        !ts.isPropertyAccessExpression(store.left) ||
        !ts.isIdentifier(store.left.expression) ||
        !projection(store.right)
      )
        return;
      target ??= store.left.expression.text;
      const field = store.left.name.text;
      if (source === target || target !== store.left.expression.text || written.has(field)) return;
      written.add(field);
      const guard = ts.skipOuterExpressions(clause.expression);
      if (
        writes.length === 1 &&
        ts.isBinaryExpression(guard) &&
        ts.isPropertyAccessExpression(guard.left) &&
        guard.left.name.text === field &&
        ts.isPropertyAccessExpression(store.right) &&
        store.right.name.text === field
      )
        copied.add(field);
    }
  }
  if (copied.size >= threshold - 1 && score - copied.size < threshold && copied.size * 2 > score) {
    return 'Most decisions copy distinct optional fields between the same two objects when the input field is present.';
  }
}

export { textChoiceContext, loopGuard, patchMappingContext };
