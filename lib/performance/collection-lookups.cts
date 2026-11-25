import { loadSyntax, isDefaultLibrary } from './compiler.cjs';
import { findRepeatOwner, outerExpression, standardInterface } from './repeated.cjs';
import { repeatedReviewContext } from './review-context.cjs';
import {
  declaredInitializer,
  externalBinding,
  hasIdentifierName,
  isAccessExpression,
  maxBoundDepth,
  mayChange,
  nativeCollection,
  repeatableCollections,
  resolvedSymbol,
  setTypes,
  smallLiteralLimit,
  syncCallback,
  typeParts,
} from './collection-bindings.cjs';
import { arraySizeBound, iterationInput, reusableArrayOwner } from './collection-bounds.cjs';
import type { BindingElement, CallExpression, Expression, Node } from 'typescript';
import type { CheckerAdapter, PerformanceRuleContext, TypeAdapter } from '../shared/types.cjs';
import type { FindComparison, FindDetails, FindKeySides } from './types/collections.cjs';
import type { FindLookupFacts } from './types/find-lookup-facts.cjs';
import type { MethodCall } from './types/method-call.cjs';
const ts = loadSyntax();

const objectIdPackages = ['bson', 'mongodb', 'mongoose'];
const objectIdTypes = ['ObjectId'];
const databaseReadMethods = new Set([
  'aggregate',
  'execute',
  'find',
  'findAll',
  'findAndCount',
  'findBy',
  'findMany',
  'getMany',
  'getRawMany',
  'query',
  'raw',
]);
const requestPayloadNames = new Set(['body', 'query']);
const parsingMethods = new Set(['parse', 'split']);
const arrayDerivingMethods = new Set(['concat', 'filter', 'flat', 'flatMap', 'map', 'slice', 'sort', 'toSorted']);
const unknownSizeReason = 'array size unknown; review if it can hold more than a few dozen items';
const smallConfigListNames = new Set([
  'filters',
  'options',
  'props',
  'columns',
  'fields',
  'roles',
  'permissions',
  'tabs',
  'steps',
]);
const smallConfigListReason =
  "The receiver's name suggests a small configuration list; dismiss if it stays a handful of items.";
const childListReason =
  "Looks up within one record's own child list (such as one product's options or one run's steps), which usually holds a handful of entries; assess only if that list grows with stored data.";
// Property names that usually hold a whole query or API result rather than one record's children.
const resultListNames = new Set([
  'body',
  'data',
  'docs',
  'documents',
  'edges',
  'entries',
  'hits',
  'items',
  'list',
  'nodes',
  'records',
  'response',
  'results',
  'rows',
  'values',
]);
const printableKeyFlags =
  ts.TypeFlags.StringLike | ts.TypeFlags.NumberLike | ts.TypeFlags.BigIntLike | ts.TypeFlags.BooleanLike;
const nullishFlags = ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Void;
// Values of these types are never NaN, so a Map index needs no NaN filter for them.
const neverNaNFlags =
  ts.TypeFlags.StringLike |
  ts.TypeFlags.BooleanLike |
  ts.TypeFlags.BigIntLike |
  ts.TypeFlags.NumberLiteral |
  ts.TypeFlags.ESSymbolLike |
  ts.TypeFlags.NonPrimitive |
  ts.TypeFlags.Object |
  nullishFlags;

function receiverName(receiver: Expression): string | undefined {
  const target = ts.skipOuterExpressions(receiver);
  if (ts.isIdentifier(target)) return target.text;
  return ts.isPropertyAccessExpression(target) ? target.name.text : undefined;
}

// Only a weak hint: it applies when the array's size is unknown, never over a database read or
// request payload.
function nameSuggestsSmallConfigList(receiver: Expression, checker: CheckerAdapter): boolean {
  const name = receiverName(receiver);
  return name !== undefined && smallConfigListNames.has(name) && !isKnownDataSource(receiver, checker);
}

// `const [rows, other] = await Promise.all([repo.find(), ...])`: the member's own promise is the
// source.
function isAwaitedAllMember(element: BindingElement, isKnown: (expression: Expression) => boolean): boolean {
  const pattern = element.parent;
  const declaration = pattern.parent;
  if (!ts.isArrayBindingPattern(pattern) || !ts.isVariableDeclaration(declaration) || !declaration.initializer)
    return false;
  const all = ts.skipOuterExpressions(
    ts.isAwaitExpression(declaration.initializer) ? declaration.initializer.expression : declaration.initializer,
  );
  const promises = ts.isCallExpression(all) && all.arguments[0] ? ts.skipOuterExpressions(all.arguments[0]) : undefined;
  const source =
    promises && ts.isArrayLiteralExpression(promises)
      ? promises.elements[pattern.elements.indexOf(element)]
      : undefined;
  return source !== undefined && isKnown(source);
}

