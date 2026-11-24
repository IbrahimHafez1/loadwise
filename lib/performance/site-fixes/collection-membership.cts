// Site fix for array-repeated-membership: repeated includes() calls on one array become a Set.
import { ts, textOf, calleeCall, freshName } from './helpers.cjs';
import type {
  Block,
  CallExpression,
  Identifier,
  Node,
  PropertyAccessExpression,
  SourceFile,
  Statement,
} from 'typescript';
import type { FixResult, SiteFixInput } from '../../shared/types.cjs';
import type { LookupConstruction } from '../types/lookup-construction.cjs';
import {
  declaresNameWithin,
  statementPlacement,
  outermostPlacement,
  plainChainRoot,
  onlyReadThroughChain,
  onlyGuardedChainReads,
  onlyReadOnlyMembers,
  capitalize,
} from './collection-helpers.cjs';
import { lookupDeclarations } from './collection-lookup-declarations.cjs';

interface MembershipCall {
  call: CallExpression;
  receiver: Identifier | PropertyAccessExpression;
  root: Identifier;
  name: PropertyAccessExpression['name'];
}

interface BlockMembership {
  membership: MembershipCall;
  statement: Statement;
}

function membershipCall(node: Node): MembershipCall | undefined {
  if (!ts.isCallExpression(node) || ts.isOptionalChain(node) || !ts.isPropertyAccessExpression(node.expression)) return;
  const { expression: receiver, name } = node.expression;
  if (name.text !== 'includes' || node.arguments.length !== 1) return;
  if (!ts.isIdentifier(receiver) && !ts.isPropertyAccessExpression(receiver)) return;
  const root = plainChainRoot(receiver);
  return root && { call: node, receiver, root, name };
}

// Every `source.includes(x)` whose lookup would go before a statement of `block`, as { membership,
// statement }. One lookup then serves them all, and every finding among them gets the same fix, so
// applying one applies all.
function sameBlockMemberships(block: Block | SourceFile, source: string, rootName: string): BlockMembership[] {
  const found: BlockMembership[] = [];
  (function visit(current: Node): void {
    const membership = membershipCall(current);
    if (membership && textOf(membership.receiver) === source) {
      const statement = outermostPlacement(membership.call, rootName, source)?.region;
      if (statement && ts.isStatement(statement) && statement.parent === block) found.push({ membership, statement });
    }
    ts.forEachChild(current, visit);
  })(block);
  return found;
}

function lastPropertyName(receiver: Identifier | PropertyAccessExpression): string {
  return ts.isIdentifier(receiver) ? receiver.text : receiver.name.text;
}

// A chain such as `team.members` names its Set after the last property, unless another membership
// check in the file reads a different array with that name: then the whole chain names it, so two
// Sets never share a name.
function chainSetBase(sourceFile: SourceFile, receiver: Identifier | PropertyAccessExpression): string {
  const source = textOf(receiver);
  const last = lastPropertyName(receiver);
  let clash = false;
  (function visit(current: Node): void {
    if (clash) return;
    const other = membershipCall(current);
    if (other && lastPropertyName(other.receiver) === last && textOf(other.receiver) !== source) clash = true;
    else ts.forEachChild(current, visit);
  })(sourceFile);
  if (!clash) return last;
  return source
    .replaceAll(/\s/g, '')
    .split('.')
    .map((part, index) => (index ? capitalize(part) : part))
    .join('');
}

// loadwise-reviewed high-branch-complexity -- a linear chain of independent safety bail-outs (receiver, name, placement, chain reads) before a single Set rewrite; splitting scatters the proof from the edit it guards
export function membershipFix({ node, sourceFile }: SiteFixInput): FixResult | undefined {
  if (!node || !sourceFile) return;
  const flagged = calleeCall(node);
  const membership = flagged && membershipCall(flagged);
  if (!membership || declaresNameWithin(sourceFile, 'Set')) return;
  const { call, receiver, root } = membership;
  const chained = receiver !== root;
  const source = textOf(receiver);
  const setName = freshName(sourceFile, `${chained ? chainSetBase(sourceFile, receiver) : root.text}Set`);
  if (!setName) return;
  let placement = outermostPlacement(call, root.text, source);
  if (!placement) return;
  let calls: MembershipCall[] = [membership];
  let covered: readonly Node[] = [placement.region];
  const block = placement.region.parent;
  if (ts.isStatement(placement.region) && (ts.isBlock(block) || ts.isSourceFile(block))) {
    const group = sameBlockMemberships(block, source, root.text);
    if (group.length > 1) {
      const statements = block.statements;
      const first = statements.indexOf(group[0].statement);
      const last = statements.indexOf(group[group.length - 1].statement);
      covered = statements.slice(first, last + 1);
      if (!covered.every((statement) => onlyReadOnlyMembers(statement, root.text, source))) return;
      placement = statementPlacement(group[0].statement, root.text);
      if (!placement) return;
      calls = group.map((entry) => entry.membership);
    }
  }
  let built = source;
  if (chained && !onlyReadThroughChain(placement.region, root.text, source)) {
    const rest = source.slice(root.text.length);
    if (calls.length > 1 || !/^\.[\w$.]+$/.test(rest)) return;
    if (!onlyGuardedChainReads(placement.region, root.text, source)) return;
    built = `${root.text}?${rest}`;
  }
  // A plain name that the iteration never changes can be read early: `new Set()` accepts any array,
  // null or undefined. A property chain stays lazy because reading it early could run a getter or
  // reach a root that the original code only reads behind a guard.
  const eager = !chained && covered.every((region) => onlyReadOnlyMembers(region, root.text, source));
  const construction: LookupConstruction = { open: 'new Set(', array: built, calls: [], close: ')' };
  const lookup = lookupDeclarations(sourceFile, setName, placement, construction, eager);
  if (!lookup) return;
  return {
    edits: [
      ...placement.edits(...lookup.declarations),
      ...calls.map((each) => ({
        start: each.receiver.getStart(),
        end: each.name.end,
        text: `${lookup.access}.has`,
      })),
    ],
    note: eager
      ? `The Set is built once before the iteration. This assumes \`${source}\` stays unchanged while it runs.`
      : `The Set is built on the first membership check. This assumes \`${source}\` stays unchanged between checks.`,
  };
}
