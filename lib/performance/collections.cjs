'use strict';

const { syntax: ts, isDefaultLibrary } = require('./compiler.cjs');
const { findRepeatOwner, isStandardArrayCall, outerExpression, standardInterface } = require('./repeated.cjs');
const { checkFilterExistence } = require('./filter-existence.cjs');
const { clientHookContext, clientSourcePattern, isTestSource, repeatedReviewContext } = require('./review-context.cjs');

const smallLiteralLimit = 8;
// A literal list of plain values is as cheap to scan as a Set is to build up to roughly this length.
const constantListLimit = 16;
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
// A list of distinct enum or literal values cannot outgrow its declared members; larger unions are not hand-sized.
const finiteDomainLimit = 64;
const moduleLoadReason =
  'Runs once when the module loads, not per request, so the accumulator copy is paid at startup; assess only if the input grows with data.';
// Constant tables are authored by hand, so they stay short even past the inline limit.
const constantTableLimit = 20;
const maxBoundDepth = 8;
const metadataReaders = new Set(['getAllAndOverride', 'getAllAndMerge']);
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
const objectIdPackages = ['bson', 'mongodb', 'mongoose'];
const objectIdTypes = ['ObjectId'];
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
  bindings = { mutated: new Set(), passed: new Map(), reassigned: new Map(), aliases: new Set() };
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
  function recordPassed(expression, position) {
    const target = ts.skipOuterExpressions(expression);
    if (!ts.isIdentifier(target)) return;
    const symbol = checker.getSymbolAtLocation(target);
    bindings.passed.set(symbol, Math.min(position, bindings.passed.get(symbol) ?? Infinity));
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
      // A callee taking the array can change membership through its argument, from the call onward.
      // The built-in Object.assign only reads its sources, so just its target counts.
      const passedArguments = isObjectAssign(node, checker) ? node.arguments.slice(0, 1) : node.arguments;
      for (const argument of passedArguments) recordPassed(argument, node.pos);
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
  return writes.mutated.has(symbol) || writes.passed.has(symbol) || writes.reassigned.has(symbol);
}