// A database read, request payload array or parsed file is a source whose size follows the data,
// not the code.
function isKnownDataSource(expression: Expression, checker: CheckerAdapter, depth = 0): boolean {
  if (depth >= maxBoundDepth) return false;
  const value = ts.skipOuterExpressions(expression);
  const next = (child: Expression): boolean => isKnownDataSource(child, checker, depth + 1);
  if (ts.isAwaitExpression(value)) return next(value.expression);
  if (ts.isIdentifier(value)) {
    const declaration = checker.getSymbolAtLocation(value)?.valueDeclaration;
    if (declaration && ts.isBindingElement(declaration)) return isAwaitedAllMember(declaration, next);
    return (
      declaration !== undefined &&
      ts.isVariableDeclaration(declaration) &&
      declaration.initializer !== undefined &&
      next(declaration.initializer)
    );
  }
  if (ts.isNewExpression(value))
    return value.arguments !== undefined && value.arguments.length > 0 && next(value.arguments[0]);
  if (ts.isPropertyAccessExpression(value) || ts.isElementAccessExpression(value)) {
    for (let node: Expression = value; isAccessExpression(node); node = ts.skipOuterExpressions(node.expression)) {
      if (ts.isPropertyAccessExpression(node) && requestPayloadNames.has(node.name.text)) return true;
    }
    return false;
  }
  if (ts.isArrayLiteralExpression(value)) {
    return value.elements.some((element) => ts.isSpreadElement(element) && next(element.expression));
  }
  if (!ts.isCallExpression(value) || !ts.isPropertyAccessExpression(value.expression)) return false;
  const method = value.expression.name.text;
  if (databaseReadMethods.has(method) || parsingMethods.has(method)) return true;
  if (arrayDerivingMethods.has(method)) return next(value.expression.expression);
  return method === 'from' && value.arguments.length > 0 && next(value.arguments[0]);
}

function copiedFromSet(receiver: Expression, checker: CheckerAdapter): boolean {
  const initializer = declaredInitializer(
    checker.getSymbolAtLocation(ts.skipOuterExpressions(receiver))?.valueDeclaration,
  );
  if (!initializer) return false;
  const copy = ts.skipOuterExpressions(initializer);
  let source: Expression | undefined;
  if (ts.isArrayLiteralExpression(copy) && copy.elements.length === 1 && ts.isSpreadElement(copy.elements[0])) {
    source = copy.elements[0].expression;
  } else if (
    ts.isCallExpression(copy) &&
    copy.arguments.length === 1 &&
    ts.isPropertyAccessExpression(copy.expression) &&
    copy.expression.name.text === 'from' &&
    standardInterface(copy, checker) === 'ArrayConstructor'
  ) {
    source = copy.arguments[0];
  }
  return source !== undefined && nativeCollection(source, setTypes, checker);
}

