import { ts, isDefaultLibrary } from './compiler.js';
import { isStandardArrayCall, standardInterface } from './repeated.js';
import { clientHookContext, clientSourcePattern, isTestSource } from './review-context.js';
import {
  constantListLimit,
  constantTableLimit,
  fallbackOperators,
  finiteDomainLimit,
  isConstAssertion,
  listsProperties,
  maxBoundDepth,
  mayChange,
  mayChangeBefore,
  resolvedSymbol,
  sameIdentifier,
  smallLiteralLimit,
  syncCallback,
  typeParts,
  unchangedConstant,
  writtenBindings,
} from './collection-bindings.js';
import { arraySizeBound, isLiteralList } from './collection-bounds.js';
import { addsAnotherItem, addsDynamicKey, growingConcat, objectAssignCopy } from './collection-copy.js';
import type {
  CallExpression,
  ComputedPropertyName,
  Expression,
  Identifier,
  Node,
  ObjectLiteralElementLike,
  ParameterDeclaration,
} from 'typescript';
import type { CheckerAdapter, PerformanceRuleContext, TypeAdapter } from '../shared/types.js';
import type { CallbackFunction } from './types/collections.js';
import type { MethodCall } from './types/method-call.js';

const smallInputReason =
  'Reduces over a small fixed collection, so the accumulator copy stays bounded; assess only if the input can grow.';
const testSourceReason = 'Runs in a test source rather than a request path.';
const decoratorArgumentReason =
  'Reduces over the arguments a developer wrote at the decorator use site, so the accumulator copy stays bounded; assess only if callers pass long lists.';
const genericObjectReason =
  'Reduces over the keys of a generic object whose shape each caller fixes, such as one form or config value, so it holds the handful of keys that caller declares; assess only if callers pass dictionaries keyed by stored data.';
const finiteKeyReason =
  'Every key the accumulator gains comes from a finite literal or enum type, so the copied object stays bounded by that type; assess only if the copy per step matters.';
const closedAccumulatorReason =
  'The accumulator is typed as an object with a fixed set of named keys and no index signature, so the copied object stays bounded by that type; assess only if the copy per step matters.';
const schemaPropertiesReason =
  'Reduces over the properties of one JSON Schema object, which the schema author declares by hand, so the accumulator copy stays bounded; assess only if schemas are generated from stored data.';
const enumListReason =
  'Reduces over a list of enum or literal values, which holds about one entry per declared member; assess only if the list can repeat values at scale.';
const moduleLoadReason =
  'Runs once when the module loads, not per request, so the accumulator copy is paid at startup; assess only if the input grows with data.';
const uiReduceReason =
  'Runs in a JSX component module over UI state rather than on a server request path. Review in a front-end context if the list can grow large.';
const jsonSchemaMembers = ['type', 'properties', 'required'];

function usesIterationParameter(
  expression: Expression,
  parameters: readonly ParameterDeclaration[],
  checker: CheckerAdapter,
): boolean {
  function visit(node: Node): true | undefined {
    if (ts.isIdentifier(node)) {
      const binding = checker.getSymbolAtLocation(node)?.valueDeclaration;
      if (binding) {
        const parameter = ts.isBindingElement(binding) ? ts.findAncestor(binding, ts.isParameter) : binding;
        if (parameters.some((candidate) => candidate === parameter)) return true;
      }
    }
    return ts.forEachChild(node, visit);
  }
  return visit(expression) === true;
}

