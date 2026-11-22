'use strict';

const { requireReview, ts, ancestor, textOf, indentationAt } = require('./helpers.cjs');
const { declaresName } = require('./scope-names.cjs');
const { isRequestHandler, parameterName } = require('../request-handlers.cjs');

const BAD_REQUEST_STATUS = 400;
const INVALID_JSON_MESSAGE = 'Invalid JSON';
// How each response parameter name sends a JSON error body.
const errorResponses = {
  res: 'json',
  response: 'json',
  reply: 'send',
};

// Reads that cannot throw by themselves, so the try block only ever catches the parse failure.
function isPlainInput(node) {
  if (ts.isIdentifier(node) || node.kind === ts.SyntaxKind.ThisKeyword) return true;
  if (ts.isPropertyAccessExpression(node)) return isPlainInput(node.expression);
  if (ts.isElementAccessExpression(node))
    return ts.isStringLiteralLike(node.argumentExpression) && isPlainInput(node.expression);
  if (ts.isNonNullExpression(node) || ts.isParenthesizedExpression(node)) return isPlainInput(node.expression);
  return false;
}

function returnsValue(handler) {
  let found = false;
  (function visit(node) {
    if (found || (node !== handler && ts.isFunctionLike(node))) return;
    if (ts.isReturnStatement(node) && node.expression) found = true;
    else ts.forEachChild(node, visit);
  })(handler.body);
  return found;
}

// `const value = JSON.parse(input)` directly in a request handler: a malformed body is the caller's mistake, so the
// handler answers 400 where it would otherwise throw.
function answerBadRequest({ node, text }) {
  const call = ancestor(node, ts.isCallExpression);
  const declaration = call?.parent;
  if (!declaration || !ts.isVariableDeclaration(declaration) || declaration.initializer !== call) return;
  if (!ts.isIdentifier(declaration.name) || call.arguments.length !== 1 || !isPlainInput(call.arguments[0])) return;
  const list = declaration.parent;
  const statement = list.parent;
  if (list.declarations.length !== 1 || !(list.flags & ts.NodeFlags.Const)) return;
  if (!ts.isVariableStatement(statement) || statement.modifiers || !ts.isBlock(statement.parent)) return;
  const handler = ts.findAncestor(statement.parent, ts.isFunctionLike);
  if (!handler || handler.type || !isRequestHandler(handler) || ts.isMethodDeclaration(handler)) return;
  const responseName = parameterName(handler.parameters[1]);
  const sendMethod = errorResponses[responseName];
  if (!sendMethod || declaresName(handler.body, responseName)) return;

  const lineBreak = text.includes('\r\n') ? '\r\n' : '\n';
  const indentation = indentationAt(text, statement.getStart());
  const reply = `${responseName}.status(${BAD_REQUEST_STATUS}).${sendMethod}({ error: '${INVALID_JSON_MESSAGE}' })`;
  const exit = returnsValue(handler) ? [`return ${reply};`] : [`${reply};`, 'return;'];
  const typeText = declaration.type ? `: ${textOf(declaration.type)}` : '';
  const lines = [
    `let ${declaration.name.text}${typeText};`,
    'try {',
    `  ${declaration.name.text} = ${textOf(call)};`,
    '} catch {',
    ...exit.map((line) => `  ${line}`),
    '}',
  ];
  return {
    edits: [
      {
        start: statement.getStart(),
        end: statement.end,
        text: lines.map((line, index) => (index === 0 ? line : indentation + line)).join(lineBreak),
      },
    ],
    note: `The variable is now declared with let before the try. Check that a ${BAD_REQUEST_STATUS} with this body matches your API's error format.`,
  };
}

module.exports = {
  'json-parse-unguarded': requireReview(
    'The handler now answers 400 for malformed input instead of throwing, which changes the response clients see.',
    answerBadRequest,
  ),
};
