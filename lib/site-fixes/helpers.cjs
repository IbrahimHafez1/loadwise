'use strict';

// Shared syntax helpers for site-fix builders. Builders return edits as { start, end, text } file offsets.
const ts = require('typescript');

function ancestor(node, predicate) {
  for (let current = node; current; current = current.parent) if (predicate(current)) return current;
}

function functionWithBody(node) {
  return node !== undefined && ts.isFunctionLike(node) && node.body !== undefined;
}

// The function a finding names: findings point at its name, or at the variable or property that holds it.
function flaggedFunction(node) {
  if (functionWithBody(node)) return node;
  const parent = node.parent;
  if (functionWithBody(parent) && parent.name === node) return parent;
  // An anonymous `async (...) => {}` is reported at its first token, the async modifier.
  if (functionWithBody(parent) && parent.modifiers?.[0] === node) return parent;
  const named =
    parent &&
    (ts.isVariableDeclaration(parent) || ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent)) &&
    parent.name === node;
  if (named && functionWithBody(parent.initializer)) return parent.initializer;
}

function lineStart(text, offset) {
  return text.lastIndexOf('\n', offset - 1) + 1;
}

// Offset of the line break (or the end of the text) after `offset`.
function lineEnd(text, offset) {
  const index = text.indexOf('\n', offset);
  if (index === -1) return text.length;
  return text[index - 1] === '\r' ? index - 1 : index;
}

// Offset of the first character on the line after the one holding `offset`.
function nextLineStart(text, offset) {
  const index = text.indexOf('\n', offset);
  return index === -1 ? text.length : index + 1;
}

function indentationAt(text, offset) {
  return /^[ \t]*/.exec(text.slice(lineStart(text, offset)))[0];
}