// A call after the use cannot change what the use already read, so only earlier calls count there.
function mayChangeBefore(symbol, scope, usePosition, checker) {
  const writes = writtenBindings(scope, checker);
  return (
    writes.mutated.has(symbol) || writes.reassigned.has(symbol) || (writes.passed.get(symbol) ?? Infinity) < usePosition
  );
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
  if (ts.isIdentifier(value)) return constantArrayBound(value, checker, bound, allowAliases);
  if (ts.isBinaryExpression(value) && fallbackOperators.has(value.operatorToken.kind)) {
    return Math.max(bound(value.left), bound(value.right));
  }
  if (ts.isElementAccessExpression(value) || ts.isPropertyAccessExpression(value)) {
    return constantTableEntryBound(value, checker, bound);
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

const fallbackOperators = new Set([ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken]);

function isLiteralList(list, limit) {
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

function resolvedSymbol(identifier, checker) {
  const symbol = checker.getSymbolAtLocation(identifier);
  return symbol?.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
}

function isModuleLevel(declaration) {
  return ts.isSourceFile(declaration.parent?.parent?.parent);
}

function isConstAssertion(initializer) {
  let expression = initializer;
  while (ts.isParenthesizedExpression(expression)) expression = expression.expression;
  return (
    ts.isAsExpression(expression) &&
    ts.isTypeReferenceNode(expression.type) &&
    expression.type.typeName.text === 'const'
  );
}

// A const declaration whose value nobody in this file or its declaring file changes before the use.
function unchangedConstant(identifier, checker) {
  const symbol = checker.getSymbolAtLocation(identifier);
  const declarationSymbol = resolvedSymbol(identifier, checker);
  const binding = declarationSymbol?.valueDeclaration;
  if (
    !binding ||
    !ts.isVariableDeclaration(binding) ||
    !binding.initializer ||
    !(binding.parent.flags & ts.NodeFlags.Const)
  )
    return;
  const imported = symbol !== declarationSymbol;
  const exported = ts.getCombinedModifierFlags(binding) & ts.ModifierFlags.Export;
  if (exported && !imported && !isConstAssertion(binding.initializer)) return;
  const scope = ts.findAncestor(binding, (node) => ts.isFunctionLike(node) || ts.isSourceFile(node));
  const usePosition = scope.getSourceFile() === identifier.getSourceFile() ? identifier.pos : Infinity;
  if (mayChangeBefore(declarationSymbol, scope, usePosition, checker)) return;
  if (imported && mayChangeBefore(symbol, identifier.getSourceFile(), identifier.pos, checker)) return;
  return { binding, scope, imported };
}

function constantArrayBound(identifier, checker, bound, allowAliases) {
  const symbol = checker.getSymbolAtLocation(identifier);
  if (hasSmallReadonlyTuple(symbol?.valueDeclaration?.type)) return symbol.valueDeclaration.type.type.elements.length;
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

function constantObjectLiteral(expression, checker, maxProperties = Infinity) {
  const identifier = ts.skipOuterExpressions(expression);
  if (!ts.isIdentifier(identifier)) return;
  const constant = unchangedConstant(identifier, checker);
  const initializer = constant && ts.skipOuterExpressions(constant.binding.initializer);
  if (initializer && ts.isObjectLiteralExpression(initializer) && initializer.properties.length <= maxProperties) {
    return initializer;
  }
}

// Reading one entry from a hand-written lookup table (TABLE[key]) yields one of its literal lists.
function constantTableEntryBound(access, checker, bound) {
  const table = constantObjectLiteral(access.expression, checker);
  if (!table) return Infinity;
  let largest = 0;
  for (const property of table.properties) {
    if (!ts.isPropertyAssignment(property)) return Infinity;
    largest = Math.max(largest, bound(property.initializer));
  }
  return largest;
}

// Reading framework decorator metadata (@Roles(...), @SetMetadata) returns what a developer wrote on the handler.
function isDecoratorMetadataRead(call) {
  const callee = call.expression;
  if (metadataReaders.has(callee.name.text)) return true;
  if (callee.name.text !== 'get') return false;
  const receiver = ts.skipOuterExpressions(callee.expression);
  const receiverName = ts.isPropertyAccessExpression(receiver) ? receiver.name.text : receiver.text;
  return typeof receiverName === 'string' && /reflector$/i.test(receiverName);
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

function receiverName(receiver) {
  const target = ts.skipOuterExpressions(receiver);
  if (ts.isIdentifier(target)) return target.text;
  return ts.isPropertyAccessExpression(target) ? target.name.text : undefined;
}

// Only a weak hint: it applies when the array's size is unknown, never over a database read or request payload.
function nameSuggestsSmallConfigList(receiver, checker) {
  return smallConfigListNames.has(receiverName(receiver)) && !isKnownDataSource(receiver, checker);
}

// `const [rows, other] = await Promise.all([repo.find(), ...])`: the member's own promise is the source.
function isAwaitedAllMember(element, isKnown) {
  const pattern = element.parent;
  const declaration = pattern.parent;
  if (!ts.isArrayBindingPattern(pattern) || !ts.isVariableDeclaration(declaration) || !declaration.initializer)
    return false;
  const all = ts.skipOuterExpressions(
    ts.isAwaitExpression(declaration.initializer) ? declaration.initializer.expression : declaration.initializer,
  );
  const promises = ts.isCallExpression(all) && all.arguments[0] && ts.skipOuterExpressions(all.arguments[0]);
  const source =
    promises && ts.isArrayLiteralExpression(promises) && promises.elements[pattern.elements.indexOf(element)];
  return Boolean(source) && isKnown(source);
}

// A database read, request payload array or parsed file is a source whose size follows the data, not the code.
function isKnownDataSource(expression, checker, depth = 0) {
  if (depth >= maxBoundDepth) return false;
  const value = ts.skipOuterExpressions(expression);
  const next = (child) => isKnownDataSource(child, checker, depth + 1);
  if (ts.isAwaitExpression(value)) return next(value.expression);
  if (ts.isIdentifier(value)) {
    const declaration = checker.getSymbolAtLocation(value)?.valueDeclaration;
    if (declaration && ts.isBindingElement(declaration)) return isAwaitedAllMember(declaration, next);
    return (
      Boolean(declaration && ts.isVariableDeclaration(declaration) && declaration.initializer) &&
      next(declaration.initializer)
    );
  }
  if (ts.isNewExpression(value)) return value.arguments?.length > 0 && next(value.arguments[0]);
  if (ts.isPropertyAccessExpression(value) || ts.isElementAccessExpression(value)) {
    for (let node = value; ts.isAccessExpression(node); node = ts.skipOuterExpressions(node.expression)) {
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
  // Unknown size is the weakest reason, so test, seed or polling context found for the same site takes precedence.
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
    `Each iteration rebuilds this ${constructor.text} from the same source, repeating the full copy. Construct it once before the loop and reuse it if the source does not change meanwhile.`,
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

function sameIdentifier(expression, target) {
  return ts.isIdentifier(expression) && expression.text === target.text;
}

// `target.concat(...)` that adds at least one item. Returns the copied receiver.
function growingConcat(result, isTarget) {
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

function growingArrayCopy(result, target) {
  if (ts.isCallExpression(result)) {
    return growingConcat(result, (receiver) => sameIdentifier(receiver, target)) !== undefined;
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
  const copiesArray = growingArrayCopy(result, target);
  if (!copiesArray && !ts.isObjectLiteralExpression(result) && !ts.isCallExpression(result)) return;
  const owner = findRepeatOwner(assignment, checker);
  if (!owner) return;
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

// A computed key that can differ between steps grows the object; fixed keys only overwrite.
function addsDynamicKey(properties, varies, checker) {
  return properties.some(
    (property) =>
      property.name &&
      ts.isComputedPropertyName(property.name) &&
      varies(property.name.expression) &&
      !smallKeyDomain(property.name.expression, checker),
  );
}

// `Object.assign({}, target, { ... })` copies the target into a fresh object just like a spread does.
function objectAssignCopy(result, isTarget, checker) {
  if (!ts.isCallExpression(result) || ts.isOptionalChain(result)) return;
  const [fresh, copied, ...added] = result.arguments.map((argument) => ts.skipOuterExpressions(argument));
  if (!fresh || !ts.isObjectLiteralExpression(fresh) || fresh.properties.length > 0 || !copied || !isTarget(copied))
    return;
  if (added.length === 0 || !added.every(ts.isObjectLiteralExpression) || !isObjectAssign(result, checker)) return;
  return { copied, properties: added.flatMap((literal) => literal.properties) };
}

function isObjectAssign(call, checker) {
  const callee = call.expression;
  return (
    ts.isPropertyAccessExpression(callee) &&
    callee.name.text === 'assign' &&
    ts.isIdentifier(callee.expression) &&
    callee.expression.text === 'Object' &&
    !ts.isOptionalChain(call) &&
    standardInterface(call, checker) === 'ObjectConstructor'
  );
}

function growingObjectCopy(result, target, owner, checker) {
  const isTarget = (expression) => sameIdentifier(ts.skipOuterExpressions(expression), target);
  const varies = (expression) => usesBindingWithin(expression, owner, checker);
  if (ts.isObjectLiteralExpression(result)) {
    const copied = result.properties.some(
      (property) => ts.isSpreadAssignment(property) && isTarget(property.expression),
    );
    return copied && addsDynamicKey(result.properties, varies, checker);
  }
  const assigned = objectAssignCopy(result, isTarget, checker);
  return assigned !== undefined && addsDynamicKey(assigned.properties, varies, checker);
}

// Only bindings declared inside the loop or callback can hold a different key on each step.
function usesBindingWithin(expression, owner, checker) {
  function visit(node) {
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
  return visit(expression);
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

// Only the driver's own conversion is recognised. Other toString implementations can perform arbitrary work.
function objectIdProjection(expression, context) {
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

function syncCallback(expression) {
  if (!expression) return;
  const callback = ts.skipOuterExpressions(expression);
  if (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback)) return;
  if (!(ts.getCombinedModifierFlags(callback) & ts.ModifierFlags.Async) && !callback.asteriskToken) return callback;
}

// The `===` comparison a find() predicate returns, with the predicate's single item parameter.
function findComparison(call) {
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
  return { innerBinding, comparison };
}

// The predicate overload can return a narrower element type. A regular Map loses that public return type.
function narrowsFindResult(call, checker) {
  const predicateType = checker.getResolvedSignature(call)?.declaration?.parameters?.[0]?.type;
  return predicateType?.type?.kind === ts.SyntaxKind.TypePredicate;
}

// `item.key === probe` in a find() predicate: the item side, its key path after the parameter, and the probe.
function findKeySides(call) {
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
  return {
    parameter: found.innerBinding,
    item,
    path: item.getText().slice(parameterName.length),
    probe: sides[1 - itemIndex],
  };
}

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

function typeParts(type) {
  return type.isUnion() ? type.types : [type];
}

// A key type whose text names no declaration, so it can be written anywhere in the file.
function printableKeyType(type) {
  return typeParts(type).every(
    (part) => part.flags & (printableKeyFlags | nullishFlags) && !(part.flags & ts.TypeFlags.EnumLike),
  );
}

// What the site fix needs to index `receiver.find((item) => item.key === probe)` with a typed Map:
// - keyType: the Map key type covering every probe used with this array and key path in the file, or `unknown`;
// - inferKey: the stored key type already accepts every probe, so `new Map(entries)` can infer it;
// - numericKey: a key can be NaN, so NaN keys must be filtered to match strict equality;
// - eager: every element is non-nullish and the key is a plain property, so building the index early cannot throw
//   or run a getter.
// Every find on the same array and key path gets the same facts, so their shared fix is identical.
function findLookupFacts(call, sides, checker) {
  const receiver = call.expression.expression;
  if (!ts.isIdentifier(receiver)) return;
  const symbol = checker.getSymbolAtLocation(receiver);
  const keyType = checker.getTypeAtLocation(sides.item);
  const probeTypes = [];
  let narrows = false;
  (function visit(node) {
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

function emptyFallback(expression) {
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

// `record.options.find(...)` or `const steps = run.state?.flow?.steps ?? []`: a list hanging off one non-list
// local value, not off `this` or a result container.
function isChildListOfOneRecord(receiver, checker) {
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

function findDetails(call, projections, checker) {
  if (narrowsFindResult(call, checker)) return { narrowsFindResult: true };
  const sides = !projections.some(Boolean) && findKeySides(call);
  const findLookup = sides && findLookupFacts(call, sides, checker);
  return findLookup ? { findLookup } : undefined;
}

function checkFind(call, context) {
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
    // The find details describe a row lookup; a findIndex lookup needs a Map to the index, so it is left manual.
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

function hasSmallObjectEnumeration(input, checker) {
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
    declaration &&
    isDefaultLibrary(checker, declaration.getSourceFile()) &&
    standardInterface(input, checker) === 'ObjectConstructor' &&
    !mayChangeBefore(symbol, scope, input.pos, checker) &&
    !writtenBindings(scope, checker).aliases.has(receiver.text)
  );
}

// A reduce over a short unchanged constant list copies a bounded accumulator.
function hasSmallFixedInput(input, checker) {
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
function enumeratedArgument(call, checker) {
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

// Object.keys/values/entries of a value whose declared interface or type literal lists few named properties.
function hasSmallDeclaredShape(input, checker) {
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

// Object.keys/values/entries of an unchanged constant object literal. The constant is written by hand, so it stays short.
function hasSmallConstantObjectEnumeration(input, checker) {
  const argument = enumeratedArgument(input, checker);
  const identifier = argument && ts.skipOuterExpressions(argument);
  if (!identifier || !ts.isIdentifier(identifier)) return false;
  const symbol = checker.getSymbolAtLocation(identifier);
  const declarationSymbol = resolvedSymbol(identifier, checker);
  const binding = declarationSymbol?.valueDeclaration;
  const literal = binding?.initializer && ts.skipOuterExpressions(binding.initializer);
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
  const inSameFile = declaringScope.getSourceFile() === input.getSourceFile();
  return (
    !mayChangeBefore(declarationSymbol, declaringScope, inSameFile ? input.pos : Infinity, checker) &&
    !mayChangeBefore(symbol, input.getSourceFile(), input.pos, checker)
  );
}

// A const-asserted tuple is readonly, so no code can grow it after its short literal.
function hasSmallConstAssertedList(input, checker) {
  if (!ts.isIdentifier(input)) return false;
  const binding = resolvedSymbol(input, checker)?.valueDeclaration;
  const list = binding && ts.isVariableDeclaration(binding) && binding.initializer;
  return (
    !!list &&
    isConstAssertion(list) &&
    ts.isArrayLiteralExpression(ts.skipOuterExpressions(list)) &&
    isLiteralList(ts.skipOuterExpressions(list), constantListLimit)
  );
}

// `createParamDecorator((data, ctx) => data.reduce(...))`: `data` is what the developer wrote at the decorator use site.
function isDecoratorArgument(input, checker) {
  if (!ts.isIdentifier(input)) return false;
  const declaration = checker.getSymbolAtLocation(input)?.valueDeclaration;
  const factory = declaration && ts.isParameter(declaration) && declaration.parent;
  return (
    !!factory &&
    ts.isArrowFunction(factory) &&
    factory.parameters[0] === declaration &&
    ts.isCallExpression(factory.parent) &&
    ts.isIdentifier(factory.parent.expression) &&
    factory.parent.expression.text === 'createParamDecorator'
  );
}

// A reduce at the top level of a module (outside every function and class) runs once at import time.
function runsAtModuleLoad(call) {
  return !ts.findAncestor(call, (node) => ts.isFunctionLike(node) || ts.isClassLike(node));
}

function finiteLiteralDomain(type, limit) {
  const alternatives = type.isUnion() ? type.types : [type];
  return (
    alternatives.length <= limit &&
    alternatives.every(
      (alternative) =>
        alternative.flags & (ts.TypeFlags.StringLiteral | ts.TypeFlags.NumberLiteral | ts.TypeFlags.EnumLiteral),
    )
  );
}

// `Object.entries(data)` where `data: T` and T is a type parameter: the caller supplies a concrete object shape.
function enumeratesGenericObject(input, checker) {
  const argument = enumeratedArgument(input, checker);
  return !!argument && !!(checker.getTypeAtLocation(argument).flags & ts.TypeFlags.TypeParameter);
}

const jsonSchemaMembers = ['type', 'properties', 'required'];

function isEmptyObjectLiteral(expression) {
  const value = ts.skipOuterExpressions(expression);
  return ts.isObjectLiteralExpression(value) && value.properties.length === 0;
}

// `schema.properties`, optionally behind `?? {}` or a `typeof schema === 'object'` guard, where the owner has the
// JSON Schema object members (type, properties, required).
function isSchemaPropertiesRead(expression, checker, depth = 0) {
  const value = ts.skipOuterExpressions(expression);
  if (depth >= maxBoundDepth) return false;
  const nested = (child) => isSchemaPropertiesRead(child, checker, depth + 1);
  if (ts.isIdentifier(value)) {
    const binding = resolvedSymbol(value, checker)?.valueDeclaration;
    return (
      !!binding?.initializer &&
      ts.isVariableDeclaration(binding) &&
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

function enumeratesSchemaProperties(input, checker) {
  const argument = enumeratedArgument(input, checker);
  return !!argument && isSchemaPropertiesRead(argument, checker);
}

// `workers.reduce((acc, worker) => …)` where each worker is an enum member or a literal from a union.
function reducesFiniteValues(call, checker) {
  const item = syncCallback(call.arguments[0])?.parameters[1]?.name;
  return !!item && ts.isIdentifier(item) && finiteLiteralDomain(checker.getTypeAtLocation(item), finiteDomainLimit);
}

// `{ ...acc, [part.type]: value }` where every computed key has a finite literal type.
function hasFiniteAccumulatorKeys(spread, checker) {
  const literal = spread.parent;
  if (!ts.isObjectLiteralExpression(literal)) return false;
  const keys = literal.properties.filter((property) => property.name && ts.isComputedPropertyName(property.name));
  return (
    keys.length > 0 &&
    keys.every((property) =>
      finiteLiteralDomain(checker.getTypeAtLocation(property.name.expression), finiteDomainLimit),
    )
  );
}

// `reduce((acc, …) => ({ ...acc, … }), {} as Record<ChannelEnum, Setting>)`: the accumulator type names every key it can hold.
function hasClosedAccumulatorType(spread, callback, checker) {
  // Only object copies (spread or Object.assign); array and Set accumulators are not bounded by their own type.
  if (!ts.isSpreadAssignment(spread) && !ts.isCallExpression(spread.parent)) return false;
  const type = checker.getTypeAtLocation(callback.parameters[0]);
  if (!(type.flags & ts.TypeFlags.Object)) return false;
  // A pure index signature such as Record<string, T> has no named properties; a mixed one declares its signature.
  const declaresIndex = type
    .getSymbol?.()
    ?.declarations?.some((declaration) => declaration.members?.some(ts.isIndexSignatureDeclaration));
  if (declaresIndex) return false;
  const keyCount = type.getProperties().length;
  return keyCount > 0 && keyCount <= finiteDomainLimit;
}

const uiReduceReason =
  'Runs in a JSX component module over UI state rather than on a server request path. Review in a front-end context if the list can grow large.';

function boundedReduceReason(call, input, checker) {
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

function checkReducer(call, context) {
  const callback = syncCallback(call.arguments[0]);
  if (!callback) return;
  const accumulator = callback.parameters[0]?.name;
  if (!accumulator || !ts.isIdentifier(accumulator)) return;
  const { checker } = context;

  function isAccumulator(expression) {
    const copied = ts.skipOuterExpressions(expression);
    return (
      sameIdentifier(copied, accumulator) &&
      checker.getSymbolAtLocation(copied)?.valueDeclaration === callback.parameters[0]
    );
  }
  const varies = (expression) => usesIterationParameter(expression, callback.parameters.slice(1, 3), checker);

  function growingCopy(expression) {
    const result = ts.skipOuterExpressions(expression);
    if (ts.isConditionalExpression(result)) return growingCopy(result.whenTrue) || growingCopy(result.whenFalse);
    if (ts.isCallExpression(result)) {
      const assigned = objectAssignCopy(result, isAccumulator, checker);
      if (assigned) return addsDynamicKey(assigned.properties, varies, checker) ? assigned.copied : undefined;
      return isStandardArrayCall(result, checker) ? growingConcat(result, isAccumulator) : undefined;
    }
    const array = ts.isArrayLiteralExpression(result);
    if (!array && !ts.isObjectLiteralExpression(result)) return;
    const entries = array ? result.elements : result.properties;
    const spread = entries.find(
      (entry) => (ts.isSpreadElement(entry) || ts.isSpreadAssignment(entry)) && isAccumulator(entry.expression),
    );
    if (!spread) return;
    if (array) return addsAnotherItem(entries, spread) ? spread : undefined;
    return addsDynamicKey(entries, varies, checker) ? spread : undefined;
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

function checkCollectionCall(call, context) {
  if (!ts.isPropertyAccessExpression(call.expression) || ts.isOptionalChain(call)) return;
  switch (call.expression.name.text) {
    case 'filter':
      return checkFilterExistence(call, context, syncCallback(call.arguments[0]));
    case 'has':
    case 'get':
      return checkRebuiltLookup(call, context);
    case 'find':
    case 'findIndex':
      return checkFind(call, context);
    case 'includes':
      return checkMembership(call, context);
    case 'reduce':
      return checkReducer(call, context);
  }
}

module.exports = { checkCollectionCall, checkCollectionAssignment };
