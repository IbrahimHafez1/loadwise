import { ts } from './compiler.js';
import { findRepeatOwner, isStandardArrayCall, outerExpression } from './repeated.js';
import {
  constantListLimit,
  constantTableLimit,
  declaredTypeNode,
  externalBinding,
  fallbackOperators,
  isAccessExpression,
  isMethodCall,
  isModuleLevel,
  maxBoundDepth,
  mayChange,
  smallLiteralLimit,
  unchangedConstant,
  writtenBindings,
} from './collection-bindings.js';
import type {
  ArrayLiteralExpression,
  ElementAccessExpression,
  Expression,
  Identifier,
  ObjectLiteralExpression,
  PropertyAccessExpression,
  TypeNode,
} from 'typescript';
import type { CheckerAdapter, SymbolAdapter } from '../shared/types.js';
import type { BoundFunction, ReadonlyTuple } from './types/collections.js';
import type { MethodCall } from './types/method-call.js';
import type { RepeatOwner } from './types/repeat-owner.js';

const metadataReaders = new Set(['getAllAndOverride', 'getAllAndMerge']);

export function hasSmallReadonlyTuple(type: TypeNode | undefined): type is ReadonlyTuple {
  return (
    type !== undefined &&
    ts.isTypeOperatorNode(type) &&
    type.operator === ts.SyntaxKind.ReadonlyKeyword &&
    ts.isTupleTypeNode(type.type) &&
    type.type.elements.length <= smallLiteralLimit &&
    !type.type.elements.some(
      (element) => ts.isRestTypeNode(element) || (ts.isNamedTupleMember(element) && element.dotDotDotToken),
    )
  );
}

// Only follow expressions with a proven output bound. A depth cap also stops circular initializers.
export function arraySizeBound(
  expression: Expression | undefined,
  checker: CheckerAdapter,
  depth = 0,
  allowAliases = false,
): number {
  if (!expression || depth >= maxBoundDepth) return Infinity;
  const value = ts.skipOuterExpressions(expression);
  const bound: BoundFunction = (child) => arraySizeBound(child, checker, depth + 1, allowAliases);
  if (ts.isArrayLiteralExpression(value)) {
    if (value.elements.length > smallLiteralLimit) return Infinity;
    let size = 0;
    for (const element of value.elements) size += ts.isSpreadElement(element) ? bound(element.expression) : 1;
    return size;
  }
  if (ts.isConditionalExpression(value)) return Math.max(bound(value.whenTrue), bound(value.whenFalse));
  if (ts.isIdentifier(value)) return constantArrayBound(value, checker, bound, allowAliases);
  if (ts.isBinaryExpression(value) && fallbackOperators.has(value.operatorToken.kind)) {
    return Math.max(bound(value.left), bound(value.right));
  }
  if (ts.isElementAccessExpression(value) || ts.isPropertyAccessExpression(value)) {
    return constantTableEntryBound(value, checker, bound);
  }
  if (!isMethodCall(value)) return Infinity;
  return methodCallSizeBound(value, checker, bound);
}

function methodCallSizeBound(value: MethodCall, checker: CheckerAdapter, bound: BoundFunction): number {
  if (value.expression.expression.kind === ts.SyntaxKind.ThisKeyword && !value.arguments.length) {
    const declaration = checker.getSymbolAtLocation(value.expression.name)?.valueDeclaration;
    if (
      declaration &&
      ts.isMethodDeclaration(declaration) &&
      declaration.getSourceFile() === value.getSourceFile() &&
      declaration.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.PrivateKeyword) &&
      !declaration.modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.Decorator) &&
      !declaration.parameters.length &&
      declaration.body?.statements.length === 1
    ) {
      const statement = declaration.body.statements[0];
      if (ts.isReturnStatement(statement)) return bound(statement.expression);
    }
    return Infinity;
  }
  if (isDecoratorMetadataRead(value)) return smallLiteralLimit;
  const method = value.expression.name.text;
  if (
    (method === 'values' || method === 'keys' || method === 'entries') &&
    value.arguments.length === 1 &&
    ts.isIdentifier(value.expression.expression) &&
    value.expression.expression.text === 'Object'
  ) {
    const table = constantObjectLiteral(value.arguments[0], checker, constantTableLimit);
    if (table) return Math.min(table.properties.length, smallLiteralLimit);
  }
  if (
    (method === 'values' || method === 'keys') &&
    value.arguments.length === 1 &&
    ts.isIdentifier(value.expression.expression) &&
    value.expression.expression.text === 'Object' &&
    ts.isIdentifier(ts.skipOuterExpressions(value.arguments[0]))
  ) {
    let symbol = checker.getSymbolAtLocation(ts.skipOuterExpressions(value.arguments[0]));
    if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
    if (symbol && symbol.flags & ts.SymbolFlags.Enum) return enumMemberCount(symbol);
  }
  if (method === 'slice' && value.arguments.length === 2) {
    const [start, end] = value.arguments.map((argument) => ts.skipOuterExpressions(argument));
    if (
      ts.isNumericLiteral(start) &&
      ts.isNumericLiteral(end) &&
      Number(start.text) === 0 &&
      Number(end.text) <= smallLiteralLimit &&
      isStandardArrayCall(value, checker)
    )
      return Number(end.text);
  }
  if (method === 'map' || method === 'filter') {
    const limit = bound(value.expression.expression);
    if (limit <= smallLiteralLimit && isStandardArrayCall(value, checker)) return limit;
  }
  return Infinity;
}

