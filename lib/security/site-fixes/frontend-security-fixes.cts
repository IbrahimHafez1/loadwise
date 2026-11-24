// Rule id -> build({ finding, node, sourceFile, text, load }) => { edits, note } | undefined; see
// lib/performance/site-fix.cjs.
import { requireReview, ts, ancestor, calleeCall } from '../../performance/site-fixes/helpers.cjs';
import type { FixResult, SiteFixBuilder, SiteFixInput } from '../../shared/types.cjs';

// Receivers that are the current window, so its own origin is the right recipient.
const SELF_WINDOWS = new Set(['window', 'self', 'globalThis']);

// Rewrites the reported `el.innerHTML = expr` to `el.textContent = expr`. Only a plain assignment
// that starts at the
// finding: a call sink such as `insertAdjacentHTML` has no text equivalent.
function domXssTextContentFix({ node }: SiteFixInput): FixResult | undefined {
  if (!node) return;
  const assignment = ancestor(node, ts.isBinaryExpression);
  if (!assignment || assignment.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return;
  const sourceFile = assignment.getSourceFile();
  if (assignment.getStart(sourceFile) !== node.getStart(sourceFile)) return;
  const target = assignment.left;
  if (!ts.isPropertyAccessExpression(target) || target.name.text !== 'innerHTML') return;
  return {
    edits: [{ start: target.name.getStart(sourceFile), end: target.name.end, text: 'textContent' }],
    note: 'Replaced `innerHTML` with `textContent`. If HTML formatting is required, sanitize with `DOMPurify.sanitize(...)` instead.',
  };
}

// `window.postMessage(data, '*')` -> `window.postMessage(data, window.location.origin)`. Any other
// receiver is a different window whose origin only the author knows, so no fix is offered.
function postMessageOriginFix({ node }: SiteFixInput): FixResult | undefined {
  if (!node) return;
  const call = calleeCall(node);
  if (!call || !ts.isPropertyAccessExpression(call.expression) || call.arguments.length < 2) return;
  const receiver = call.expression.expression;
  const targetOrigin = call.arguments[1];
  if (!ts.isIdentifier(receiver) || !SELF_WINDOWS.has(receiver.text)) return;
  if (!ts.isStringLiteralLike(targetOrigin) || targetOrigin.text !== '*') return;
  const sourceFile = call.getSourceFile();
  return {
    edits: [
      { start: targetOrigin.getStart(sourceFile), end: targetOrigin.end, text: `${receiver.text}.location.origin` },
    ],
    note: 'Restricted the `postMessage` target origin from `*` to the current origin. A page served from a `file:` URL has the origin `null`, which `postMessage` rejects.',
  };
}

const builders: Record<string, SiteFixBuilder> = {
  'dom-xss-sink': requireReview(
    'Switching `innerHTML` to `textContent` renders HTML tags as plain text; use `DOMPurify.sanitize()` if markup is intended.',
    domXssTextContentFix,
  ),
  'postmessage-missing-origin-check': requireReview(
    'Check that the message listener in this window expects messages from its own origin only.',
    postMessageOriginFix,
  ),
};

export default builders;
