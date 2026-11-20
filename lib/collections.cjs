'use strict';

const { syntax: ts, isDefaultLibrary } = require('./compiler.cjs');
const { findRepeatOwner, isStandardArrayCall, outerExpression, standardInterface } = require('./repeated.cjs');
const { checkFilterExistence } = require('./filter-existence.cjs');

const smallLiteralLimit = 8;
// A literal list of plain values is as cheap to scan as a Set is to build up to roughly this length.
const constantListLimit = 16;
const maxBoundDepth = 8;
const mutatingMethods = new Set([
  'add',
  'clear',
  'copyWithin',
  'delete',
  'fill',
  'pop',
  'push',
  'reverse',
  'set',
  'shift',
  'sort',
  'splice',
  'unshift',
]);
const callbacksReceivingArray = new Set([
  'every',
  'filter',
  'find',
  'findIndex',
  'findLast',
  'findLastIndex',
  'flatMap',
  'forEach',
  'map',
  'reduce',
  'reduceRight',
  'some',
]);
const arrays = new Set(['Array', 'ReadonlyArray']);
const setTypes = new Set(['Set', 'ReadonlySet']);
const repeatableCollections = new Set([...arrays, ...setTypes, 'Map', 'ReadonlyMap']);
const writesByChecker = new WeakMap();

// Cache by iteration site so multiple lookups in one loop share a single write scan.
function writtenBindings(owner, checker) {
  // Watch builds can reuse a loop's syntax tree with a new checker's symbols.
  let writesByOwner = writesByChecker.get(checker);
  if (!writesByOwner) {
    writesByOwner = new WeakMap();
    writesByChecker.set(checker, writesByOwner);
  }
  let bindings = writesByOwner.get(owner);
  if (bindings) return bindings;
  bindings = { mutated: new Set(), reassigned: new Map(), aliases: new Set() };
  function alias(expression) {
    if (!expression) return;
    const value = ts.skipOuterExpressions(expression);
    if (ts.isIdentifier(value)) {
      // A same-named binding in a nested scope can only make this proof more conservative.
      bindings.aliases.add(value.text);
    } else if (ts.isConditionalExpression(value)) {
      alias(value.whenTrue);
      alias(value.whenFalse);
    }
  }
  function record(expression) {
    const target = ts.skipOuterExpressions(expression);
    if (ts.isIdentifier(target)) bindings.mutated.add(checker.getSymbolAtLocation(target));
  }
  function recordAssignment(target) {
    if (ts.isIdentifier(target)) {
      const symbol = checker.getSymbolAtLocation(target);
      bindings.reassigned.set(symbol, bindings.reassigned.has(symbol) ? undefined : target);
      return;
    }
    while (ts.isAccessExpression(target)) target = ts.skipOuterExpressions(target.expression);
    record(target);
  }
  function visit(node) {
    if (ts.isBinaryExpression(node) && ts.isAssignmentOperator(node.operatorToken.kind)) {
      recordAssignment(ts.skipOuterExpressions(node.left));
      alias(node.right);
    } else if (ts.isVariableDeclaration(node) || ts.isPropertyAssignment(node)) {
      alias(node.initializer);
    } else if (ts.isShorthandPropertyAssignment(node)) {
      alias(node.name);
    } else if (ts.isExportSpecifier(node)) {
      alias(node.propertyName || node.name);
    } else if (ts.isArrayLiteralExpression(node)) {
      for (const element of node.elements) alias(element);
    } else if (ts.isReturnStatement(node)) {
      alias(node.expression);
    } else if (ts.isArrowFunction(node) && !ts.isBlock(node.body)) {
      alias(node.body);
    } else if (ts.isNewExpression(node)) {
      for (const argument of node.arguments || []) alias(argument);
    } else if (
      (ts.isForOfStatement(node) || ts.isForInStatement(node)) &&
      !ts.isVariableDeclarationList(node.initializer)
    ) {
      recordAssignment(ts.skipOuterExpressions(node.initializer));
    } else if (ts.isDeleteExpression(node)) {
      recordAssignment(ts.skipOuterExpressions(node.expression));
    } else if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)
    ) {
      recordAssignment(ts.skipOuterExpressions(node.operand));
    } else if (ts.isCallExpression(node)) {
      const access = node.expression;
      if (ts.isPropertyAccessExpression(access) && mutatingMethods.has(access.name.text)) {
        record(access.expression);
      } else if (
        ts.isPropertyAccessExpression(access) &&
        callbacksReceivingArray.has(access.name.text) &&
        node.arguments.length > 0
      ) {
        // Built-in iteration callbacks can expose the source as their last argument.
        const callback = ts.skipOuterExpressions(node.arguments[0]);
        if (
          !ts.isFunctionLike(callback) ||
          callback.parameters.length >= 3 ||
          callback.parameters.some((parameter) => parameter.dotDotDotToken)
        ) {
          alias(access.expression);
        }
      } else if (ts.isElementAccessExpression(access)) {
        const key = ts.skipOuterExpressions(access.argumentExpression);
        if (!ts.isStringLiteralLike(key) || mutatingMethods.has(key.text)) record(access.expression);
      }
      // A callee taking the array can change membership through its argument.
      for (const argument of node.arguments) record(argument);
    }
    ts.forEachChild(node, visit);
  }
  visit(owner);
  writesByOwner.set(owner, bindings);
  return bindings;
}

