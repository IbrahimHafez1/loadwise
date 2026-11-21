'use strict';

// Site fixes for collection rules. Each builder returns undefined unless the rewrite provably keeps behavior.
const {
  ts,
  textOf,
  ancestor,
  calleeCall,
  enclosingStatement,
  enclosingIteration,
  indentationAt,
  insertLinesBefore,
  freshName,
} = require('./helpers.cjs');
const { startsOwnLine } = require('./hoisting.cjs');

const typeScriptFile = /\.[cm]?tsx?$/;
const readOnlyArrayMembers = new Set(['length', 'includes', 'indexOf', 'at', 'join']);
// Array members that never change the array they are called on.
const nonMutatingMembers = new Set([
  ...readOnlyArrayMembers,
  'lastIndexOf',
  'map',
  'filter',
  'some',
  'every',
  'find',
  'findIndex',
  'findLast',
  'findLastIndex',
  'forEach',
  'reduce',
  'reduceRight',
  'slice',
  'concat',
  'flat',
  'flatMap',
  'entries',
  'keys',
  'values',
  'toSorted',
  'toReversed',
  'toSpliced',
  'with',
]);
const arrayCopyIndent = '  ';

function skipParentheses(node) {
  let current = node;
  while (ts.isParenthesizedExpression(current)) current = current.expression;
  return current;
}

function outerParenthesized(node) {
  let current = node;
  while (ts.isParenthesizedExpression(current.parent)) current = current.parent;
  return current;
}

function nearestFunctionOrFile(node) {
  return ancestor(node.parent, (current) => ts.isFunctionLike(current) || ts.isSourceFile(current));
}

function bindingNames(name, names = []) {
  if (ts.isIdentifier(name)) names.push(name.text);
  else for (const element of name.elements) if (!ts.isOmittedExpression(element)) bindingNames(element.name, names);
  return names;
}

function bindsName(identifier) {
  const { parent } = identifier;
  return (
    ((ts.isVariableDeclaration(parent) ||
      ts.isParameter(parent) ||
      ts.isBindingElement(parent) ||
      ts.isFunctionLike(parent) ||
      ts.isClassLike(parent) ||
      ts.isImportSpecifier(parent)) &&
      parent.name === identifier) ||
    ts.isNamespaceImport(parent) ||
    ts.isImportClause(parent)
  );
}

function declaresNameWithin(node, name) {
  let declared = false;
  (function visit(current) {
    if (declared) return;
    if (ts.isIdentifier(current) && current.text === name && bindsName(current)) declared = true;
    else ts.forEachChild(current, visit);
  })(node);
  return declared;
}

function importedNames(statement) {
  const clause = statement.importClause;
  if (!clause) return [];
  const names = [];
  if (clause.name) names.push(clause.name.text);
  const bindings = clause.namedBindings;
  if (bindings && ts.isNamespaceImport(bindings)) names.push(bindings.name.text);
  else if (bindings) for (const specifier of bindings.elements) names.push(specifier.name.text);
  return names;
}

// Whether `name` resolves, at `statement`, to a binding that is safe to read earlier: a parameter, import,
// function, or `const` declared before the statement. Anything else (let, var, class, loop variables) is refused.
// Undefined lets the caller continue looking in the enclosing scope.
function bindingInStatements(statements, name, child) {
  for (const candidate of statements) {
    if (ts.isVariableStatement(candidate)) {
      const declares = candidate.declarationList.declarations.some((declaration) =>
        bindingNames(declaration.name).includes(name),
      );
      if (!declares) continue;
      return Boolean(candidate.declarationList.flags & ts.NodeFlags.Const) && candidate.end <= child.getStart();
    }
    if (ts.isFunctionDeclaration(candidate) && candidate.name?.text === name) return true;
    if (ts.isClassDeclaration(candidate) && candidate.name?.text === name) return false;
    if (ts.isImportDeclaration(candidate) && importedNames(candidate).includes(name)) return true;
  }
}

function boundBefore(statement, name) {
  let child = statement;
  for (let scope = statement.parent; scope; child = scope, scope = scope.parent) {
    if (ts.isBlock(scope) || ts.isSourceFile(scope) || ts.isModuleBlock(scope)) {
      const available = bindingInStatements(scope.statements, name, child);
      if (available !== undefined) return available;
    } else if (ts.isFunctionLike(scope)) {
      if (scope.parameters.some((parameter) => bindingNames(parameter.name).includes(name))) return true;
    } else if (
      (ts.isForStatement(scope) || ts.isForOfStatement(scope) || ts.isForInStatement(scope)) &&
      scope.initializer &&
      ts.isVariableDeclarationList(scope.initializer) &&
      scope.initializer.declarations.some((declaration) => bindingNames(declaration.name).includes(name))
    ) {
      return false;
    } else if (ts.isCatchClause(scope) && scope.variableDeclaration) {
      if (bindingNames(scope.variableDeclaration.name).includes(name)) return false;
    }
  }
  return false;
}