function hasSmallObjectEnumeration(input: Node, checker: CheckerAdapter): boolean {
  if (!ts.isCallExpression(input) || input.arguments.length !== 1 || ts.isOptionalChain(input)) return false;
  const callee = input.expression;
  if (!ts.isPropertyAccessExpression(callee) || !['entries', 'keys', 'values'].includes(callee.name.text)) return false;
  const receiver = callee.expression;
  if (!ts.isIdentifier(receiver) || receiver.text !== 'Object') return false;
  const literal = ts.skipOuterExpressions(input.arguments[0]);
  if (
    !ts.isObjectLiteralExpression(literal) ||
    literal.properties.length > constantListLimit ||
    !literal.properties.every(
      (property) =>
        ts.isShorthandPropertyAssignment(property) ||
        (ts.isPropertyAssignment(property) && !ts.isComputedPropertyName(property.name)),
    )
  )
    return false;
  const symbol = checker.getSymbolAtLocation(receiver);
  const declaration = symbol?.valueDeclaration;
  const scope = input.getSourceFile();
  return (
    declaration !== undefined &&
    isDefaultLibrary(checker, declaration.getSourceFile()) &&
    standardInterface(input, checker) === 'ObjectConstructor' &&
    !mayChangeBefore(symbol, scope, input.pos, checker) &&
    !writtenBindings(scope, checker).aliases.has(receiver.text)
  );
}

// A reduce over a short unchanged constant list copies a bounded accumulator.
function hasSmallFixedInput(input: Node, checker: CheckerAdapter): boolean {
  if (!ts.isIdentifier(input)) return false;
  const initializer = unchangedConstant(input, checker)?.binding.initializer;
  const list = initializer && ts.skipOuterExpressions(initializer);
  return (
    !!list &&
    ts.isArrayLiteralExpression(list) &&
    list.elements.length <= constantListLimit &&
    !list.elements.some(ts.isSpreadElement)
  );
}

// The one argument of `Object.keys/values/entries(argument)`.
function enumeratedArgument(call: Node, checker: CheckerAdapter): Expression | undefined {
  if (!ts.isCallExpression(call) || call.arguments.length !== 1 || ts.isOptionalChain(call)) return;
  const callee = call.expression;
  if (
    ts.isPropertyAccessExpression(callee) &&
    ['entries', 'keys', 'values'].includes(callee.name.text) &&
    ts.isIdentifier(callee.expression) &&
    callee.expression.text === 'Object' &&
    standardInterface(call, checker) === 'ObjectConstructor'
  )
    return call.arguments[0];
}

// Object.keys/values/entries of a value whose declared interface or type literal lists few named
// properties.
function hasSmallDeclaredShape(input: Node, checker: CheckerAdapter): boolean {
  const argument = enumeratedArgument(input, checker);
  const declarations = argument && checker.getTypeAtLocation(argument).getSymbol?.()?.declarations;
  if (declarations?.length !== 1) return false;
  const [declaration] = declarations;
  const closedShape = ts.isInterfaceDeclaration(declaration) && !declaration.heritageClauses;
  if (!closedShape && !ts.isTypeLiteralNode(declaration)) return false;
  return (
    declaration.members.length <= constantListLimit &&
    [...declaration.members].every((member) => member.kind === ts.SyntaxKind.PropertySignature)
  );
}

// Object.keys/values/entries of an unchanged constant object literal. The constant is written by
// hand, so it stays short.
function hasSmallConstantObjectEnumeration(input: Node, checker: CheckerAdapter): boolean {
  const argument = enumeratedArgument(input, checker);
  const identifier = argument && ts.skipOuterExpressions(argument);
  if (!identifier || !ts.isIdentifier(identifier)) return false;
  const symbol = checker.getSymbolAtLocation(identifier);
  const declarationSymbol = resolvedSymbol(identifier, checker);
  const binding = declarationSymbol?.valueDeclaration;
  const literal =
    binding && ts.isVariableDeclaration(binding) && binding.initializer
      ? ts.skipOuterExpressions(binding.initializer)
      : undefined;
  if (
    !binding ||
    !ts.isVariableDeclaration(binding) ||
    !(binding.parent.flags & ts.NodeFlags.Const) ||
    !literal ||
    !ts.isObjectLiteralExpression(literal) ||
    literal.properties.length > constantTableLimit ||
    literal.properties.some(ts.isSpreadAssignment)
  )
    return false;
  const declaringScope = ts.findAncestor(binding, (node) => ts.isFunctionLike(node) || ts.isSourceFile(node));
  if (!declaringScope) return false;
  const inSameFile = declaringScope.getSourceFile() === input.getSourceFile();
  return (
    !mayChangeBefore(declarationSymbol, declaringScope, inSameFile ? input.pos : Infinity, checker) &&
    !mayChangeBefore(symbol, input.getSourceFile(), input.pos, checker)
  );
}

