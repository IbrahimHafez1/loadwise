import { loadSyntax, isDefaultLibrary } from './compiler.cjs';
import { findRepeatOwner } from './repeated.cjs';
import { isSequentialByDesign, iteratesArrayLiteral } from './sequential-loops.cjs';
import type { CallExpression, Expression, Node, PropertyAccessExpression } from 'typescript';
import type { CheckerAdapter, PerformanceRuleContext, TypeAdapter } from '../shared/types.cjs';
import type { RepeatOwner } from './types/repeat-owner.cjs';
const ts = loadSyntax();

const QUEUE_PACKAGES = ['bullmq', 'bull', '@types/bull'];
const QUEUE_TYPE_NAMES = ['Queue'];

function isArrayType(type: TypeAdapter, checker: CheckerAdapter) {
  const symbol = type.getSymbol();
  return (
    !!symbol &&
    ['Array', 'ReadonlyArray'].includes(symbol.name) &&
    !!symbol.declarations?.some((declaration) => isDefaultLibrary(checker, declaration.getSourceFile()))
  );
}

// What the addBulk fix may call on the collection a for-of walks: `.map` exists only on arrays, any
// other iterable goes through Array.from, and a collection typed any or unknown gets no rewrite.
function collectionKind(owner: RepeatOwner, checker: CheckerAdapter) {
  if (!ts.isForOfStatement(owner)) return;
  const type = checker.getTypeAtLocation(owner.expression);
  const members = type.isUnion() ? (type.types ?? []) : [type];
  if (members.some((member) => member.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown))) return;
  return members.every((member) => isArrayType(member, checker)) ? 'array' : 'iterable';
}

function queueLabel(receiver: Expression) {
  const expression = ts.skipOuterExpressions(receiver);
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  return 'queue';
}

// A call whose callee is `receiver.add` on a Queue.
interface QueueAddCall extends CallExpression {
  expression: PropertyAccessExpression;
}

function isQueueAdd(call: CallExpression, context: PerformanceRuleContext): call is QueueAddCall {
  const callee = call.expression;
  return (
    ts.isPropertyAccessExpression(callee) &&
    callee.name.text === 'add' &&
    context.isPackageType(callee.expression, QUEUE_PACKAGES, QUEUE_TYPE_NAMES)
  );
}

// Per declaration: the queue `add` call a project wrapper makes once per call, if any.
const wrappedAdds = new WeakMap<Node, QueueAddCall | undefined>();

// A project function such as `private add(job) { return this.queue.add(job.name, job) }` that
// enqueues one job.
function wrappedQueueAdd(call: CallExpression, context: PerformanceRuleContext): QueueAddCall | undefined {
  const declaration = context.checker.getResolvedSignature(call)?.declaration;
  if (!declaration || !ts.isFunctionLike(declaration) || !('body' in declaration) || !declaration.body) return;
  const body = declaration.body;
  if (declaration.getSourceFile().isDeclarationFile) return;
  if (!wrappedAdds.has(declaration)) {
    let found: QueueAddCall | undefined;
    (function visit(node: Node) {
      if (found || (node !== body && ts.isFunctionLike(node))) return;
      if (ts.isCallExpression(node) && isQueueAdd(node, context) && !findRepeatOwner(node, context.checker))
        found = node;
      else ts.forEachChild(node, visit);
    })(body);
    wrappedAdds.set(declaration, found);
  }
  return wrappedAdds.get(declaration);
}

function check(node: CallExpression, context: PerformanceRuleContext) {
  const callee = node.expression;
  if (!ts.isPropertyAccessExpression(callee) && !ts.isIdentifier(callee)) return;
  if (!context.isRepeated(node)) return;
  const direct = isQueueAdd(node, context);
  const wrapped = !direct && wrappedQueueAdd(node, context);
  if (!direct && !wrapped) return;
  const owner = findRepeatOwner(node, context.checker);
  if (!owner || isSequentialByDesign(node, owner) || iteratesArrayLiteral(owner)) return;
  if (wrapped) {
    const label = queueLabel(wrapped.expression.expression);
    // Reported on the whole callee: the addBulk rewrite applies only to a direct Queue.add.
    context.report(
      callee,
      'queue-add-in-loop',
      `\`${callee.getText()}()\` enqueues one job per item through \`${label}.add\`, and each call is its own Redis round trip (a MULTI/EXEC script). Add a variant that collects the jobs and sends them with \`${label}.addBulk(jobs)\` in one call. Ignore if a later job needs the earlier job's result or id.`,
    );
    return;
  }
  if (!ts.isPropertyAccessExpression(callee)) return;
  const label = queueLabel(callee.expression);
  const kind = collectionKind(owner, context.checker);
  context.report(
    callee.name,
    'queue-add-in-loop',
    `\`${label}.add\` enqueues one job per item, and each call is its own Redis round trip (a MULTI/EXEC script). Collect the jobs and send them with \`${label}.addBulk(jobs)\` in one call. Ignore if a later job needs the earlier job's result or id.`,
    undefined,
    kind && { collectionKind: kind },
  );
}

export { check, wrappedQueueAdd };