// A callback of map/filter/some/... runs synchronously inside the statement that iterates.
function isIterationCallback(fn) {
  return Boolean(fn.body) && enclosingIteration(fn.body)?.callback === fn;
}

function statementPlacement(statement, name) {
  if (!startsOwnLine(statement) || declaresNameWithin(statement, name) || !boundBefore(statement, name)) return;
  return { region: statement, edits: (...lines) => [insertLinesBefore(statement, lines)] };
}

// An expression-bodied arrow function gets a block body that builds the lookup first and returns the expression.
function arrowPlacement(arrow, name) {
  const { body } = arrow;
  const sourceFile = arrow.getSourceFile();
  const text = sourceFile.text;
  if (declaresNameWithin(body, name)) return;
  if (!arrow.parameters.some((parameter) => bindingNames(parameter.name).includes(name))) {
    const statement = enclosingStatement(arrow);
    if (!statement || declaresNameWithin(statement, name) || !boundBefore(statement, name)) return;
  }
  const arrowToken = arrow.equalsGreaterThanToken;
  const bodyStart = body.getStart(sourceFile);
  const gap = text.slice(arrowToken.end, bodyStart);
  if (gap.trim()) return;
  // A multi-line body that starts after `=>` would sit under-indented behind `return`.
  const bodyOnOwnLine = gap.includes('\n');
  if (!bodyOnOwnLine && text.slice(bodyStart, body.end).includes('\n')) return;
  const outer = indentationAt(text, arrowToken.getStart(sourceFile));
  const inner = bodyOnOwnLine ? indentationAt(text, bodyStart) : outer + arrayCopyIndent;
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  return {
    region: body,
    edits: (...lines) => [
      {
        start: arrowToken.end,
        end: bodyStart,
        text: ` {${eol}${inner}${lines.join(eol + inner)}${eol}${inner}return `,
      },
      { start: body.end, end: body.end, text: `;${eol}${outer}}` },
    ],
  };
}

// Where a lookup of `name` can be built once for the iteration holding `node`: before the statement running the
// iteration, crossing only synchronous iteration callbacks, or at the top of an expression-bodied arrow function.
// Returns { region, edits(line) } where `region` is the code that now runs after the lookup is built.
function hoistPlacement(node, name) {
  const iteration = enclosingIteration(node);
  if (!iteration) return;
  if (
    (ts.isForOfStatement(iteration.node) || ts.isForInStatement(iteration.node)) &&
    !ancestor(node, (current) => current === iteration.node.statement)
  )
    return;
  for (let current = iteration.node; current; current = current.parent) {
    if (ts.isClassLike(current)) return;
    if (ts.isStatement(current) && (ts.isBlock(current.parent) || ts.isSourceFile(current.parent)))
      return statementPlacement(current, name);
    if (ts.isFunctionLike(current) && !isIterationCallback(current))
      return ts.isArrowFunction(current) && !ts.isBlock(current.body) ? arrowPlacement(current, name) : undefined;
  }
}

// The identifier at the root of `a` or `a.b.c` without optional chaining, calls or element access.
function plainChainRoot(node) {
  if (ts.isIdentifier(node)) return node;
  if (ts.isPropertyAccessExpression(node) && !node.questionDotToken) return plainChainRoot(node.expression);
}

function isAssignmentTarget(node) {
  const { parent } = node;
  if (ts.isBinaryExpression(parent) && parent.left === node) {
    const operator = parent.operatorToken.kind;
    return operator >= ts.SyntaxKind.FirstAssignment && operator <= ts.SyntaxKind.LastAssignment;
  }
  return (ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)) && parent.operand === node;
}

// Whether every use of `rootName` in `region` reads exactly `chainText` (such as `actor.permissions`), so reading
// that chain earlier cannot skip a guard like `existing && ...` written in the region.
function onlyReadThroughChain(region, rootName, chainText) {
  let safe = true;
  (function visit(current) {
    if (!safe) return;
    const { parent } = current;
    const isName = ts.isPropertyAccessExpression(parent) && parent.name === current;
    if (ts.isIdentifier(current) && current.text === rootName && !isName) {
      let chain = current;
      while (textOf(chain) !== chainText && ts.isPropertyAccessExpression(chain.parent)) chain = chain.parent;
      if (textOf(chain) !== chainText || isAssignmentTarget(chain)) safe = false;
    } else ts.forEachChild(current, visit);
  })(region);
  return safe;
}

// A bare read of the chain root that only tests it, such as `existing && ...`, `!existing` or `if (existing)`.
function isTruthinessTest(identifier) {
  const node = outerParenthesized(identifier);
  const { parent } = node;
  if (ts.isBinaryExpression(parent)) {
    const operator = parent.operatorToken.kind;
    const isLogical = operator === ts.SyntaxKind.AmpersandAmpersandToken || operator === ts.SyntaxKind.BarBarToken;
    return parent.left === node && isLogical;
  }
  if (ts.isPrefixUnaryExpression(parent)) return parent.operator === ts.SyntaxKind.ExclamationToken;
  if (ts.isConditionalExpression(parent)) return parent.condition === node;
  return (ts.isIfStatement(parent) || ts.isWhileStatement(parent)) && parent.expression === node;
}