export function isLiteralList(list: ArrayLiteralExpression, limit: number): boolean {
  return (
    list.elements.length <= limit &&
    list.elements.every(
      (element) =>
        ts.isStringLiteralLike(element) ||
        ts.isNumericLiteral(element) ||
        element.kind === ts.SyntaxKind.TrueKeyword ||
        element.kind === ts.SyntaxKind.FalseKeyword,
    )
  );
}

function constantArrayBound(
  identifier: Identifier,
  checker: CheckerAdapter,
  bound: BoundFunction,
  allowAliases: boolean,
): number {
  const symbol = checker.getSymbolAtLocation(identifier);
  const declaredType = declaredTypeNode(symbol?.valueDeclaration);
  if (hasSmallReadonlyTuple(declaredType)) return declaredType.type.elements.length;
  const constant = unchangedConstant(identifier, checker);
  if (!constant) return Infinity;
  const { binding, scope, imported } = constant;
  const initializer = ts.skipOuterExpressions(binding.initializer);
  let limit = bound(binding.initializer);
  if (
    limit > smallLiteralLimit &&
    isModuleLevel(binding) &&
    ts.isArrayLiteralExpression(initializer) &&
    isLiteralList(initializer, imported ? constantTableLimit : constantListLimit)
  )
    limit = smallLiteralLimit;
  if (limit > smallLiteralLimit) return Infinity;
  return !allowAliases && writtenBindings(scope, checker).aliases.has(identifier.text) ? Infinity : limit;
}

function constantObjectLiteral(
  expression: Expression,
  checker: CheckerAdapter,
  maxProperties = Infinity,
): ObjectLiteralExpression | undefined {
  const identifier = ts.skipOuterExpressions(expression);
  if (!ts.isIdentifier(identifier)) return;
  const constant = unchangedConstant(identifier, checker);
  const initializer = constant && ts.skipOuterExpressions(constant.binding.initializer);
  if (initializer && ts.isObjectLiteralExpression(initializer) && initializer.properties.length <= maxProperties) {
    return initializer;
  }
}

// Reading one entry from a hand-written lookup table (TABLE[key]) yields one of its literal lists.
function constantTableEntryBound(
  access: ElementAccessExpression | PropertyAccessExpression,
  checker: CheckerAdapter,
  bound: BoundFunction,
): number {
  const table = constantObjectLiteral(access.expression, checker);
  if (!table) return Infinity;
  let largest = 0;
  for (const property of table.properties) {
    if (!ts.isPropertyAssignment(property)) return Infinity;
    largest = Math.max(largest, bound(property.initializer));
  }
  return largest;
}

// Reading framework decorator metadata (@Roles(...), @SetMetadata) returns what a developer wrote
// on the handler.
function isDecoratorMetadataRead(call: MethodCall): boolean {
  const callee = call.expression;
  if (metadataReaders.has(callee.name.text)) return true;
  if (callee.name.text !== 'get') return false;
  const receiver = ts.skipOuterExpressions(callee.expression);
  const receiverName = ts.isPropertyAccessExpression(receiver)
    ? receiver.name.text
    : ts.isIdentifier(receiver) || ts.isStringLiteralLike(receiver)
      ? receiver.text
      : undefined;
  return receiverName !== undefined && /reflector$/i.test(receiverName);
}

