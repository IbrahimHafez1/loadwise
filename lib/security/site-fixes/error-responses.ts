// Rule id -> build({ finding, node, sourceFile, text, load }) => { edits, note } | undefined; see
// lib/performance/site-fix.cjs. Every fix here changes what the client receives, so each one is
// review-only and keeps the response status.
import { ts, ancestor, replaceNode } from '../../performance/site-fixes/helpers.js';
import { removeListItem } from './list-edits.js';
import type { Node, PropertyAccessExpression, PropertyAssignment, ShorthandPropertyAssignment } from 'typescript';
import type { FixResult, SiteFixBuilder } from '../../shared/types.js';

const genericMessage = "'Internal server error'";
const genericBody = `{ message: ${genericMessage} }`;
const bodyWriters = new Set(['send', 'json']);
const stackPropertyName = /stack|trace/i;
const reviewNote =
  'Clients that read the removed or replaced field now get a generic value; the status code is unchanged. This fix does not log the error: log it server-side where it is caught if it is not already.';
const contextualNote =
  ' This handler may also receive errors that did not come from the database; their messages are replaced as well.';

function sameStart(node: Node, reference: Node) {
  return node.getStart() === reference.getStart();
}

// The expression the finding was reported on: `err.stack`, `err.message`, a whole `err`, or a
// shorthand `{ err }`.
function reportedValue(
  node: Node,
  leaf: string,
): ShorthandPropertyAssignment | PropertyAccessExpression | Node | undefined {
  if (ts.isShorthandPropertyAssignment(node.parent) && node.parent.name === node) return node.parent;
  const read = ancestor(
    node,
    (candidate): candidate is PropertyAccessExpression =>
      ts.isPropertyAccessExpression(candidate) && sameStart(candidate, node),
  );
  if (read?.name.text === leaf) return read;
  if (ts.isIdentifier(node) && !ts.isPropertyAccessExpression(node.parent)) return node;
}

// `err.stack.split('\n')` and `err.stack?.trim()` are still the stack: climb to the whole receiver
// chain.
function receiverChainEnd(value: Node): Node {
  let end = value;
  while (
    (ts.isPropertyAccessExpression(end.parent) && end.parent.expression === end) ||
    (ts.isCallExpression(end.parent) && end.parent.expression === end)
  )
    end = end.parent;
  return end;
}

function isBodyWriterArgument(value: Node) {
  const call = value.parent;
  if (!ts.isCallExpression(call) || !call.arguments.some((argument) => argument === value)) return false;
  const callee = call.expression;
  return ts.isPropertyAccessExpression(callee) && bodyWriters.has(callee.name.text);
}

function dropFromObject(item: Node): FixResult | undefined {
  if (!ts.isObjectLiteralExpression(item.parent)) return;
  const edit = removeListItem(item.parent.properties, item);
  return edit ? { edits: [edit] } : undefined;
}

function replaceProperty(
  property: PropertyAssignment | ShorthandPropertyAssignment,
  isWholeError: boolean,
): FixResult | undefined {
  if (ts.isShorthandPropertyAssignment(property))
    return { edits: [replaceNode(property, `${property.name.text}: ${genericMessage}`)] };
  if (!isWholeError && stackPropertyName.test(property.name.getText())) return dropFromObject(property);
  return { edits: [replaceNode(property.initializer, genericMessage)] };
}

function fixForValue(value: Node, isWholeError: boolean): FixResult | undefined {
  const parent = value.parent;
  if (ts.isShorthandPropertyAssignment(value)) return replaceProperty(value, isWholeError);
  if (ts.isSpreadAssignment(parent)) return dropFromObject(parent);
  if (ts.isPropertyAssignment(parent) && parent.initializer === value) return replaceProperty(parent, isWholeError);
  if (isBodyWriterArgument(value)) return { edits: [replaceNode(value, isWholeError ? genericBody : genericMessage)] };
}

function responseFix(leaf: string): SiteFixBuilder {
  return ({ finding, node }) => {
    if (!node) return;
    const reported = reportedValue(node, leaf);
    if (!reported) return;
    const isRead = ts.isPropertyAccessExpression(reported);
    const fix = fixForValue(isRead ? receiverChainEnd(reported) : reported, !isRead);
    if (!fix) return;
    return { ...fix, requiresReview: true, note: reviewNote + (finding.contextualReason ? contextualNote : '') };
  };
}

const builders: Record<string, SiteFixBuilder> = {
  'error-stack-in-response': responseFix('stack'),
  'database-error-in-response': responseFix('message'),
};

export default builders;