// Whether every use of `rootName` in `region` reads `chainText` or only tests the root, as in
// `existing && existing.items.includes(x)`. The lookup then reads the chain with `?.` so a missing root is no error.
function onlyGuardedChainReads(region, rootName, chainText) {
  let safe = true;
  (function visit(current) {
    if (!safe) return;
    const { parent } = current;
    const isName = ts.isPropertyAccessExpression(parent) && parent.name === current;
    if (ts.isIdentifier(current) && current.text === rootName && !isName) {
      if (isTruthinessTest(current)) return;
      let chain = current;
      while (textOf(chain) !== chainText && ts.isPropertyAccessExpression(chain.parent)) chain = chain.parent;
      if (textOf(chain) !== chainText || isAssignmentTarget(chain)) safe = false;
    } else ts.forEachChild(current, visit);
  })(region);
  return safe;
}

// Whether every use of `rootName` in `region` reads `chainText` through a non-mutating array member such as
// `.includes()` or `.filter()`, or spreads it into a new array, so the array cannot change between the lookups.
function onlyReadOnlyMembers(region, rootName, chainText) {
  let safe = true;
  (function visit(current) {
    if (!safe) return;
    const { parent } = current;
    const isName = ts.isPropertyAccessExpression(parent) && parent.name === current;
    if (ts.isIdentifier(current) && current.text === rootName && !isName) {
      let chain = current;
      while (textOf(chain) !== chainText && ts.isPropertyAccessExpression(chain.parent)) chain = chain.parent;
      const member = chain.parent;
      const readsMember =
        ts.isPropertyAccessExpression(member) &&
        member.expression === chain &&
        nonMutatingMembers.has(member.name.text);
      const spreadsCopy = ts.isSpreadElement(member) && ts.isArrayLiteralExpression(member.parent);
      if (textOf(chain) !== chainText || !(readsMember || spreadsCopy)) safe = false;
    } else ts.forEachChild(current, visit);
  })(region);
  return safe;
}

function membershipCall(node) {
  if (!ts.isCallExpression(node) || ts.isOptionalChain(node) || !ts.isPropertyAccessExpression(node.expression)) return;
  const { expression: receiver, name } = node.expression;
  if (name.text !== 'includes' || node.arguments.length !== 1) return;
  const root = plainChainRoot(receiver);
  return root && { call: node, receiver, root, name };
}

// Every `source.includes(x)` whose lookup would go before a statement of `block`, as { call, statement }. One
// lookup then serves them all, and every finding among them gets the same fix, so applying one applies all.
function sameBlockMemberships(block, source, rootName) {
  const found = [];
  (function visit(current) {
    const membership = membershipCall(current);
    if (membership && textOf(membership.receiver) === source) {
      const statement = hoistPlacement(membership.call, rootName)?.region;
      if (statement?.parent === block) found.push({ call: membership.call, statement });
    }
    ts.forEachChild(current, visit);
  })(block);
  return found;
}

// Declare the cache outside the iteration, but build it only when the original lookup would execute.
function lazyLookup(sourceFile, name, initializer) {
  const factory = freshName(sourceFile, 'build' + capitalize(name));
  if (!factory) return;
  let returnType = 'ReturnType';
  if (mentionsName(sourceFile, returnType)) {
    if (mentionsName(sourceFile, 'globalThis')) return;
    returnType = 'globalThis.ReturnType';
  }
  const type = `${returnType}<typeof ${factory}>`;
  const declaration = typeScriptFile.test(sourceFile.fileName)
    ? `let ${name}: ${type};`
    : `/** @type {${type}} */ let ${name};`;
  return {
    declarations: [`const ${factory} = () => ${initializer};`, declaration],
    access: `(${name} ??= ${factory}())`,
  };
}

