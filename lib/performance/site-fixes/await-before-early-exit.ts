import { requireReview, ts } from './helpers.js';
import { guardAfterAwait } from '../await-before-early-exit.js';
import type { BindingName, FunctionLikeDeclaration, Identifier, Node } from 'typescript';
import type { FixResult, SiteFixInput } from '../../shared/types.js';

const errorTypeName = /(?:Error|Exception)$/;
const note = 'The guard now runs before the read, so a request it rejects skips the round trip.';

function isWriteOperator(node: Node): boolean {
  return (
    (ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) ||
    ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken))
  );
}

// A guard is movable when evaluating it earlier cannot change anything: no calls, writes or
// closures. Building an error to throw is allowed because it has no effect until it is thrown.
function isInert(guard: Node): boolean {
  let inert = true;
  (function visit(node: Node): void {
    if (!inert) return;
    const buildsError =
      ts.isNewExpression(node) && ts.isIdentifier(node.expression) && errorTypeName.test(node.expression.text);
    if (
      ts.isCallExpression(node) ||
      ts.isTaggedTemplateExpression(node) ||
      ts.isFunctionLike(node) ||
      isWriteOperator(node) ||
      (ts.isNewExpression(node) && !buildsError)
    ) {
      inert = false;
      return;
    }
    ts.forEachChild(node, visit);
  })(guard);
  return inert;
}

type DeclarationKind = 'parameter' | 'const' | 'other';

interface LocalDeclaration {
  kind: DeclarationKind;
  declaration: Node;
}

function declarationsByName(functionNode: FunctionLikeDeclaration): Map<string, LocalDeclaration[]> {
  const declarations = new Map<string, LocalDeclaration[]>();
  const add = (name: string, kind: DeclarationKind, declaration: Node): void => {
    const existing = declarations.get(name);
    if (existing) existing.push({ kind, declaration });
    else declarations.set(name, [{ kind, declaration }]);
  };
  const addBinding = (name: BindingName, kind: DeclarationKind, declaration: Node): void => {
    if (ts.isIdentifier(name)) add(name.text, kind, declaration);
    else
      for (const element of name.elements)
        if (ts.isBindingElement(element)) addBinding(element.name, kind, declaration);
  };
  for (const parameter of functionNode.parameters) addBinding(parameter.name, 'parameter', parameter);
  const visitDeclarations = (node: Node): void => {
    if (node !== functionNode && ts.isFunctionLike(node)) {
      if (ts.isFunctionDeclaration(node) && node.name) add(node.name.text, 'other', node);
      return;
    }
    if (ts.isVariableDeclaration(node)) {
      const constant = Boolean(node.parent.flags & ts.NodeFlags.Const);
      addBinding(node.name, constant ? 'const' : 'other', node);
    } else if (ts.isClassDeclaration(node) && node.name) add(node.name.text, 'other', node);
    else if (ts.isCatchClause(node) && node.variableDeclaration)
      addBinding(node.variableDeclaration.name, 'other', node);
    ts.forEachChild(node, visitDeclarations);
  };
  if (functionNode.body) visitDeclarations(functionNode.body);
  return declarations;
}

function isReference(identifier: Identifier): boolean {
  const parent = identifier.parent;
  if (ts.isPropertyAccessExpression(parent)) return parent.expression === identifier;
  if (ts.isPropertyAssignment(parent)) return parent.initializer === identifier;
  if (ts.isPropertySignature(parent)) return false;
  return !(ts.isBindingElement(parent) || ts.isParameter(parent) || ts.isVariableDeclaration(parent));
}

// Every name the guard reads must be a parameter, a const declared before the await, or not local
// at all.
function readsOnlyEarlierValues(guard: Node, awaitStatement: Node): boolean {
  const owner = ts.findAncestor(awaitStatement, ts.isFunctionLike);
  if (!owner || !('body' in owner) || !owner.body) return false;
  const declarations = declarationsByName(owner);
  let earlier = true;
  (function visit(node: Node): void {
    if (!earlier) return;
    if (ts.isIdentifier(node) && isReference(node)) {
      const local = declarations.get(node.text);
      earlier =
        !local ||
        local.every(
          ({ kind, declaration }) =>
            kind === 'parameter' || (kind === 'const' && declaration.end <= awaitStatement.getStart()),
        );
    }
    ts.forEachChild(node, visit);
  })(guard);
  return earlier;
}

function awaitBeforeEarlyExitFix({ node, sourceFile, text }: SiteFixInput): FixResult | undefined {
  if (!node || !sourceFile || text === undefined || !ts.isAwaitExpression(node)) return;
  const match = guardAfterAwait(node);
  if (!match) return;
  const { awaitStatement, guard } = match;
  const between = text.slice(awaitStatement.end, guard.getStart(sourceFile));
  if (/\S/.test(between) || !isInert(guard) || !readsOnlyEarlierValues(guard, awaitStatement)) return;
  const awaitText = text.slice(awaitStatement.getStart(sourceFile), awaitStatement.end);
  const guardText = text.slice(guard.getStart(sourceFile), guard.end);
  return {
    edits: [{ start: awaitStatement.getStart(sourceFile), end: guard.end, text: guardText + between + awaitText }],
    note,
  };
}

export default {
  'await-before-early-exit': requireReview(
    'The awaited call no longer runs when the guard rejects, and the guard error now wins over a failure of that call.',
    awaitBeforeEarlyExitFix,
  ),
};