function isShortLiteralList(list: ArrayLiteralExpression): boolean {
  if (list.elements.length <= smallLiteralLimit) return !list.elements.some(ts.isSpreadElement);
  return (
    list.elements.length <= constantListLimit &&
    list.elements.every((element) => ts.isStringLiteralLike(element) || ts.isNumericLiteral(element))
  );
}

function enumMemberCount(enumSymbol: SymbolAdapter): number {
  const members = enumSymbol.declarations?.flatMap((declaration) =>
    ts.isEnumDeclaration(declaration) ? [...declaration.members] : [],
  );
  if (!members?.length) return Infinity;
  const allStrings = members.every((member) => member.initializer && ts.isStringLiteralLike(member.initializer));
  // A numeric enum also exposes reverse-mapped names.
  const count = allStrings ? members.length : members.length * 2;
  // Enum values are literal constants, so they share the constant-list allowance.
  return count <= constantListLimit ? Math.min(count, smallLiteralLimit) : count;
}

export function iterationInput(owner: RepeatOwner): Expression | undefined {
  if (ts.isForOfStatement(owner)) return owner.expression;
  if (!ts.isFunctionLike(owner)) return;
  const parent = outerExpression(owner).parent;
  if ((ts.isCallExpression(parent) || ts.isNewExpression(parent)) && isAccessExpression(parent.expression))
    return parent.expression.expression;
}

function propertyReceiverOwner(
  call: MethodCall,
  receiver: Expression,
  checker: CheckerAdapter,
): RepeatOwner | undefined {
  // Only a pure, direct predicate over a declared data property. A getter or another
  // expression in the callback can change which array subsequent iterations observe.
  if (
    !ts.isPropertyAccessExpression(receiver) ||
    !ts.isIdentifier(receiver.expression) ||
    !ts.isArrowFunction(call.parent) ||
    call.parent.body !== call ||
    call.parent.parameters.length !== 1
  )
    return;
  const callback = call.parent;
  const item = callback.parameters[0].name;
  if (
    !ts.isIdentifier(item) ||
    !ts.isIdentifier(call.arguments[0]) ||
    checker.getSymbolAtLocation(item) !== checker.getSymbolAtLocation(call.arguments[0]) ||
    !externalBinding(receiver.expression, callback, checker)
  )
    return;
  const declarations = checker.getSymbolAtLocation(receiver.name)?.declarations;
  if (
    !declarations?.length ||
    !declarations.every((property) => ts.isPropertySignature(property) && !hasSmallReadonlyTuple(property.type))
  )
    return;
  const iteration = findRepeatOwner(call, checker);
  if (
    iteration === callback &&
    isStandardArrayCall(call, checker) &&
    arraySizeBound(iterationInput(iteration), checker) > smallLiteralLimit
  )
    return iteration;
  return;
}

export function reusableArrayOwner(call: MethodCall, checker: CheckerAdapter): RepeatOwner | undefined {
  const receiver = ts.skipOuterExpressions(call.expression.expression);
  if (!ts.isIdentifier(receiver)) return propertyReceiverOwner(call, receiver, checker);
  const owner = findRepeatOwner(call, checker);
  if (!owner) return;
  const symbol = externalBinding(receiver, owner, checker);
  if (!symbol) return;
  const binding = symbol.valueDeclaration;
  if (!binding) return;
  if (ts.isVariableDeclaration(binding) && !(binding.parent.flags & ts.NodeFlags.Const)) return;
  // A lookup over a short literal already has a cheap default representation.
  // Exporting it or using it in a fixture tuple alone is no evidence it grew.
  const initial =
    ts.isVariableDeclaration(binding) && binding.initializer && ts.skipOuterExpressions(binding.initializer);
  if (initial && ts.isArrayLiteralExpression(initial) && isShortLiteralList(initial)) {
    const scope = ts.findAncestor(binding, (node) => ts.isFunctionLike(node) || ts.isSourceFile(node));
    if (scope && !mayChange(symbol, scope, checker)) return;
  }
  if (arraySizeBound(receiver, checker) <= smallLiteralLimit) return;
  let repeat: RepeatOwner = owner;
  while (arraySizeBound(iterationInput(repeat), checker) <= smallLiteralLimit) {
    const outer = findRepeatOwner(repeat, checker);
    if (!outer || !externalBinding(receiver, outer, checker)) return;
    repeat = outer;
  }
  if (isStandardArrayCall(call, checker) && !mayChange(symbol, repeat, checker)) return owner;
}