export function checkMembership(call: MethodCall, context: PerformanceRuleContext): void {
  if (call.arguments.length !== 1 || ts.isSpreadElement(call.arguments[0])) return;
  const owner = reusableArrayOwner(call, context.checker);
  if (!owner) return;
  const input = iterationInput(owner);
  let reason: string | undefined;
  if (
    input &&
    ts.isArrowFunction(owner) &&
    owner.body === call &&
    ts.isIdentifier(input) &&
    ts.isIdentifier(call.expression.expression) &&
    ts.isCallExpression(owner.parent) &&
    ts.isPropertyAccessExpression(owner.parent.expression) &&
    ['every', 'some'].includes(owner.parent.expression.name.text)
  ) {
    const statement = outerExpression(owner.parent).parent;
    const method = statement.parent?.parent;
    if (
      ts.isReturnStatement(statement) &&
      ts.isBlock(statement.parent) &&
      method &&
      ts.isMethodDeclaration(method) &&
      !ts.isPrivateIdentifier(method.name) &&
      !(ts.getCombinedModifierFlags(method) & (ts.ModifierFlags.Private | ts.ModifierFlags.Protected)) &&
      [input, call.expression.expression].every((collection) => {
        const collectionDeclaration = context.checker.getSymbolAtLocation(collection)?.valueDeclaration;
        return method.parameters.some((parameter) => parameter === collectionDeclaration);
      })
    ) {
      reason =
        'This public method receives both collections from its callers. Check how many keys they request; building a Set for a single lookup can cost more than includes().';
    }
  }
  if (
    input &&
    !findRepeatOwner(owner, context.checker) &&
    arraySizeBound(input, context.checker, 0, true) <= smallLiteralLimit
  ) {
    reason =
      'The iteration starts from a small bounded source; check whether it grows through an alias before building a Set.';
  }
  // Unknown size is the weakest reason, so test, seed or polling context found for the same site
  // takes precedence.
  reason ??= repeatedReviewContext(
    call.expression.name,
    'array-repeated-membership',
    context.checker,
    call.getSourceFile(),
  );
  if (!reason && nameSuggestsSmallConfigList(call.expression.expression, context.checker)) {
    reason = smallConfigListReason;
  }
  reason ??= isKnownDataSource(call.expression.expression, context.checker) ? undefined : unknownSizeReason;
  context.report(
    call.expression.name,
    'array-repeated-membership',
    copiedFromSet(call.expression.expression, context.checker)
      ? 'This array was copied from a Set and is then searched with includes() repeatedly, scanning it each time. Keep the original Set and call `set.has(value)`; keep the array only where order matters.'
      : 'Each includes() can rescan this array, so many lookups cost quadratic time. Build `const lookup = new Set(values)` once outside the iteration and call `lookup.has(value)` if membership is stable.',
    reason,
  );
}

export function checkRebuiltLookup(call: MethodCall, context: PerformanceRuleContext): void {
  const constructed = ts.skipOuterExpressions(call.expression.expression);
  if (
    !ts.isNewExpression(constructed) ||
    !ts.isIdentifier(constructed.expression) ||
    constructed.arguments?.length !== 1 ||
    call.arguments.length !== 1
  )
    return;
  const constructor = constructed.expression;
  if (constructor.text !== 'Map' && (constructor.text !== 'Set' || call.expression.name.text !== 'has')) return;
  const source = ts.skipOuterExpressions(constructed.arguments[0]);
  if (!ts.isIdentifier(source)) return;
  const { checker } = context;
  const owner = findRepeatOwner(call, checker);
  if (!owner) return;
  const symbol = externalBinding(source, owner, checker);
  if (!symbol || !nativeCollection(source, repeatableCollections, checker)) return;
  const declaration = checker.getSymbolAtLocation(constructor)?.valueDeclaration;
  if (!declaration || !isDefaultLibrary(checker, declaration.getSourceFile()) || mayChange(symbol, owner, checker))
    return;
  context.report(
    constructed,
    'rebuild-lookup-in-loop',
    `Each iteration rebuilds this ${constructor.text} from the same source, repeating the full copy. Construct it once before the loop and reuse it if the source does not change meanwhile.`,
  );
}

function keyBinding(expression: Expression, checker: CheckerAdapter): Node | undefined {
  let root = ts.skipOuterExpressions(expression);
  while (ts.isPropertyAccessExpression(root)) root = ts.skipOuterExpressions(root.expression);
  if (!ts.isIdentifier(root)) return;
  const binding = checker.getSymbolAtLocation(root)?.valueDeclaration;
  // A destructured name belongs to the parameter or variable that holds the whole item.
  return binding && ts.isBindingElement(binding)
    ? ts.findAncestor(binding, (node) => ts.isParameter(node) || ts.isVariableDeclaration(node))
    : binding;
}

// Only the driver's own conversion is recognised. Other toString implementations can perform
// arbitrary work.
function objectIdProjection(expression: Expression, context: PerformanceRuleContext): Expression | undefined {
  const call = ts.skipOuterExpressions(expression);
  if (!ts.isCallExpression(call) || call.arguments.length || ts.isOptionalChain(call)) return;
  const callee = call.expression;
  if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== 'toString') return;
  if (!context.isPackageType(callee.expression, objectIdPackages, objectIdTypes)) return;
  const declaration = context.checker.getResolvedSignature(call)?.declaration;
  const owner = declaration?.parent;
  if (
    owner &&
    ts.isClassDeclaration(owner) &&
    owner.name &&
    context.isPackageType(owner.name, objectIdPackages, objectIdTypes)
  ) {
    return callee.expression;
  }
}