// A const-asserted tuple is readonly, so no code can grow it after its short literal.
function hasSmallConstAssertedList(input: Node, checker: CheckerAdapter): boolean {
  if (!ts.isIdentifier(input)) return false;
  const binding = resolvedSymbol(input, checker)?.valueDeclaration;
  const list = binding && ts.isVariableDeclaration(binding) ? binding.initializer : undefined;
  const literal = list && ts.skipOuterExpressions(list);
  return (
    !!list &&
    isConstAssertion(list) &&
    literal !== undefined &&
    ts.isArrayLiteralExpression(literal) &&
    isLiteralList(literal, constantListLimit)
  );
}

// `createParamDecorator((data, ctx) => data.reduce(...))`: `data` is what the developer wrote at
// the decorator use site.
function isDecoratorArgument(input: Node, checker: CheckerAdapter): boolean {
  if (!ts.isIdentifier(input)) return false;
  const declaration = checker.getSymbolAtLocation(input)?.valueDeclaration;
  const factory = declaration && ts.isParameter(declaration) ? declaration.parent : undefined;
  return (
    !!factory &&
    ts.isArrowFunction(factory) &&
    factory.parameters[0] === declaration &&
    ts.isCallExpression(factory.parent) &&
    ts.isIdentifier(factory.parent.expression) &&
    factory.parent.expression.text === 'createParamDecorator'
  );
}

// A reduce at the top level of a module (outside every function and class) runs once at import
// time.
function runsAtModuleLoad(call: CallExpression): boolean {
  return !ts.findAncestor(call, (node: Node) => ts.isFunctionLike(node) || ts.isClassLike(node));
}

function finiteLiteralDomain(type: TypeAdapter, limit: number): boolean {
  const alternatives = typeParts(type);
  return (
    alternatives.length <= limit &&
    alternatives.every(
      (alternative) =>
        alternative.flags & (ts.TypeFlags.StringLiteral | ts.TypeFlags.NumberLiteral | ts.TypeFlags.EnumLiteral),
    )
  );
}

// `Object.entries(data)` where `data: T` and T is a type parameter: the caller supplies a concrete
// object shape.
function enumeratesGenericObject(input: Node, checker: CheckerAdapter): boolean {
  const argument = enumeratedArgument(input, checker);
  return !!argument && !!(checker.getTypeAtLocation(argument).flags & ts.TypeFlags.TypeParameter);
}

function isEmptyObjectLiteral(expression: Expression): boolean {
  const value = ts.skipOuterExpressions(expression);
  return ts.isObjectLiteralExpression(value) && value.properties.length === 0;
}

// `schema.properties`, optionally behind `?? {}` or a `typeof schema === 'object'` guard, where the
// owner has the JSON Schema object members (type, properties, required).
function isSchemaPropertiesRead(expression: Expression, checker: CheckerAdapter, depth = 0): boolean {
  const value = ts.skipOuterExpressions(expression);
  if (depth >= maxBoundDepth) return false;
  const nested = (child: Expression): boolean => isSchemaPropertiesRead(child, checker, depth + 1);
  if (ts.isIdentifier(value)) {
    const binding = resolvedSymbol(value, checker)?.valueDeclaration;
    return (
      binding !== undefined &&
      ts.isVariableDeclaration(binding) &&
      binding.initializer !== undefined &&
      !!(binding.parent.flags & ts.NodeFlags.Const) &&
      nested(binding.initializer)
    );
  }
  if (ts.isConditionalExpression(value)) {
    const branches = [value.whenTrue, value.whenFalse];
    return branches.some(nested) && branches.every((branch) => isEmptyObjectLiteral(branch) || nested(branch));
  }
  if (ts.isBinaryExpression(value) && fallbackOperators.has(value.operatorToken.kind))
    return nested(value.left) && isEmptyObjectLiteral(value.right);
  if (!ts.isPropertyAccessExpression(value) || value.name.text !== 'properties') return false;
  const owner = checker.getTypeAtLocation(value.expression);
  return jsonSchemaMembers.every((member) => owner.getProperty(member));
}