function membershipFix({ node, sourceFile }) {
  const flagged = calleeCall(node);
  const membership = flagged && membershipCall(flagged);
  if (!membership || declaresNameWithin(sourceFile, 'Set')) return;
  const { call, receiver, root } = membership;
  const chained = receiver !== root;
  const setName = freshName(sourceFile, `${chained ? receiver.name.text : root.text}Set`);
  let placement = setName && hoistPlacement(call, root.text);
  if (!placement) return;
  const source = textOf(receiver);
  let calls = [call];
  const block = placement.region.parent;
  if (ts.isStatement(placement.region) && (ts.isBlock(block) || ts.isSourceFile(block))) {
    const group = sameBlockMemberships(block, source, root.text);
    if (group.length > 1) {
      const statements = block.statements;
      const first = statements.indexOf(group[0].statement);
      const last = statements.indexOf(group.at(-1).statement);
      const covered = statements.slice(first, last + 1);
      if (!covered.every((statement) => onlyReadOnlyMembers(statement, root.text, source))) return;
      placement = statementPlacement(group[0].statement, root.text);
      if (!placement) return;
      calls = group.map((entry) => entry.call);
    }
  }
  let built = source;
  if (chained && !onlyReadThroughChain(placement.region, root.text, source)) {
    const rest = source.slice(root.text.length);
    if (calls.length > 1 || !/^\.[\w$.]+$/.test(rest)) return;
    if (!onlyGuardedChainReads(placement.region, root.text, source)) return;
    built = `${root.text}?${rest}`;
  }
  const lookup = lazyLookup(sourceFile, setName, `new Set(${built})`);
  if (!lookup) return;
  return {
    edits: [
      ...placement.edits(...lookup.declarations),
      ...calls.map((each) => ({
        start: each.expression.expression.getStart(),
        end: each.expression.name.end,
        text: `${lookup.access}.has`,
      })),
    ],
    note: `The Set is built on the first membership check. This assumes \`${source}\` stays unchanged between checks.`,
  };
}

function lookupKeyShape(call) {
  if (call.arguments.length !== 1 || ts.isOptionalChain(call)) return;
  const callback = skipParentheses(call.arguments[0]);
  if (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback)) return;
  if (callback.asteriskToken || callback.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword))
    return;
  const [parameter] = callback.parameters;
  if (callback.parameters.length !== 1 || !ts.isIdentifier(parameter.name) || parameter.initializer) return;
  if (parameter.dotDotDotToken) return;
  let body = callback.body;
  if (ts.isBlock(body)) {
    if (body.statements.length !== 1 || !ts.isReturnStatement(body.statements[0])) return;
    body = body.statements[0].expression;
    if (!body) return;
  }
  const comparison = skipParentheses(body);
  if (!ts.isBinaryExpression(comparison) || comparison.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken)
    return;
  const parameterName = parameter.name.text;
  const sides = [skipParentheses(comparison.left), skipParentheses(comparison.right)];
  const propertySides = sides.filter((side) => propertyOfParameter(side, parameterName));
  if (propertySides.length !== 1) return;
  const [property] = propertySides;
  const key = sides.find((side) => side !== property);
  if (!pureKey(key) || mentionsName(key, parameterName)) return;
  return { parameterName, property, key };
}

function propertyOfParameter(node, parameterName) {
  if (!ts.isPropertyAccessExpression(node) || node.questionDotToken) return false;
  const root = node.expression;
  if (ts.isIdentifier(root)) return root.text === parameterName;
  return propertyOfParameter(root, parameterName);
}

function pureKey(node) {
  const value = skipParentheses(node);
  if (ts.isIdentifier(value) || value.kind === ts.SyntaxKind.ThisKeyword) return true;
  if (ts.isStringLiteralLike(value) || ts.isNumericLiteral(value)) return true;
  if (ts.isPropertyAccessExpression(value) || ts.isNonNullExpression(value)) return pureKey(value.expression);
  if (ts.isElementAccessExpression(value)) return pureKey(value.expression) && pureKey(value.argumentExpression);
  return false;
}

function mentionsName(node, name) {
  let found = false;
  (function visit(current) {
    if (found) return;
    if (ts.isIdentifier(current) && current.text === name) found = true;
    else ts.forEachChild(current, visit);
  })(node);
  return found;
}

function capitalize(text) {
  return text[0].toUpperCase() + text.slice(1);
}

function findFix({ node, sourceFile, finding }) {
  if (finding.narrowsFindResult) return;
  const call = calleeCall(node);
  if (!call || !ts.isPropertyAccessExpression(call.expression) || call.expression.name.text !== 'find') return;
  const receiver = call.expression.expression;
  if (!ts.isIdentifier(receiver)) return;
  const shape = lookupKeyShape(call);
  if (!shape || declaresNameWithin(sourceFile, 'Number') || declaresNameWithin(sourceFile, 'Map')) return;
  const mapName = freshName(sourceFile, `${receiver.text}By${capitalize(shape.property.name.text)}`);
  const placement = mapName && hoistPlacement(call, receiver.text);
  if (!placement) return;
  const { parameterName, property, key } = shape;
  const pair = `[${textOf(property)}, ${parameterName}]`;
  const typed = typeScriptFile.test(sourceFile.fileName);
  const entry = typed ? `${pair} as const` : `/** @type {const} */ (${pair})`;
  // Map matches NaN to itself and keeps the last duplicate. Strict equality in find() does neither.
  const entries = `${receiver.text}.map((${parameterName}) => ${entry}).filter(([key]) => !Number.isNaN(key)).reverse()`;
  // A strict-equality probe can have a wider type than the stored key. Any probe is valid for reading the map.
  const mapType = `Map<unknown, (typeof ${receiver.text})[number]>`;
  const initializer = typed ? `new ${mapType}(${entries})` : `/** @type {${mapType}} */ (new Map(${entries}))`;
  const lookup = lazyLookup(sourceFile, mapName, initializer);
  if (!lookup) return;
  return {
    edits: [
      ...placement.edits(...lookup.declarations),
      { start: call.getStart(), end: call.end, text: `${lookup.access}.get(${textOf(key)})` },
    ],
    note: 'The Map is built on the first lookup. NaN keys are skipped and the first duplicate wins, as with a strict-equality find(). This assumes stable, side-effect-free keys, an unchanged array and non-null elements.',
  };
}

