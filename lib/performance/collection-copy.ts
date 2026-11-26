import { ts } from './compiler.js';
import { findRepeatOwner, isStandardArrayCall } from './repeated.js';
import {
  arrays,
  externalBinding,
  isObjectAssign,
  nativeCollection,
  sameIdentifier,
  smallLiteralLimit,
  typeParts,
  writtenBindings,
} from './collection-bindings.js';
import type { BinaryExpression, Expression, Identifier, Node, ObjectLiteralElementLike } from 'typescript';
import type { CheckerAdapter, PerformanceRuleContext } from '../shared/types.js';
import type { ObjectAssignCopy } from './types/collections.js';
import type { RepeatOwner } from './types/repeat-owner.js';

function emptySpreadSource(expression: Expression): boolean {
  const value = ts.skipOuterExpressions(expression);
  return (
    (ts.isArrayLiteralExpression(value) && value.elements.length === 0) ||
    (ts.isStringLiteralLike(value) && value.text === '')
  );
}

export function addsAnotherItem(elements: readonly Node[], copied: Node): boolean {
  return elements.some(
    (element) => element !== copied && (!ts.isSpreadElement(element) || !emptySpreadSource(element.expression)),
  );
}

// `target.concat(...)` that adds at least one item. Returns the copied receiver.
export function growingConcat(result: Expression, isTarget: (receiver: Expression) => boolean): Expression | undefined {
  if (
    !ts.isCallExpression(result) ||
    !ts.isPropertyAccessExpression(result.expression) ||
    result.expression.name.text !== 'concat' ||
    ts.isOptionalChain(result)
  )
    return;
  const receiver = ts.skipOuterExpressions(result.expression.expression);
  const addsItems = result.arguments.some((argument) => {
    if (ts.isSpreadElement(argument)) return !emptySpreadSource(argument.expression);
    const value = ts.skipOuterExpressions(argument);
    return !ts.isArrayLiteralExpression(value) || value.elements.length > 0;
  });
  return addsItems && isTarget(receiver) ? receiver : undefined;
}

function growingArrayCopy(result: Expression, target: Identifier): boolean {
  if (ts.isCallExpression(result)) {
    return growingConcat(result, (receiver) => sameIdentifier(receiver, target)) !== undefined;
  }
  if (!ts.isArrayLiteralExpression(result)) return false;
  const copied = result.elements.find((element) => {
    if (!ts.isSpreadElement(element)) return false;
    const value = ts.skipOuterExpressions(element.expression);
    return ts.isIdentifier(value) && value.text === target.text;
  });
  return copied !== undefined && addsAnotherItem(result.elements, copied);
}

function smallKeyDomain(expression: Expression, checker: CheckerAdapter): boolean {
  const type = checker.getTypeAtLocation(expression);
  const alternatives = typeParts(type);
  return (
    alternatives.length <= smallLiteralLimit &&
    alternatives.every(
      (alternative) =>
        alternative.flags &
        (ts.TypeFlags.Literal | ts.TypeFlags.UniqueESSymbol | ts.TypeFlags.Null | ts.TypeFlags.Undefined),
    )
  );
}

// A computed key that can differ between steps grows the object; fixed keys only overwrite.
export function addsDynamicKey(
  properties: readonly ObjectLiteralElementLike[],
  varies: (expression: Expression) => boolean,
  checker: CheckerAdapter,
): boolean {
  return properties.some(
    (property) =>
      property.name &&
      ts.isComputedPropertyName(property.name) &&
      varies(property.name.expression) &&
      !smallKeyDomain(property.name.expression, checker),
  );
}

// `Object.assign({}, target, { ... })` copies the target into a fresh object just like a spread
// does.
export function objectAssignCopy(
  result: Expression,
  isTarget: (expression: Expression) => boolean,
  checker: CheckerAdapter,
): ObjectAssignCopy | undefined {
  if (!ts.isCallExpression(result) || ts.isOptionalChain(result)) return;
  const [fresh, copied, ...added] = result.arguments.map((argument) => ts.skipOuterExpressions(argument));
  if (!fresh || !ts.isObjectLiteralExpression(fresh) || fresh.properties.length > 0 || !copied || !isTarget(copied))
    return;
  if (added.length === 0 || !added.every(ts.isObjectLiteralExpression) || !isObjectAssign(result, checker)) return;
  return { copied, properties: added.flatMap((literal) => literal.properties) };
}

