// The fallback fix: when no batch sibling can be derived and the helper only runs overlap-safe
// cache commands, run the calls a few at a time.
import { ts, freshName, indentationAt, textOf } from './helpers.cjs';
import { isPropertyName, contains, lastSegment } from './service-loop-ast.cjs';
import { relatedLocations } from './service-loop-callee.cjs';
import { soleLoopSite } from './service-loop-sites.cjs';
import type { Node } from 'typescript';
import type { BatchedFixInput } from '../types/batched-fix-input.cjs';
import type { Finding, FixResult } from '../../shared/types.cjs';

const CONCURRENT_CALLS = 5;

const migrationSource = /(?:^|[\\/])migrations?[\\/]/i;

// Cache commands on separate keys do not race when they overlap. Database helpers are left
// sequential: their order and locks can matter (two claims of the same slot, deadlocks between
// multi-table deletes), and the listed queries may not be all a helper does.
const overlapSafeCommands = new Set([
  'del',
  'unlink',
  'get',
  'mget',
  'exists',
  'set',
  'setex',
  'expire',
  'hdel',
  'hget',
  'scan',
]);

const transactionHandle =
  /^(?:tx|trx|transaction|manager|entityManager|em|queryRunner|runner|session|connection|conn)$|(?:Manager|Runner|Tx|Transaction|Session)$/;

// The helper only runs cache commands, every one of them listed rather than summarized as "and N
// more".
function overlapSafe(finding: Finding): boolean {
  if (!/ Redis commands? per item/.test(finding.message) || /\d+ more\)/.test(finding.message)) return false;
  const related = relatedLocations(finding);
  if (!related) return false;
  return related.every((location) => {
    const label = /`([^`]+)`/.exec(location.message ?? '')?.[1];
    return label && overlapSafeCommands.has(lastSegment(label).toLowerCase());
  });
}

export function concurrentFix({ finding, call, sourceFile }: Omit<BatchedFixInput, 'load'>): FixResult | undefined {
  // Tests, seeds and scripts run sequentially on purpose more often than not, and their speed
  // rarely matters.
  if (finding.contextualReason || (finding.file !== undefined && migrationSource.test(finding.file))) return;
  if (!overlapSafe(finding)) return;
  const site = soleLoopSite(call);
  // Several statements replace the loop, which only a block (not an `if` body or a label) can hold.
  if (!site || !(ts.isBlock(site.loop.parent) || ts.isSourceFile(site.loop.parent))) return;
  const operand = site.awaited.expression;
  if (contains(operand, ts.isAwaitExpression)) return;
  const handles = new Set<string>();
  (function visit(node: Node): void {
    if (ts.isIdentifier(node) && !isPropertyName(node) && transactionHandle.test(node.text)) handles.add(node.text);
    ts.forEachChild(node, visit);
  })(operand);
  // Calls on one transaction share its connection, so they cannot overlap anyway.
  if (handles.size) return;
  for (let current: Node = site.loop.parent; current; current = current.parent) {
    if (!ts.isFunctionLike(current)) continue;
    const owner = current.parent;
    if (ts.isCallExpression(owner) && /transaction/i.test(textOf(owner.expression))) return;
    break;
  }
  const items = freshName(sourceFile, 'pendingItems');
  const start = freshName(sourceFile, 'start');
  const limit = freshName(sourceFile, 'concurrentCalls');
  if (!items || !start || !limit) return;
  const indentation = indentationAt(sourceFile.text, site.loop.getStart(sourceFile));
  const lines = [
    `const ${limit} = ${CONCURRENT_CALLS};`,
    `const ${items} = Array.from(${textOf(site.collection)});`,
    `for (let ${start} = 0; ${start} < ${items}.length; ${start} += ${limit}) {`,
    `  await Promise.all(${items}.slice(${start}, ${start} + ${limit}).map((${textOf(site.binding)}) => ${textOf(operand)}));`,
    '}',
  ];
  const name = textOf(call.expression);
  return {
    edits: [{ start: site.loop.getStart(sourceFile), end: site.loop.end, text: lines.join('\n' + indentation) }],
    note: `This does not cut the number of queries: no batch variant could be derived from \`${name}()\`, so a set-based version of it, or one multi-key client call such as Redis \`del(...keys)\` or \`mget(...keys)\`, is still the real fix. Meanwhile it runs up to ${CONCURRENT_CALLS} calls at once to cut wall time. Calls now overlap and may finish out of order, and when one fails the others of its group still run (later groups do not start). Apply only if the items are independent of each other.`,
  };
}