function existenceRewrite(length) {
  const parent = length.parent;
  if (ts.isBinaryExpression(parent)) {
    const lengthOnLeft = parent.left === length;
    const other = lengthOnLeft ? parent.right : parent.left;
    if (!ts.isNumericLiteral(other) || Number(other.text) !== 0) return;
    const { kind } = parent.operatorToken;
    const positive = {
      [ts.SyntaxKind.ExclamationEqualsEqualsToken]: true,
      [ts.SyntaxKind.ExclamationEqualsToken]: true,
      [ts.SyntaxKind.EqualsEqualsEqualsToken]: false,
      [ts.SyntaxKind.EqualsEqualsToken]: false,
      [ts.SyntaxKind.GreaterThanToken]: lengthOnLeft ? true : undefined,
      [ts.SyntaxKind.LessThanToken]: lengthOnLeft ? undefined : true,
      [ts.SyntaxKind.LessThanEqualsToken]: lengthOnLeft ? false : undefined,
      [ts.SyntaxKind.GreaterThanEqualsToken]: lengthOnLeft ? undefined : false,
    }[kind];
    if (positive === undefined) return;
    return { replaced: parent, negate: !positive };
  }
  let expression = length;
  let consumer = expression.parent;
  while (
    ts.isBinaryExpression(consumer) &&
    (consumer.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
      consumer.operatorToken.kind === ts.SyntaxKind.BarBarToken)
  ) {
    expression = consumer;
    consumer = expression.parent;
  }
  const inCondition =
    ((ts.isIfStatement(consumer) || ts.isWhileStatement(consumer) || ts.isDoStatement(consumer)) &&
      consumer.expression === expression) ||
    ((ts.isConditionalExpression(consumer) || ts.isForStatement(consumer)) && consumer.condition === expression) ||
    (ts.isPrefixUnaryExpression(consumer) && consumer.operator === ts.SyntaxKind.ExclamationToken);
  return inCondition ? { replaced: length, negate: false } : undefined;
}

function filterExistenceFix({ node }) {
  const call = calleeCall(node);
  if (!call || !ts.isPropertyAccessExpression(call.expression) || call.expression.name.text !== 'filter') return;
  if (call.arguments.length !== 1 || ts.isOptionalChain(call)) return;
  const length = call.parent;
  if (!ts.isPropertyAccessExpression(length) || length.expression !== call || length.name.text !== 'length') return;
  if (length.questionDotToken) return;
  const rewrite = existenceRewrite(length);
  if (!rewrite) return;
  const { replaced, negate } = rewrite;
  const edits = [{ start: call.expression.name.getStart(), end: call.expression.name.end, text: 'some' }];
  if (replaced === length) edits.push({ start: call.end, end: length.end, text: '' });
  else {
    edits.push({ start: replaced.getStart(), end: length.getStart(), text: negate ? '!' : '' });
    edits.push({ start: call.end, end: replaced.end, text: '' });
  }
  return {
    edits,
    note: 'some() stops at the first match, so the predicate must not rely on running for every element.',
  };
}

function comparatorDirection(compare) {
  const callback = skipParentheses(compare);
  if (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback)) return;
  if (callback.parameters.length !== 2) return;
  const [first, second] = callback.parameters;
  if (!ts.isIdentifier(first.name) || !ts.isIdentifier(second.name)) return;
  let body = callback.body;
  if (ts.isBlock(body)) {
    if (body.statements.length !== 1 || !ts.isReturnStatement(body.statements[0])) return;
    body = body.statements[0].expression;
    if (!body) return;
  }
  const result = skipParentheses(body);
  if (!ts.isBinaryExpression(result) || result.operatorToken.kind !== ts.SyntaxKind.MinusToken) return;
  const left = skipParentheses(result.left);
  const right = skipParentheses(result.right);
  if (!ts.isIdentifier(left) || !ts.isIdentifier(right) || left.text === right.text) return;
  if (left.text === first.name.text && right.text === second.name.text) return { ascending: true };
  if (left.text === second.name.text && right.text === first.name.text) return { ascending: false };
}