// The `===` comparison a find() predicate returns, with the predicate's single item parameter.
function findComparison(call: CallExpression): FindComparison | undefined {
  const predicate = syncCallback(call.arguments[0]);
  if (call.arguments.length !== 1 || !predicate) return;
  const innerBinding = predicate.parameters[0];
  if (!innerBinding || !hasIdentifierName(innerBinding)) return;
  let result = predicate.body;
  if (ts.isBlock(result)) {
    const [statement] = result.statements;
    if (result.statements.length !== 1 || !ts.isReturnStatement(statement) || !statement.expression) return;
    result = statement.expression;
  }
  const comparison = ts.skipOuterExpressions(result);
  if (!ts.isBinaryExpression(comparison) || comparison.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken)
    return;
  return { innerBinding, comparison };
}

// The predicate overload can return a narrower element type. A regular Map loses that public return
// type.
function narrowsFindResult(call: CallExpression, checker: CheckerAdapter): boolean {
  const declaration = checker.getResolvedSignature(call)?.declaration;
  const predicateType = declaration && ts.isFunctionLike(declaration) ? declaration.parameters[0]?.type : undefined;
  return (
    predicateType !== undefined && ts.isFunctionTypeNode(predicateType) && ts.isTypePredicateNode(predicateType.type)
  );
}

// `item.key === probe` in a find() predicate: the item side, its key path after the parameter, and
// the probe.
function findKeySides(call: CallExpression): FindKeySides | undefined {
  const found = findComparison(call);
  if (!found) return;
  const parameterName = found.innerBinding.name.text;
  const sides = [found.comparison.left, found.comparison.right].map((side) => ts.skipOuterExpressions(side));
  const itemIndex = sides.findIndex((side) => {
    let root = side;
    while (ts.isPropertyAccessExpression(root)) root = root.expression;
    return side !== root && ts.isIdentifier(root) && root.text === parameterName;
  });
  if (itemIndex === -1) return;
  const item = sides[itemIndex];
  if (!ts.isPropertyAccessExpression(item)) return;
  return {
    parameter: found.innerBinding,
    item,
    path: item.getText().slice(parameterName.length),
    probe: sides[1 - itemIndex],
  };
}

// A key type whose text names no declaration, so it can be written anywhere in the file.
function printableKeyType(type: TypeAdapter): boolean {
  return typeParts(type).every(
    (part) => part.flags & (printableKeyFlags | nullishFlags) && !(part.flags & ts.TypeFlags.EnumLike),
  );
}

// What the site fix needs to index `receiver.find((item) => item.key === probe)` with a typed Map:
// - keyType: the Map key type covering every probe used with this array and key path in the file, or `unknown`;
// - inferKey: the stored key type already accepts every probe, so `new Map(entries)` can infer it;
// - numericKey: a key can be NaN, so NaN keys must be filtered to match strict equality;
// - eager: every element is non-nullish and the key is a plain property, so building the index
// early cannot throw
//   or run a getter.
// Every find on the same array and key path gets the same facts, so their shared fix is identical.
function findLookupFacts(call: MethodCall, sides: FindKeySides, checker: CheckerAdapter): FindLookupFacts | undefined {
  const receiver = call.expression.expression;
  if (!ts.isIdentifier(receiver)) return;
  const symbol = checker.getSymbolAtLocation(receiver);
  const keyType = checker.getTypeAtLocation(sides.item);
  const probeTypes: TypeAdapter[] = [];
  let narrows = false;
  (function visit(node: Node): void {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'find' &&
      ts.isIdentifier(node.expression.expression) &&
      checker.getSymbolAtLocation(node.expression.expression) === symbol
    ) {
      const other = findKeySides(node);
      if (other?.path === sides.path) {
        probeTypes.push(checker.getTypeAtLocation(other.probe));
        narrows ||= narrowsFindResult(node, checker);
      }
    }
    ts.forEachChild(node, visit);
  })(call.getSourceFile());
  if (narrows) return;
  const inferKey = probeTypes.every((probe) => checker.isTypeAssignableTo(probe, keyType));
  const candidates = [keyType, ...probeTypes];
  const covering = candidates.find(
    (candidate) =>
      printableKeyType(candidate) && candidates.every((other) => checker.isTypeAssignableTo(other, candidate)),
  );
  const elementType = checker.getTypeAtLocation(sides.parameter);
  const declarations = checker.getSymbolAtLocation(sides.item.name)?.declarations ?? [];
  // The native checker has no format flags, so a long union may come back truncated with "...".
  const keyText = covering && checker.typeToString(covering);
  return {
    keyType: keyText && !keyText.includes('...') ? keyText : 'unknown',
    inferKey,
    numericKey: typeParts(keyType).some((part) => !(part.flags & neverNaNFlags)),
    eager:
      ts.isIdentifier(sides.item.expression) &&
      typeParts(elementType).every(
        (part) => !(part.flags & (nullishFlags | ts.TypeFlags.Any | ts.TypeFlags.Unknown)),
      ) &&
      !declarations.some((declaration) => ts.isGetAccessorDeclaration(declaration)),
  };
}

