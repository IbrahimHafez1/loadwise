import { requireReview, ts, ancestor, textOf, indentationAt } from './helpers.cjs';
import { declaresName } from './scope-names.cjs';
import { isRequestHandler, parameterName } from '../request-handlers.cjs';
import type {
  CallExpression,
  Identifier,
  Node,
  SignatureDeclaration,
  VariableDeclaration,
  VariableStatement,
} from 'typescript';
import type { FixResult, SiteFixInput } from '../../shared/types.cjs';

const BAD_REQUEST_STATUS = 400;
const INVALID_JSON_MESSAGE = 'Invalid JSON';
// How each response parameter name sends a JSON error body.
const errorResponses: Record<string, string> = {
  res: 'json',
  response: 'json',
  reply: 'send',
};

// Reads that cannot throw by themselves, so the try block only ever catches the parse failure.
function isPlainInput(node: Node): boolean {
  if (ts.isIdentifier(node) || node.kind === ts.SyntaxKind.ThisKeyword) return true;
  if (ts.isPropertyAccessExpression(node)) return isPlainInput(node.expression);
  if (ts.isElementAccessExpression(node))
    return ts.isStringLiteralLike(node.argumentExpression) && isPlainInput(node.expression);
  if (ts.isNonNullExpression(node) || ts.isParenthesizedExpression(node)) return isPlainInput(node.expression);
  return false;
}

function returnsValue(handler: Node, body: Node): boolean {
  let found = false;
  (function visit(node: Node): void {
    if (found || (node !== handler && ts.isFunctionLike(node))) return;
    if (ts.isReturnStatement(node) && node.expression) found = true;
    else ts.forEachChild(node, visit);
  })(body);
  return found;
}

// A `const value = JSON.parse(input)` declaration whose input is a plain read.
interface ParsedDeclaration {
  call: CallExpression;
  declaration: VariableDeclaration;
  name: Identifier;
}

// The handler around the statement and how it sends the 400 reply.
interface HandlerReply {
  handler: SignatureDeclaration;
  handlerBody: Node;
  responseName: string;
  sendMethod: string;
}

function parsedDeclaration(node: Node): ParsedDeclaration | undefined {
  const call = ancestor(node, ts.isCallExpression);
  if (!call) return;
  const declaration = call.parent;
  if (!ts.isVariableDeclaration(declaration) || declaration.initializer !== call) return;
  if (!ts.isIdentifier(declaration.name) || call.arguments.length !== 1 || !isPlainInput(call.arguments[0])) return;
  return { call, declaration, name: declaration.name };
}

// The sole-declaration, non-exported `const` statement that sits directly in a block.
function blockConstStatement(declaration: VariableDeclaration): VariableStatement | undefined {
  const list = declaration.parent;
  if (!ts.isVariableDeclarationList(list)) return;
  const statement = list.parent;
  if (list.declarations.length !== 1 || !(list.flags & ts.NodeFlags.Const)) return;
  if (!ts.isVariableStatement(statement) || statement.modifiers || !ts.isBlock(statement.parent)) return;
  return statement;
}

function handlerReply(statement: VariableStatement): HandlerReply | undefined {
  const handler = ts.findAncestor(statement.parent, ts.isFunctionLike);
  if (!handler || handler.type || !isRequestHandler(handler) || ts.isMethodDeclaration(handler)) return;
  const handlerBody = 'body' in handler ? handler.body : undefined;
  const responseName = parameterName(handler.parameters[1]);
  if (!handlerBody || !responseName) return;
  const sendMethod = errorResponses[responseName];
  if (!sendMethod || declaresName(handlerBody, responseName)) return;
  return { handler, handlerBody, responseName, sendMethod };
}

// `const value = JSON.parse(input)` directly in a request handler: a malformed body is the caller's
// mistake, so the handler answers 400 where it would otherwise throw.
function answerBadRequest({ node, text }: SiteFixInput): FixResult | undefined {
  if (!node || text === undefined) return;
  const parsed = parsedDeclaration(node);
  if (!parsed) return;
  const { call, declaration, name } = parsed;
  const statement = blockConstStatement(declaration);
  if (!statement) return;
  const reply = handlerReply(statement);
  if (!reply) return;
  const { handler, handlerBody, responseName, sendMethod } = reply;

  const lineBreak = text.includes('\r\n') ? '\r\n' : '\n';
  const indentation = indentationAt(text, statement.getStart());
  const replyCall = `${responseName}.status(${BAD_REQUEST_STATUS}).${sendMethod}({ error: '${INVALID_JSON_MESSAGE}' })`;
  const exit = returnsValue(handler, handlerBody) ? [`return ${replyCall};`] : [`${replyCall};`, 'return;'];
  const typeText = declaration.type ? `: ${textOf(declaration.type)}` : '';
  const lines = [
    `let ${name.text}${typeText};`,
    'try {',
    `  ${name.text} = ${textOf(call)};`,
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

export default {
  'json-parse-unguarded': requireReview(
    'The handler now answers 400 for malformed input instead of throwing, which changes the response clients see.',
    answerBadRequest,
  ),
};