function enumeratesSchemaProperties(input: Node, checker: CheckerAdapter): boolean {
  const argument = enumeratedArgument(input, checker);
  return !!argument && isSchemaPropertiesRead(argument, checker);
}

// `workers.reduce((acc, worker) => …)` where each worker is an enum member or a literal from a
// union.
function reducesFiniteValues(call: CallExpression, checker: CheckerAdapter): boolean {
  const item = syncCallback(call.arguments[0])?.parameters[1]?.name;
  return !!item && ts.isIdentifier(item) && finiteLiteralDomain(checker.getTypeAtLocation(item), finiteDomainLimit);
}

// `{ ...acc, [part.type]: value }` where every computed key has a finite literal type.
function hasFiniteAccumulatorKeys(spread: Node, checker: CheckerAdapter): boolean {
  const literal = spread.parent;
  if (!ts.isObjectLiteralExpression(literal)) return false;
  const keys = literal.properties.filter(
    (property): property is ObjectLiteralElementLike & { name: ComputedPropertyName } =>
      property.name !== undefined && ts.isComputedPropertyName(property.name),
  );
  return (
    keys.length > 0 &&
    keys.every((property) =>
      finiteLiteralDomain(checker.getTypeAtLocation(property.name.expression), finiteDomainLimit),
    )
  );
}

// `reduce((acc, …) => ({ ...acc, … }), {} as Record<ChannelEnum, Setting>)`: the accumulator type
// names every key it can hold.
function hasClosedAccumulatorType(spread: Node, callback: CallbackFunction, checker: CheckerAdapter): boolean {
  // Only object copies (spread or Object.assign); array and Set accumulators are not bounded by
  // their own type.
  if (!ts.isSpreadAssignment(spread) && !ts.isCallExpression(spread.parent)) return false;
  const type = checker.getTypeAtLocation(callback.parameters[0]);
  if (!(type.flags & ts.TypeFlags.Object) || !listsProperties(type)) return false;
  // A pure index signature such as Record<string, T> has no named properties; a mixed one declares
  // its signature.
  const declaresIndex = type
    .getSymbol()
    ?.declarations?.some(
      (declaration) =>
        (ts.isInterfaceDeclaration(declaration) || ts.isTypeLiteralNode(declaration) || ts.isClassLike(declaration)) &&
        declaration.members.some(ts.isIndexSignatureDeclaration),
    );
  if (declaresIndex) return false;
  const keyCount = type.getProperties().length;
  return keyCount > 0 && keyCount <= finiteDomainLimit;
}

function boundedReduceReason(call: CallExpression, input: Expression, checker: CheckerAdapter): string | undefined {
  if (
    hasSmallFixedInput(input, checker) ||
    arraySizeBound(input, checker) <= smallLiteralLimit ||
    hasSmallConstAssertedList(input, checker) ||
    hasSmallConstantObjectEnumeration(input, checker) ||
    hasSmallDeclaredShape(input, checker)
  )
    return smallInputReason;
  if (isDecoratorArgument(input, checker)) return decoratorArgumentReason;
  if (isTestSource(input.getSourceFile().fileName)) return testSourceReason;
  if (runsAtModuleLoad(call)) return moduleLoadReason;
  if (enumeratesGenericObject(input, checker)) return genericObjectReason;
  if (reducesFiniteValues(call, checker)) return enumListReason;
  if (enumeratesSchemaProperties(input, checker)) return schemaPropertiesReason;
  if (clientSourcePattern.test(call.getSourceFile().fileName)) return uiReduceReason;
  return clientHookContext(call, call.getSourceFile());
}