function emptyFallback(expression: Expression): Expression {
  const value = ts.skipOuterExpressions(expression);
  if (
    !ts.isBinaryExpression(value) ||
    ![ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken].includes(value.operatorToken.kind)
  )
    return value;
  const fallback = ts.skipOuterExpressions(value.right);
  return ts.isArrayLiteralExpression(fallback) && fallback.elements.length === 0
    ? ts.skipOuterExpressions(value.left)
    : value;
}

// `record.options.find(...)` or `const steps = run.state?.flow?.steps ?? []`: a list hanging off
// one non-list local value, not off `this` or a result container.
function isChildListOfOneRecord(receiver: Expression, checker: CheckerAdapter): boolean {
  let list = ts.skipOuterExpressions(receiver);
  if (ts.isIdentifier(list)) {
    const binding = resolvedSymbol(list, checker)?.valueDeclaration;
    if (
      !binding ||
      !ts.isVariableDeclaration(binding) ||
      !(binding.parent.flags & ts.NodeFlags.Const) ||
      !binding.initializer
    )
      return false;
    list = emptyFallback(binding.initializer);
  }
  if (!ts.isPropertyAccessExpression(list) || resultListNames.has(list.name.text)) return false;
  let root = ts.skipOuterExpressions(list.expression);
  while (ts.isPropertyAccessExpression(root)) root = ts.skipOuterExpressions(root.expression);
  return ts.isIdentifier(root) && !nativeCollection(root, repeatableCollections, checker);
}

function findDetails(
  call: MethodCall,
  projections: readonly (Expression | undefined)[],
  checker: CheckerAdapter,
): FindDetails | undefined {
  if (narrowsFindResult(call, checker)) return { narrowsFindResult: true };
  const sides = projections.some(Boolean) ? undefined : findKeySides(call);
  const findLookup = sides && findLookupFacts(call, sides, checker);
  return findLookup ? { findLookup } : undefined;
}

export function checkFind(call: MethodCall, context: PerformanceRuleContext): void {
  const found = findComparison(call);
  if (!found) return;
  const { innerBinding, comparison } = found;
  const owner = reusableArrayOwner(call, context.checker);
  if (!owner) return;
  const operands = [comparison.left, comparison.right];
  const projections = operands.map((operand) => objectIdProjection(operand, context));
  const bindings = operands.map((operand, index) => keyBinding(projections[index] ?? operand, context.checker));
  if (!bindings.includes(innerBinding)) return;
  const outerBindings = ts.isFunctionLike(owner)
    ? owner.parameters.slice(0, 2)
    : ts.isForOfStatement(owner) && ts.isVariableDeclarationList(owner.initializer)
      ? owner.initializer.declarations
      : [];
  if (outerBindings.some((binding) => bindings.includes(binding))) {
    const method = call.expression.name.text;
    // The find details describe a row lookup; a findIndex lookup needs a Map to the index, so it is
    // left manual.
    const details = method === 'find' ? findDetails(call, projections, context.checker) : undefined;
    context.report(
      call.expression.name,
      'array-repeated-find',
      `Each item can rescan the lookup array with ${method}(), so cost grows with items times rows. Build \`const byKey = new Map()\` once (first match wins) and call \`byKey.get(key)\`; keep the original key-equality semantics.`,
      projections.some(Boolean)
        ? 'ObjectId string keys require review. Keep the same conversion and first-match behavior when indexing.'
        : isChildListOfOneRecord(call.expression.expression, context.checker)
          ? childListReason
          : nameSuggestsSmallConfigList(call.expression.expression, context.checker)
            ? smallConfigListReason
            : undefined,
      details,
    );
  }
}