function sortedArraySource(method, receiver) {
  if (method === 'toSorted') return receiver;
  if (ts.isArrayLiteralExpression(receiver) && receiver.elements.length === 1) {
    const [only] = receiver.elements;
    return ts.isSpreadElement(only) ? skipParentheses(only.expression) : undefined;
  }
  if (
    ts.isCallExpression(receiver) &&
    receiver.arguments.length === 1 &&
    ts.isPropertyAccessExpression(receiver.expression) &&
    receiver.expression.name.text === 'from' &&
    ts.isIdentifier(receiver.expression.expression) &&
    receiver.expression.expression.text === 'Array'
  )
    return skipParentheses(receiver.arguments[0]);
}

// The element access or `.at()` call that reads one end of the sorted copy.
function readEnd(sortCall) {
  const sorted = outerParenthesized(sortCall);
  const access = sorted.parent;
  if (ts.isElementAccessExpression(access) && access.expression === sorted && !access.questionDotToken) {
    const index = skipParentheses(access.argumentExpression);
    return ts.isNumericLiteral(index) && Number(index.text) === 0 ? { value: access, last: false } : undefined;
  }
  if (!ts.isPropertyAccessExpression(access) || access.expression !== sorted || access.name.text !== 'at') return;
  const lookup = access.parent;
  if (!ts.isCallExpression(lookup) || lookup.expression !== access || lookup.arguments.length !== 1) return;
  const index = skipParentheses(lookup.arguments[0]);
  if (ts.isNumericLiteral(index) && Number(index.text) === 0) return { value: lookup, last: false };
  if (
    ts.isPrefixUnaryExpression(index) &&
    index.operator === ts.SyntaxKind.MinusToken &&
    ts.isNumericLiteral(index.operand) &&
    Number(index.operand.text) === 1
  )
    return { value: lookup, last: true };
}

function sortExtremeFix({ node }) {
  const call = calleeCall(node);
  if (!call || !ts.isPropertyAccessExpression(call.expression) || call.arguments.length !== 1) return;
  const method = call.expression.name.text;
  if (method !== 'sort' && method !== 'toSorted') return;
  const source = sortedArraySource(method, skipParentheses(call.expression.expression));
  if (!source || !ts.isIdentifier(source)) return;
  const order = comparatorDirection(call.arguments[0]);
  const end = readEnd(call);
  if (!order || !end) return;
  const wantsMinimum = order.ascending !== end.last;
  // A tie keeps the element the stable sort would have put at that end: the first one for index 0, the last for -1.
  const comparison = (wantsMinimum ? '<' : '>') + (end.last ? '=' : '');
  const best = wantsMinimum ? 'min' : 'max';
  const array = source.text;
  return {
    edits: [
      {
        start: end.value.getStart(),
        end: end.value.end,
        text: `${array}.reduce((${best}, value) => (value ${comparison} ${best} ? value : ${best}), ${array}[0])`,
      },
    ],
    note: 'One pass, no copy and no spread limit; an empty array still gives undefined. Like the sort, this assumes plain numbers without NaN or holes.',
  };
}

function copiedAccumulatorStatements(literal, accumulator) {
  if (ts.isArrayLiteralExpression(literal)) {
    const [, ...added] = literal.elements;
    if (added.length === 0 || added.some((element) => ts.isSpreadElement(element) || ts.isOmittedExpression(element)))
      return;
    return [`${accumulator}.push(${added.map(textOf).join(', ')});`];
  }
  const [, ...added] = literal.properties;
  if (added.length === 0) return;
  const statements = [];
  for (const property of added) {
    const target = propertyTarget(property, accumulator);
    if (!target) return;
    statements.push(target);
  }
  return statements;
}

function propertyTarget(property, accumulator) {
  if (ts.isShorthandPropertyAssignment(property)) {
    if (property.name.text === '__proto__' || property.objectAssignmentInitializer) return;
    return `${accumulator}.${property.name.text} = ${property.name.text};`;
  }
  if (!ts.isPropertyAssignment(property)) return;
  const { name } = property;
  const value = textOf(property.initializer);
  if (ts.isComputedPropertyName(name)) return `${accumulator}[${textOf(name.expression)}] = ${value};`;
  if (ts.isIdentifier(name) && name.text !== '__proto__') return `${accumulator}.${name.text} = ${value};`;
  if (ts.isStringLiteralLike(name) && name.text !== '__proto__') return `${accumulator}[${textOf(name)}] = ${value};`;
}