export function checkReducer(call: MethodCall, context: PerformanceRuleContext): void {
  const callback = syncCallback(call.arguments[0]);
  if (!callback) return;
  const accumulator = callback.parameters[0]?.name;
  if (!accumulator || !ts.isIdentifier(accumulator)) return;
  const { checker } = context;
  const accumulatorName: Identifier = accumulator;
  const reducerParameters = callback.parameters;

  function isAccumulator(expression: Expression): boolean {
    const copied = ts.skipOuterExpressions(expression);
    return (
      sameIdentifier(copied, accumulatorName) &&
      checker.getSymbolAtLocation(copied)?.valueDeclaration === reducerParameters[0]
    );
  }
  const varies = (expression: Expression) => usesIterationParameter(expression, reducerParameters.slice(1, 3), checker);

  function growingCopy(expression: Expression): Node | undefined {
    const result = ts.skipOuterExpressions(expression);
    if (ts.isConditionalExpression(result)) return growingCopy(result.whenTrue) || growingCopy(result.whenFalse);
    if (ts.isCallExpression(result)) {
      const assigned = objectAssignCopy(result, isAccumulator, checker);
      if (assigned) return addsDynamicKey(assigned.properties, varies, checker) ? assigned.copied : undefined;
      return isStandardArrayCall(result, checker) ? growingConcat(result, isAccumulator) : undefined;
    }
    if (ts.isArrayLiteralExpression(result)) {
      const copiedSpread = result.elements.find(
        (entry) => ts.isSpreadElement(entry) && isAccumulator(entry.expression),
      );
      if (!copiedSpread) return;
      return addsAnotherItem(result.elements, copiedSpread) ? copiedSpread : undefined;
    }
    if (!ts.isObjectLiteralExpression(result)) return;
    const copiedSpread = result.properties.find(
      (entry) => ts.isSpreadAssignment(entry) && isAccumulator(entry.expression),
    );
    if (!copiedSpread) return;
    return addsDynamicKey(result.properties, varies, checker) ? copiedSpread : undefined;
  }

  function returnedCopy(statement: Node): Node | undefined {
    if (ts.isFunctionLike(statement) || ts.isClassLike(statement)) return;
    if (ts.isReturnStatement(statement)) return statement.expression && growingCopy(statement.expression);
    return ts.forEachChild(statement, returnedCopy);
  }
  const spread = ts.isBlock(callback.body) ? returnedCopy(callback.body) : growingCopy(callback.body);
  if (!spread) return;
  const input = ts.skipOuterExpressions(call.expression.expression);
  // Without an initial value, the first input item becomes the accumulator.
  const maxItemsForOneStep = call.arguments.length === 1 ? 2 : 1;
  if (
    (ts.isArrayLiteralExpression(input) &&
      input.elements.length <= maxItemsForOneStep &&
      !input.elements.some(ts.isSpreadElement)) ||
    hasSmallObjectEnumeration(input, checker)
  )
    return;
  if (
    !isStandardArrayCall(call, checker) ||
    (ts.isBlock(callback.body) && mayChange(checker.getSymbolAtLocation(accumulator), callback.body, checker))
  )
    return;
  context.report(
    spread,
    'reduce-copy-accumulator',
    'Spreading the accumulator copies it on every reduction step, which takes quadratic time. Mutate one fresh accumulator instead (`acc.push(item)` or `acc[key] = value`) if intermediate versions are unobserved.',
    boundedReduceReason(call, input, checker) ??
      (hasFiniteAccumulatorKeys(spread, checker) ? finiteKeyReason : undefined) ??
      (hasClosedAccumulatorType(spread, callback, checker) ? closedAccumulatorReason : undefined),
  );
}