// Only bindings declared inside the loop or callback can hold a different key on each step.
function usesBindingWithin(expression: Expression, owner: Node, checker: CheckerAdapter): boolean {
  function visit(node: Node): true | undefined {
    if (ts.isIdentifier(node)) {
      const binding = checker.getSymbolAtLocation(node)?.valueDeclaration;
      if (
        binding &&
        binding.getSourceFile() === owner.getSourceFile() &&
        binding.pos >= owner.pos &&
        binding.end <= owner.end
      )
        return true;
    }
    return ts.forEachChild(node, visit);
  }
  return visit(expression) === true;
}

function growingObjectCopy(
  result: Expression,
  target: Identifier,
  owner: RepeatOwner,
  checker: CheckerAdapter,
): boolean {
  const isTarget = (expression: Expression) => sameIdentifier(ts.skipOuterExpressions(expression), target);
  const varies = (expression: Expression) => usesBindingWithin(expression, owner, checker);
  if (ts.isObjectLiteralExpression(result)) {
    const copied = result.properties.some(
      (property) => ts.isSpreadAssignment(property) && isTarget(property.expression),
    );
    return copied && addsDynamicKey(result.properties, varies, checker);
  }
  const assigned = objectAssignCopy(result, isTarget, checker);
  return assigned !== undefined && addsDynamicKey(assigned.properties, varies, checker);
}

function exitsLoopImmediately(assignment: BinaryExpression, owner: RepeatOwner): boolean {
  const statement = assignment.parent;
  if (!ts.isExpressionStatement(statement) || !ts.isBlock(statement.parent)) return false;
  const statements = statement.parent.statements;
  const index = statements.indexOf(statement);
  if (index < 0 || index + 1 >= statements.length) return false;
  const next = statements[index + 1];
  if (ts.isReturnStatement(next) || ts.isThrowStatement(next) || ts.isBreakStatement(next)) {
    return statement.parent.parent === owner || ts.isIfStatement(statement.parent.parent);
  }
  return false;
}

function isDotSplitLoop(owner: RepeatOwner): boolean {
  if (!ts.isForOfStatement(owner)) return false;
  const expr = ts.skipOuterExpressions(owner.expression);
  return (
    ts.isCallExpression(expr) &&
    ts.isPropertyAccessExpression(expr.expression) &&
    expr.expression.name.text === 'split' &&
    expr.arguments.length === 1 &&
    ts.isStringLiteralLike(expr.arguments[0]) &&
    expr.arguments[0].text === '.'
  );
}

export function checkCollectionAssignment(assignment: BinaryExpression, context: PerformanceRuleContext): void {
  if (assignment.operatorToken.kind !== ts.SyntaxKind.EqualsToken || !ts.isIdentifier(assignment.left)) return;
  const target = assignment.left;
  const result = ts.skipOuterExpressions(assignment.right);
  const { checker } = context;
  const copiesArray = growingArrayCopy(result, target);
  if (!copiesArray && !ts.isObjectLiteralExpression(result) && !ts.isCallExpression(result)) return;
  const owner = findRepeatOwner(assignment, checker);
  if (!owner || exitsLoopImmediately(assignment, owner) || isDotSplitLoop(owner)) return;
  const symbol = externalBinding(target, owner, checker);
  if (!symbol) return;
  if (copiesArray) {
    if (!nativeCollection(target, arrays, checker)) return;
    if (ts.isCallExpression(result) && !isStandardArrayCall(result, checker)) return;
  } else if (!growingObjectCopy(result, target, owner, checker)) return;
  const writes = writtenBindings(owner, checker);
  if (writes.mutated.has(symbol) || writes.passed.has(symbol) || writes.reassigned.get(symbol) !== target) return;
  context.report(
    assignment,
    'loop-copy-accumulator',
    copiesArray
      ? 'Each iteration copies the whole accumulated array before adding items, which takes quadratic time. Append in place with `result.push(...items)` on one fresh array if earlier versions are unobserved.'
      : 'Each iteration copies the whole accumulated object before adding keys, which takes quadratic time. Assign in place with `result[key] = value` on one fresh object if earlier versions are unobserved.',
  );
}