function externalBinding(identifier, owner, checker) {
  const symbol = checker.getSymbolAtLocation(identifier);
  const binding = symbol?.valueDeclaration;
  if (!binding || (!ts.isParameter(binding) && !ts.isVariableDeclaration(binding))) return;
  if (binding.getSourceFile() === owner.getSourceFile() && binding.pos >= owner.pos && binding.end <= owner.end) return;
  return symbol;
}

function mayChange(symbol, owner, checker) {
  const writes = writtenBindings(owner, checker);
  return writes.mutated.has(symbol) || writes.reassigned.has(symbol);
}

function hasSmallReadonlyTuple(type) {
  return (
    type &&
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
function arraySizeBound(expression, checker, depth = 0, allowAliases = false) {
  if (!expression || depth >= maxBoundDepth) return Infinity;
  const value = ts.skipOuterExpressions(expression);
  const bound = (child) => arraySizeBound(child, checker, depth + 1, allowAliases);
  if (ts.isArrayLiteralExpression(value)) {
    if (value.elements.length > smallLiteralLimit) return Infinity;
    let size = 0;
    for (const element of value.elements) size += ts.isSpreadElement(element) ? bound(element.expression) : 1;
    return size;
  }
  if (ts.isConditionalExpression(value)) return Math.max(bound(value.whenTrue), bound(value.whenFalse));
  if (ts.isIdentifier(value)) {
    const symbol = checker.getSymbolAtLocation(value);
    const binding = symbol?.valueDeclaration;
    if (!binding) return Infinity;
    if (hasSmallReadonlyTuple(binding.type)) return binding.type.type.elements.length;
    if (
      !ts.isVariableDeclaration(binding) ||
      !binding.initializer ||
      !(binding.parent.flags & ts.NodeFlags.Const) ||
      ts.getCombinedModifierFlags(binding) & ts.ModifierFlags.Export
    )
      return Infinity;
    const limit = bound(binding.initializer);
    if (limit > smallLiteralLimit) return Infinity;
    const scope = ts.findAncestor(binding, (node) => ts.isFunctionLike(node) || ts.isSourceFile(node));
    const writes = writtenBindings(scope, checker);
    return (!allowAliases && writes.aliases.has(value.text)) ||
      writes.mutated.has(symbol) ||
      writes.reassigned.has(symbol)
      ? Infinity
      : limit;
  }
  if (!ts.isCallExpression(value) || !ts.isPropertyAccessExpression(value.expression)) return Infinity;
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
  const method = value.expression.name.text;
  if (
    (method === 'values' || method === 'keys') &&
    value.arguments.length === 1 &&
    ts.isIdentifier(value.expression.expression) &&
    value.expression.expression.text === 'Object' &&
    ts.isIdentifier(ts.skipOuterExpressions(value.arguments[0]))
  ) {
    let symbol = checker.getSymbolAtLocation(ts.skipOuterExpressions(value.arguments[0]));
    if (symbol?.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
    if (symbol?.flags & ts.SymbolFlags.Enum) return enumMemberCount(symbol);
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

function isShortLiteralList(list) {
  if (list.elements.length <= smallLiteralLimit) return !list.elements.some(ts.isSpreadElement);
  return (
    list.elements.length <= constantListLimit &&
    list.elements.every((element) => ts.isStringLiteralLike(element) || ts.isNumericLiteral(element))
  );
}

function enumMemberCount(enumSymbol) {
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

function iterationInput(owner) {
  if (ts.isForOfStatement(owner)) return owner.expression;
  if (ts.isFunctionLike(owner)) return outerExpression(owner).parent.expression.expression;
}

function reusableArrayOwner(call, checker) {
  const receiver = ts.skipOuterExpressions(call.expression.expression);
  if (!ts.isIdentifier(receiver)) {
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
      !declarations.every(
        (property) => property.kind === ts.SyntaxKind.PropertySignature && !hasSmallReadonlyTuple(property.type),
      )
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
  const owner = findRepeatOwner(call, checker);
  if (!owner) return;
  const symbol = externalBinding(receiver, owner, checker);
  if (!symbol) return;
  const binding = symbol.valueDeclaration;
  if (ts.isVariableDeclaration(binding) && !(binding.parent.flags & ts.NodeFlags.Const)) return;
  // A lookup over a short literal already has a cheap default representation.
  // Exporting it or using it in a fixture tuple alone is no evidence it grew.
  const initial =
    ts.isVariableDeclaration(binding) && binding.initializer && ts.skipOuterExpressions(binding.initializer);
  if (initial && ts.isArrayLiteralExpression(initial) && isShortLiteralList(initial)) {
    const scope = ts.findAncestor(binding, (node) => ts.isFunctionLike(node) || ts.isSourceFile(node));
    if (!mayChange(symbol, scope, checker)) return;
  }
  if (arraySizeBound(receiver, checker) <= smallLiteralLimit) return;
  let repeat = owner;
  while (arraySizeBound(iterationInput(repeat), checker) <= smallLiteralLimit) {
    repeat = findRepeatOwner(repeat, checker);
    if (!repeat || !externalBinding(receiver, repeat, checker)) return;
  }
  if (isStandardArrayCall(call, checker) && !mayChange(symbol, repeat, checker)) return owner;
}

function checkMembership(call, context) {
  if (call.arguments.length !== 1 || ts.isSpreadElement(call.arguments[0])) return;
  const owner = reusableArrayOwner(call, context.checker);
  if (!owner) return;
  const input = iterationInput(owner);
  let reason;
  if (
    input &&
    ts.isArrowFunction(owner) &&
    owner.body === call &&
    ts.isIdentifier(input) &&
    ts.isIdentifier(call.expression.expression) &&
    owner.parent.expression &&
    ['every', 'some'].includes(owner.parent.expression.name?.text)
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
      [input, call.expression.expression].every((collection) =>
        method.parameters.includes(context.checker.getSymbolAtLocation(collection)?.valueDeclaration),
      )
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
  context.report(
    call.expression.name,
    'array-repeated-membership',
    copiedFromSet(call.expression.expression, context.checker)
      ? 'This array was copied from a Set and is searched repeatedly. If membership is unchanged, retain that Set for has() and keep the array where order is needed.'
      : 'Each includes() can scan this array again. For many lookups with stable membership, build one Set outside the iteration and use has().',
    reason,
  );
}

function copiedFromSet(receiver, checker) {
  const initializer = checker.getSymbolAtLocation(ts.skipOuterExpressions(receiver))?.valueDeclaration?.initializer;
  if (!initializer) return false;
  const copy = ts.skipOuterExpressions(initializer);
  let source;
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
  return source && nativeCollection(source, setTypes, checker);
}

function nativeCollection(expression, names, checker) {
  const symbol = checker.getTypeAtLocation(expression).getSymbol();
  return (
    symbol &&
    names.has(symbol.name) &&
    symbol.declarations?.some((declaration) => isDefaultLibrary(checker, declaration.getSourceFile()))
  );
}

function checkRebuiltLookup(call, context) {
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
    `Each lookup rebuilds this ${constructor.text} from the source collection. If the source stays stable, construct it once outside the iteration and reuse it.`,
  );
}

function emptySpreadSource(expression) {
  const value = ts.skipOuterExpressions(expression);
  return (
    (ts.isArrayLiteralExpression(value) && value.elements.length === 0) ||
    (ts.isStringLiteralLike(value) && value.text === '')
  );
}

function addsAnotherItem(elements, copied) {
  return elements.some(
    (element) => element !== copied && (!ts.isSpreadElement(element) || !emptySpreadSource(element.expression)),
  );
}

function growingArrayCopy(result, target) {
  if (
    ts.isCallExpression(result) &&
    ts.isPropertyAccessExpression(result.expression) &&
    result.expression.name.text === 'concat' &&
    !ts.isOptionalChain(result)
  ) {
    const receiver = ts.skipOuterExpressions(result.expression.expression);
    return (
      ts.isIdentifier(receiver) &&
      receiver.text === target.text &&
      result.arguments.some((argument) => {
        if (ts.isSpreadElement(argument)) return !emptySpreadSource(argument.expression);
        const value = ts.skipOuterExpressions(argument);
        return !ts.isArrayLiteralExpression(value) || value.elements.length > 0;
      })
    );
  }
  if (!ts.isArrayLiteralExpression(result)) return false;
  const copied = result.elements.find((element) => {
    if (!ts.isSpreadElement(element)) return false;
    const value = ts.skipOuterExpressions(element.expression);
    return ts.isIdentifier(value) && value.text === target.text;
  });
  return copied && addsAnotherItem(result.elements, copied);
}

function checkCollectionAssignment(assignment, context) {
  if (assignment.operatorToken.kind !== ts.SyntaxKind.EqualsToken || !ts.isIdentifier(assignment.left)) return;
  const target = assignment.left;
  const result = ts.skipOuterExpressions(assignment.right);
  const { checker } = context;
  if (!growingArrayCopy(result, target)) return;
  const owner = findRepeatOwner(assignment, checker);
  if (!owner) return;
  const symbol = externalBinding(target, owner, checker);
  if (!symbol || !nativeCollection(target, arrays, checker)) return;
  if (ts.isCallExpression(result) && !isStandardArrayCall(result, checker)) return;
  const writes = writtenBindings(owner, checker);
  if (writes.mutated.has(symbol) || writes.reassigned.get(symbol) !== target) return;
  context.report(
    assignment,
    'loop-copy-accumulator',
    'Each iteration copies the accumulated array before adding items. If earlier versions are unobserved, build one fresh array incrementally, preserving item order.',
  );
}

function keyBinding(expression, checker) {
  let root = ts.skipOuterExpressions(expression);
  while (ts.isPropertyAccessExpression(root)) root = ts.skipOuterExpressions(root.expression);
  if (!ts.isIdentifier(root)) return;
  const binding = checker.getSymbolAtLocation(root)?.valueDeclaration;
  // A destructured name belongs to the parameter or variable that holds the whole item.
  return binding && ts.isBindingElement(binding)
    ? ts.findAncestor(binding, (node) => ts.isParameter(node) || ts.isVariableDeclaration(node))
    : binding;
}

function syncCallback(expression) {
  if (!expression) return;
  const callback = ts.skipOuterExpressions(expression);
  if (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback)) return;
  if (!(ts.getCombinedModifierFlags(callback) & ts.ModifierFlags.Async) && !callback.asteriskToken) return callback;
}

function checkFind(call, context) {
  const predicate = syncCallback(call.arguments[0]);
  if (call.arguments.length !== 1 || !predicate) return;
  const innerBinding = predicate.parameters[0];
  if (!innerBinding || !ts.isIdentifier(innerBinding.name)) return;
  let result = predicate.body;
  if (ts.isBlock(result)) {
    if (result.statements.length !== 1 || !ts.isReturnStatement(result.statements[0])) return;
    result = result.statements[0].expression;
    if (!result) return;
  }
  const comparison = ts.skipOuterExpressions(result);
  if (!ts.isBinaryExpression(comparison) || comparison.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken)
    return;
  const owner = reusableArrayOwner(call, context.checker);
  if (!owner) return;
  const bindings = [keyBinding(comparison.left, context.checker), keyBinding(comparison.right, context.checker)];
  if (!bindings.includes(innerBinding)) return;
  const outerBindings = ts.isFunctionLike(owner)
    ? owner.parameters.slice(0, 2)
    : ts.isForOfStatement(owner) && ts.isVariableDeclarationList(owner.initializer)
      ? owner.initializer.declarations
      : [];
  if (outerBindings.some((binding) => bindings.includes(binding))) {
    context.report(
      call.expression.name,
      'array-repeated-find',
      'Each item can scan the lookup array again. For stable keys, build a Map once and preserve the original first-match and key-equality behavior.',
    );
  }
}

function usesIterationParameter(expression, parameters, checker) {
  function visit(node) {
    if (ts.isIdentifier(node)) {
      const binding = checker.getSymbolAtLocation(node)?.valueDeclaration;
      if (binding) {
        const parameter = ts.isBindingElement(binding) ? ts.findAncestor(binding, ts.isParameter) : binding;
        if (parameters.includes(parameter)) return true;
      }
    }
    return ts.forEachChild(node, visit);
  }
  return visit(expression);
}

function smallKeyDomain(expression, checker) {
  const type = checker.getTypeAtLocation(expression);
  const alternatives = type.isUnion() ? type.types : [type];
  return (
    alternatives.length <= smallLiteralLimit &&
    alternatives.every(
      (alternative) =>
        alternative.flags &
        (ts.TypeFlags.Literal | ts.TypeFlags.UniqueESSymbol | ts.TypeFlags.Null | ts.TypeFlags.Undefined),
    )
  );
}

function checkReducer(call, context) {
  const callback = syncCallback(call.arguments[0]);
  if (!callback) return;
  const accumulator = callback.parameters[0]?.name;
  if (!accumulator || !ts.isIdentifier(accumulator)) return;
  const { checker } = context;

  function growingCopy(expression) {
    const result = ts.skipOuterExpressions(expression);
    if (ts.isConditionalExpression(result)) return growingCopy(result.whenTrue) || growingCopy(result.whenFalse);
    const array = ts.isArrayLiteralExpression(result);
    if (!array && !ts.isObjectLiteralExpression(result)) return;
    const entries = array ? result.elements : result.properties;
    const spread = entries.find((entry) => {
      if (!ts.isSpreadElement(entry) && !ts.isSpreadAssignment(entry)) return false;
      const copied = ts.skipOuterExpressions(entry.expression);
      return (
        ts.isIdentifier(copied) &&
        copied.text === accumulator.text &&
        checker.getSymbolAtLocation(copied)?.valueDeclaration === callback.parameters[0]
      );
    });
    if (!spread) return;
    if (array) return addsAnotherItem(entries, spread) ? spread : undefined;
    const dynamicKey = entries.some(
      (property) =>
        property.name &&
        ts.isComputedPropertyName(property.name) &&
        usesIterationParameter(property.name.expression, callback.parameters.slice(1, 3), checker) &&
        !smallKeyDomain(property.name.expression, checker),
    );
    return dynamicKey ? spread : undefined;
  }

  function returnedCopy(statement) {
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
    ts.isArrayLiteralExpression(input) &&
    input.elements.length <= maxItemsForOneStep &&
    !input.elements.some(ts.isSpreadElement)
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
    'Copying a growing accumulator on each reduction step can take quadratic time. If intermediate versions are unobserved, build one fresh result incrementally.',
  );
}

function checkCollectionCall(call, context) {
  if (!ts.isPropertyAccessExpression(call.expression) || ts.isOptionalChain(call)) return;
  switch (call.expression.name.text) {
    case 'filter':
      return checkFilterExistence(call, context, syncCallback(call.arguments[0]));
    case 'has':
    case 'get':
      return checkRebuiltLookup(call, context);
    case 'find':
      return checkFind(call, context);
    case 'includes':
      return checkMembership(call, context);
    case 'reduce':
      return checkReducer(call, context);
  }
}

module.exports = { checkCollectionCall, checkCollectionAssignment };