function reduceCopyFix({ node }) {
  const spread = ancestor(node, (current) => ts.isSpreadElement(current) || ts.isSpreadAssignment(current));
  const literal = spread?.parent;
  if (!literal || (!ts.isArrayLiteralExpression(literal) && !ts.isObjectLiteralExpression(literal))) return;
  const entries = ts.isArrayLiteralExpression(literal) ? literal.elements : literal.properties;
  if (entries[0] !== spread) return;
  const copiedSource = skipParentheses(spread.expression);
  if (!ts.isIdentifier(copiedSource)) return;
  const callback = ancestor(literal, ts.isFunctionLike);
  const reduce = callback?.parent;
  if (
    !reduce ||
    !ts.isCallExpression(reduce) ||
    reduce.arguments[0] !== callback ||
    reduce.arguments.length !== 2 ||
    !ts.isPropertyAccessExpression(reduce.expression) ||
    reduce.expression.name.text !== 'reduce' ||
    ts.isOptionalChain(reduce)
  )
    return;
  if (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback)) return;
  const [accumulator] = callback.parameters;
  if (!accumulator || !ts.isIdentifier(accumulator.name) || accumulator.initializer || accumulator.dotDotDotToken)
    return;
  const accumulatorName = accumulator.name.text;
  if (copiedSource.text !== accumulatorName || countNames(callback.body, accumulatorName) !== 1) return;
  const initial = skipOuterExpressionsOf(reduce.arguments[1]);
  const wantsArray = ts.isArrayLiteralExpression(literal);
  if (wantsArray ? !ts.isArrayLiteralExpression(initial) : !ts.isObjectLiteralExpression(initial)) return;
  const statements = copiedAccumulatorStatements(literal, accumulatorName);
  if (!statements) return;
  const returned = outerParenthesized(literal);
  const text = callback.getSourceFile().text;
  if (ts.isBlock(callback.body)) {
    const statement = returned.parent;
    if (!ts.isReturnStatement(statement) || statement.parent !== callback.body) return;
    const indentation = indentationAt(text, statement.getStart());
    const lines = [...statements, `return ${accumulatorName};`];
    return {
      edits: [
        {
          start: statement.getStart(),
          end: statement.end,
          text: lines.join(`\n${indentation}`),
        },
      ],
      note: accumulatorNote(wantsArray),
    };
  }
  if (returned !== callback.body) return;
  const indentation = indentationAt(text, callback.body.getStart());
  const inner = indentation + arrayCopyIndent;
  const lines = [...statements, `return ${accumulatorName};`].map((line) => inner + line);
  return {
    edits: [
      {
        start: callback.body.getStart(),
        end: callback.body.end,
        text: `{\n${lines.join('\n')}\n${indentation}}`,
      },
    ],
    note: accumulatorNote(wantsArray),
  };
}

function accumulatorNote(wantsArray) {
  return wantsArray
    ? 'The accumulator is now one fresh array that is changed in place; the initial [] is created per reduce call.'
    : 'The accumulator is now one fresh object that is changed in place. A computed key of "__proto__" would set the prototype instead of an own property.';
}

function skipOuterExpressionsOf(node) {
  let current = node;
  while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isSatisfiesExpression(current))
    current = current.expression;
  return current;
}

function countNames(node, name) {
  let count = 0;
  (function visit(current) {
    if (ts.isIdentifier(current) && current.text === name) count++;
    ts.forEachChild(current, visit);
  })(node);
  return count;
}

function accumulatorDeclaration(assignment, name) {
  const scope = nearestFunctionOrFile(assignment);
  let declaration;
  let valid = true;
  (function visit(current) {
    if (ts.isVariableDeclaration(current) && ts.isIdentifier(current.name) && current.name.text === name) {
      if (declaration) valid = false;
      declaration = current;
    }
    if (ts.isParameter(current) && bindingNames(current.name).includes(name)) valid = false;
    ts.forEachChild(current, visit);
  })(scope);
  if (!valid || !declaration || !ts.isVariableDeclarationList(declaration.parent)) return;
  if (nearestFunctionOrFile(declaration) !== scope || declaration.parent.flags & ts.NodeFlags.Const) return;
  const initial = declaration.initializer && skipOuterExpressionsOf(declaration.initializer);
  if (!initial || !ts.isArrayLiteralExpression(initial)) return;
  return { declaration, scope };
}

// Every other use must be a read that cannot keep an earlier version of the array alive.
function onlyLocalReads(scope, name, assignment, literal) {
  let safe = true;
  (function visit(current) {
    if (!safe) return;
    if (ts.isIdentifier(current) && current.text === name && !bindsName(current)) {
      if (nearestFunctionOrFile(current) !== scope) safe = false;
      else if (!allowedAccumulatorUse(current, assignment, literal)) safe = false;
    }
    ts.forEachChild(current, visit);
  })(scope);
  return safe;
}

function allowedAccumulatorUse(identifier, assignment, literal) {
  const { parent } = identifier;
  if (parent === assignment && assignment.left === identifier) return true;
  if (ts.isSpreadElement(parent) && ts.isArrayLiteralExpression(parent.parent)) return parent.parent === literal;
  if (ts.isReturnStatement(parent)) return true;
  if (ts.isPropertyAccessExpression(parent) && parent.expression === identifier) {
    return readOnlyArrayMembers.has(parent.name.text) && !parent.questionDotToken;
  }
  return false;
}