function newlineOf(text) {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

function blank(text) {
  return !text.trim();
}

// True when `name` appears anywhere under `node`, so a new binding with that name could shadow or clash.
function nameUsed(node, name) {
  let used = false;
  (function visit(current) {
    if (used) return;
    if ((ts.isIdentifier(current) || ts.isPrivateIdentifier(current)) && current.text === name) used = true;
    else ts.forEachChild(current, visit);
  })(node);
  return used;
}

// `node` is alone on its lines: only indentation before it and nothing after it on its last line.
function ownsLines(node) {
  const sourceFile = node.getSourceFile();
  const text = sourceFile.text;
  const start = node.getStart(sourceFile);
  return blank(text.slice(lineStart(text, start), start)) && blank(text.slice(node.end, lineEnd(text, node.end)));
}

// A comment inside `node`; rewrites that rebuild the node's text from its parts would drop it.
function hasComments(node) {
  const sourceFile = node.getSourceFile();
  const start = node.getStart(sourceFile);
  let found = false;
  (function visit(current) {
    if (found) return;
    if (current.pos > start && ts.getLeadingCommentRanges(sourceFile.text, current.pos)?.length) found = true;
    else for (const child of current.getChildren(sourceFile)) visit(child);
  })(node);
  return found;
}

// Template text and multiline strings keep their indentation as part of their value.
function hasMultilineLiteral(node) {
  const sourceFile = node.getSourceFile();
  let found = false;
  (function visit(current) {
    if (found) return;
    const literal =
      ts.isTemplateLiteralToken(current) ||
      ts.isNoSubstitutionTemplateLiteral(current) ||
      ts.isStringLiteral(current) ||
      ts.isJsxText(current);
    if (literal && current.getText(sourceFile).includes('\n')) found = true;
    else ts.forEachChild(current, visit);
  })(node);
  return found;
}

// Removes one indentation `step` from each line, or undefined when a non-blank line is not indented that far.
// Callers reject multiline literals first, because their text would change.
function dedentLines(lines, step) {
  const result = [];
  for (const line of lines.split('\n')) {
    if (blank(line)) result.push(line.replace(/^[ \t]+/, ''));
    else if (line.startsWith(step)) result.push(line.slice(step.length));
    else return;
  }
  return result.join('\n');
}

// The block's statements as whole lines, with the indentation step they carry beyond `outerIndentation`.
// Undefined unless the braces sit alone at the ends of their lines.
function blockBody(block, outerIndentation) {
  const sourceFile = block.getSourceFile();
  const text = sourceFile.text;
  const open = block.getStart(sourceFile);
  const close = block.end - 1;
  if (!block.statements.length || !blank(text.slice(open + 1, lineEnd(text, open)))) return;
  if (!blank(text.slice(lineStart(text, close), close))) return;
  const first = block.statements[0].getStart(sourceFile);
  const indentation = indentationAt(text, first);
  if (!indentation.startsWith(outerIndentation) || indentation === outerIndentation) return;
  return {
    lines: text.slice(nextLineStart(text, open), lineStart(text, close)),
    step: indentation.slice(outerIndentation.length),
    closeLineStart: lineStart(text, close),
  };
}

const looseOperators = new Set([
  ts.SyntaxKind.BarBarToken,
  ts.SyntaxKind.QuestionQuestionToken,
  ts.SyntaxKind.CommaToken,
]);

// The expression as an operand of `&&` or `||`, parenthesized when it binds more loosely or cannot mix with them.
function logicalOperand(expression, sourceFile) {
  const text = expression.getText(sourceFile);
  const loose =
    (ts.isBinaryExpression(expression) &&
      (looseOperators.has(expression.operatorToken.kind) || ts.isAssignmentOperator(expression.operatorToken.kind))) ||
    ts.isConditionalExpression(expression) ||
    ts.isArrowFunction(expression) ||
    ts.isYieldExpression(expression);
  return loose ? '(' + text + ')' : text;
}

// The expression's text on one line, for joining conditions. Undefined when a comment or a multiline literal
// would change meaning once line breaks are gone.
function singleLine(text, node) {
  if (!text.includes('\n')) return text;
  if (hasComments(node) || hasMultilineLiteral(node)) return;
  // A trailing comma goes with its line break, but never one of two commas that mark an array hole.
  return text
    .replace(/([([])\s*\n\s*/g, '$1')
    .replace(/\{\s*\n\s*/g, '{ ')
    .replace(/(?<!,),?\s*\n\s*([)\]])/g, '$1')
    .replace(/(?<!,),?\s*\n\s*\}/g, ' }')
    .replace(/\s*\n\s*/g, ' ');
}

const comparisonInverses = new Map([
  [ts.SyntaxKind.EqualsEqualsEqualsToken, '!=='],
  [ts.SyntaxKind.ExclamationEqualsEqualsToken, '==='],
  [ts.SyntaxKind.EqualsEqualsToken, '!='],
  [ts.SyntaxKind.ExclamationEqualsToken, '=='],
]);

const logicalOperators = new Map([
  [ts.SyntaxKind.AmpersandAmpersandToken, '&&'],
  [ts.SyntaxKind.BarBarToken, '||'],
]);

function withoutParentheses(expression) {
  let bare = expression;
  while (ts.isParenthesizedExpression(bare)) bare = bare.expression;
  return bare;
}

function logicalOperator(expression) {
  return ts.isBinaryExpression(expression) ? logicalOperators.get(expression.operatorToken.kind) : undefined;
}

// The top-level operator that decides whether `text` needs parentheses inside an `&&` or `||` chain: '&&' or '||'
// for those chains, 'loose' for anything else that binds more loosely or cannot mix with them.
function joinOperator(expression) {
  const operator = logicalOperator(expression);
  if (operator) return operator;
  return logicalOperand(expression, expression.getSourceFile()).startsWith('(') ? 'loose' : undefined;
}

// The number of `&&` and `||` operands a reader has to keep in mind, through parentheses and negations.
function clauseCount(expression) {
  const bare = withoutParentheses(expression);
  if (logicalOperator(bare)) return clauseCount(bare.left) + clauseCount(bare.right);
  if (ts.isPrefixUnaryExpression(bare) && bare.operator === ts.SyntaxKind.ExclamationToken)
    return clauseCount(bare.operand);
  return 1;
}

// A rewritten condition line stays readable: short enough to scan, with few clauses to combine.
const maxConditionLineLength = 100;
const maxConditionClauses = 3;

function readableCondition(line, clauses) {
  return line.length <= maxConditionLineLength && clauses <= maxConditionClauses;
}

// Joins operands with `operator`, parenthesizing any whose own top-level operator differs, so `&&` and `||`
// never mix without explicit grouping.
function joinOperands(parts, operator) {
  return parts
    .map((part) => (part.operator && part.operator !== operator ? `(${part.text})` : part.text))
    .join(` ${operator} `);
}

// The negation of `expression` as { text, operator }. `&&` and `||` chains negate operand by operand (De Morgan),
// so a negated operand never ends up inside a second negation.
function negation(expression, sourceFile) {
  const bare = withoutParentheses(expression);
  const operator = logicalOperator(bare);
  if (operator) {
    const flipped = operator === '&&' ? '||' : '&&';
    const parts = [negation(bare.left, sourceFile), negation(bare.right, sourceFile)];
    return { text: joinOperands(parts, flipped), operator: flipped };
  }
  if (ts.isPrefixUnaryExpression(bare) && bare.operator === ts.SyntaxKind.ExclamationToken) {
    const operand = withoutParentheses(bare.operand);
    return { text: operand.getText(sourceFile), operator: joinOperator(operand) };
  }
  return { text: negatedTerm(bare, sourceFile) };
}

// A condition that is true exactly when `expression` is falsy. Only valid where the result is tested for truth.
function negateCondition(expression, sourceFile) {
  return negation(expression, sourceFile).text;
}

function negatedTerm(expression, sourceFile) {
  const text = expression.getText(sourceFile);
  if (ts.isBinaryExpression(expression) && comparisonInverses.has(expression.operatorToken.kind)) {
    const operator = expression.operatorToken;
    const start = expression.getStart(sourceFile);
    return (
      text.slice(0, operator.getStart(sourceFile) - start) +
      comparisonInverses.get(operator.kind) +
      text.slice(operator.end - start)
    );
  }
  const tight =
    ts.isIdentifier(expression) ||
    ts.isPropertyAccessExpression(expression) ||
    ts.isElementAccessExpression(expression) ||
    ts.isCallExpression(expression) ||
    ts.isParenthesizedExpression(expression);
  return tight ? '!' + text : '!(' + text + ')';
}

function addBindingNames(name, names) {
  if (ts.isIdentifier(name)) names.push(name.text);
  else for (const element of name.elements) if (!ts.isOmittedExpression(element)) addBindingNames(element.name, names);
}

// Names declared directly among `statements` with block scope.
function blockScopedNames(statements) {
  const names = [];
  for (const statement of statements) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) addBindingNames(declaration.name, names);
    } else if (
      (ts.isClassDeclaration(statement) ||
        ts.isEnumDeclaration(statement) ||
        ts.isInterfaceDeclaration(statement) ||
        ts.isTypeAliasDeclaration(statement)) &&
      statement.name
    )
      names.push(statement.name.text);
  }
  return names;
}

// Moving `statements` out into the scope of `container` must not shadow or clash with any name used there
// outside `moved`. Function declarations hoist differently in blocks, so they never move.
function canHoist(statements, container, moved) {
  if (statements.some((statement) => ts.isFunctionDeclaration(statement) || ts.isLabeledStatement(statement)))
    return false;
  const names = blockScopedNames(statements);
  if (!names.length) return true;
  const outside = new Set();
  (function collect(node) {
    if (node === moved) return;
    if (ts.isIdentifier(node)) outside.add(node.text);
    ts.forEachChild(node, collect);
  })(container);
  return names.every((name) => !outside.has(name));
}

module.exports = {
  ts,
  ancestor,
  functionWithBody,
  flaggedFunction,
  lineStart,
  lineEnd,
  nextLineStart,
  indentationAt,
  newlineOf,
  blank,
  nameUsed,
  ownsLines,
  hasComments,
  hasMultilineLiteral,
  dedentLines,
  blockBody,
  logicalOperand,
  singleLine,
  negateCondition,
  clauseCount,
  readableCondition,
  canHoist,
};
