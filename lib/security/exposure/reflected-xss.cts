// reflected-xss-response: request data interpolated into an HTML string that is sent back
// unescaped.
import { loadSyntax } from '../../performance/compiler.cjs';
import { unwrap, chainRootName, methodName } from './literals.cjs';
import { reportTraced } from './report.cjs';
import type { BinaryExpression, CallExpression, Expression } from 'typescript';
import type { SecurityRuleContext } from '../../shared/types.cjs';
const ts = loadSyntax();

const ruleId = 'reflected-xss-response';
const message = '`<source>` is placed into an HTML response without escaping. Escape it or return JSON.';
const contextualReason = 'Contextual in v1; confirm the response is served as HTML.';
const responseNames = new Set(['res', 'response', 'reply']);
const jsonContentTypePattern = /application\/json|\.type\(\s*['"]json['"]\s*\)/;

interface StringParts {
  values: Expression[];
  hasMarkup: boolean;
}

// The parts of a string built by a template or `+`, and whether any literal part opens a tag.
function stringParts(expression: Expression, parts: StringParts = { values: [], hasMarkup: false }): StringParts {
  const node = unwrap(expression);
  if (ts.isTemplateExpression(node)) {
    parts.hasMarkup ||=
      node.head.text.includes('<') || node.templateSpans.some((span) => span.literal.text.includes('<'));
    node.templateSpans.forEach((span) => parts.values.push(span.expression));
  } else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    stringParts(node.left, parts);
    stringParts(node.right, parts);
  } else if (ts.isStringLiteralLike(node)) parts.hasMarkup ||= node.text.includes('<');
  else parts.values.push(node);
  return parts;
}

function checkBody(body: Expression, context: SecurityRuleContext) {
  const scope = ts.findAncestor(body, ts.isFunctionLike);
  if (scope && jsonContentTypePattern.test(scope.getText())) return;
  const parts = stringParts(body);
  if (!parts.hasMarkup) return;
  for (const value of parts.values) {
    const traced = context.taint.trace(value, 'html');
    if (traced)
      return reportTraced(context, value, ruleId, message.replace('<source>', traced.label), traced, contextualReason);
  }
}

function checkCall(call: CallExpression, context: SecurityRuleContext) {
  const rootName = chainRootName(call.expression);
  if (methodName(call) !== 'send' || !rootName || !responseNames.has(rootName)) return;
  if (call.arguments[0]) checkBody(call.arguments[0], context);
}

// `ctx.body = '<p>' + ctx.query.name`
function checkAssignment(node: BinaryExpression, context: SecurityRuleContext) {
  if (node.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return;
  const target = unwrap(node.left);
  if (ts.isPropertyAccessExpression(target) && target.name.text === 'body' && chainRootName(target) === 'ctx')
    checkBody(node.right, context);
}

export { checkCall, checkAssignment };