function loopCopyFix({ node }) {
  const assignment = ancestor(node, ts.isBinaryExpression);
  if (!assignment || assignment.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return;
  if (!ts.isIdentifier(assignment.left) || !ts.isExpressionStatement(assignment.parent)) return;
  const literal = skipParentheses(assignment.right);
  if (!ts.isArrayLiteralExpression(literal)) return;
  const [copied, ...added] = literal.elements;
  const name = assignment.left.text;
  if (
    !copied ||
    !ts.isSpreadElement(copied) ||
    !ts.isIdentifier(skipParentheses(copied.expression)) ||
    skipParentheses(copied.expression).text !== name
  )
    return;
  if (added.length === 0 || added.some((element) => ts.isSpreadElement(element) || ts.isOmittedExpression(element)))
    return;
  const found = accumulatorDeclaration(assignment, name);
  if (!found || !onlyLocalReads(found.scope, name, assignment, literal)) return;
  return {
    edits: [
      { start: assignment.getStart(), end: assignment.end, text: `${name}.push(${added.map(textOf).join(', ')})` },
    ],
    note: `${name} is only ever read, returned or extended here, so appending in place keeps the same result without copying it each time.`,
  };
}

function rebuildLookupFix({ node, sourceFile }) {
  const constructed = ancestor(node, ts.isNewExpression);
  if (!constructed || constructed.getStart() !== node.getStart() || !ts.isIdentifier(constructed.expression)) return;
  const kind = constructed.expression.text;
  if (kind !== 'Map' && kind !== 'Set') return;
  if (constructed.arguments?.length !== 1) return;
  const source = skipParentheses(constructed.arguments[0]);
  const use = outerParenthesized(constructed).parent;
  if (!ts.isIdentifier(source) || !ts.isPropertyAccessExpression(use)) return;
  const lookupName = freshName(sourceFile, `${source.text}${kind}`);
  const placement = lookupName && hoistPlacement(constructed, source.text);
  if (!placement) return;
  return {
    edits: [
      ...placement.edits(`const ${lookupName} = new ${kind}(${source.text});`),
      { start: constructed.getStart(), end: constructed.end, text: lookupName },
    ],
    note: `${source.text} must not change while the iteration runs; ${lookupName} is a snapshot taken before it.`,
  };
}

function promiseCombinatorFix({ node }) {
  const call = calleeCall(node);
  if (!call || call.arguments.length !== 1 || !ts.isArrayLiteralExpression(call.arguments[0])) return;
  const edits = [];
  for (const element of call.arguments[0].elements) {
    const awaited = skipParentheses(element);
    if (!ts.isAwaitExpression(awaited)) return;
    edits.push({ start: awaited.getStart(), end: awaited.expression.getStart(), text: '' });
  }
  return {
    edits,
    note: 'The calls now start together. Check that none depends on another finishing first, and that an earlier rejection should not stop later calls from running.',
  };
}

function knownReadsFix({ node }) {
  const awaited = ancestor(node, ts.isAwaitExpression);
  const declaration = awaited?.parent;
  if (!declaration || !ts.isVariableDeclaration(declaration) || !ts.isIdentifier(declaration.name)) return;
  const statement = declaration.parent.parent;
  const block = statement.parent;
  if (!ts.isVariableStatement(statement) || !(ts.isBlock(block) || ts.isSourceFile(block))) return;
  const index = block.statements.indexOf(statement);
  const previous = block.statements[index - 1];
  if (!previous || !ts.isVariableStatement(previous)) return;
  const first = previous.declarationList.declarations[0];
  if (
    previous.modifiers ||
    statement.modifiers ||
    previous.declarationList.declarations.length !== 1 ||
    !(previous.declarationList.flags & ts.NodeFlags.Const) ||
    !(statement.declarationList.flags & ts.NodeFlags.Const) ||
    !ts.isIdentifier(first.name) ||
    first.type ||
    declaration.type ||
    !first.initializer ||
    !ts.isAwaitExpression(first.initializer)
  )
    return;
  const sourceText = statement.getSourceFile().text;
  if (sourceText.slice(previous.end, statement.getStart()).trim()) return;
  if (mentionsName(awaited.expression, first.name.text)) return;
  const names = `${first.name.text}, ${declaration.name.text}`;
  const calls = `${textOf(first.initializer.expression)}, ${textOf(awaited.expression)}`;
  return {
    edits: [
      {
        start: previous.getStart(),
        end: statement.end,
        text: `const [${names}] = await Promise.all([${calls}]);`,
      },
    ],
    note: 'Both reads start together; if the first rejects, the second still runs to completion.',
  };
}

module.exports = {
  'array-repeated-membership': membershipFix,
  'array-repeated-find': findFix,
  'filter-for-existence': filterExistenceFix,
  'numeric-sort-for-extreme': sortExtremeFix,
  'reduce-copy-accumulator': reduceCopyFix,
  'loop-copy-accumulator': loopCopyFix,
  'rebuild-lookup-in-loop': rebuildLookupFix,
  'promise-combinator-serial-await': promiseCombinatorFix,
  'known-reads-awaited-serially': knownReadsFix,
};
