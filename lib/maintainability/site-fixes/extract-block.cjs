'use strict';

// Moves one statement into a named function and calls it where the statement stood:
//   processRows(rows, seen);
//   ...
//   function processRows(rows: Row[], seen: Set<string>) { ...statement }
// The function is declared after the top-level statement that holds the code, or, inside a class method, as a
// private method next to it called through `this`. Local variables the statement reads become parameters, in order
// of first use. It is offered only when the statement finishes normally (no return, no break or continue that
// leaves it, no await or yield), takes at most four parameters, and reassigns none of them, except one outer `let`
// that the function returns and the call assigns back: `total = sumRows(rows, total)`. A parameter is a copy taken
// at the call, so it is refused when a closure could see the variable change. In TypeScript every parameter gets
// the type the checker gives the variable at that spot, and the rewritten file must not type-check worse.
const { innermostNodeAt } = require('../../shared/fix-hunks.cjs');
const { originalProgram, typeChecksAsBefore } = require('./isolated-program.cjs');
const {
  ts,
  functionWithBody,
  flaggedFunction,
  lineStart,
  lineEnd,
  indentationAt,
  newlineOf,
  blank,
  nameUsed,
  ownsLines,
  hasMultilineLiteral,
} = require('./helpers.cjs');
const { analyzeFunctions } = require('../functions.cjs');

// Mirrors site-fix: longer hunks are rejected, and edits this close print as one hunk.
const maxHunkLines = 14;
const hunkJoinDistance = 3;
// A shorter statement gains nothing from a name of its own.
const minExtractedLines = 3;
const maxParameters = 4;
const maxSignatureLength = 100;
const typeScriptFile = /\.[cm]?tsx?$/i;
// Types that cannot be written back as they are, or that hide what the code expects.
const unprintableType = /\bany\b|import\(|\.\.\./;
// A parameter typed like this would not give the block what the original site had: an empty object type has no
// members, and unknown (a caught error, or a type behind an unresolved import) cannot be read without the
// narrowing that was left behind. Comparing diagnostics alone misses this when the file already reports the
// same message elsewhere.
const uselessParameterType = /^(\{\s*\}|unknown|never|object|Object)$/;

// Calls nodes of `root` that run as part of it, skipping the bodies of nested functions and classes.
function forOwnNodes(root, visit) {
  (function walk(node) {
    if (visit(node) === false) return;
    if (node !== root && (functionWithBody(node) || ts.isClassLike(node))) return;
    ts.forEachChild(node, walk);
  })(root);
}

function contains(outer, inner) {
  return inner.pos >= outer.pos && inner.end <= outer.end;
}

// The statement a break or continue leaves, by label or as the nearest loop (or switch, for break).
function jumpTarget(jump) {
  for (let node = jump.parent; node; node = node.parent) {
    if (functionWithBody(node)) return;
    if (jump.label) {
      if (ts.isLabeledStatement(node) && node.label.text === jump.label.text) return node;
    } else if (ts.isIterationStatement(node, false) || (ts.isBreakStatement(jump) && ts.isSwitchStatement(node)))
      return node;
  }
}

const leavingKinds = new Set([
  ts.SyntaxKind.ReturnStatement,
  ts.SyntaxKind.AwaitExpression,
  ts.SyntaxKind.YieldExpression,
  ts.SyntaxKind.FunctionDeclaration,
]);

const awaitUsing = ts.NodeFlags.Const | ts.NodeFlags.Using;

// The statement cannot run inside a function of its own unchanged.
function leavesFunction(statement) {
  let blocked = false;
  forOwnNodes(statement, (node) => {
    if (blocked) return false;
    if (leavingKinds.has(node.kind) || (ts.isForOfStatement(node) && node.awaitModifier)) blocked = true;
    else if (ts.isBreakOrContinueStatement(node)) blocked = !contains(statement, jumpTarget(node) ?? statement.parent);
    // var is visible to the rest of the function, and `await using` awaits when the block ends.
    else if (ts.isVariableDeclarationList(node))
      blocked = !(node.flags & ts.NodeFlags.BlockScoped) || (node.flags & awaitUsing) === awaitUsing;
    // A super() call must stay in the constructor body.
    else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.SuperKeyword) blocked = true;
    return !blocked;
  });
  return blocked;
}

// How the statement uses its function's own `this`, looking through arrows, which share it: 'this' for this or
// super, 'blocked' for arguments or new.target, which a new function would answer differently.
function receiverUse(statement) {
  let use;
  (function walk(node) {
    if (use === 'blocked') return;
    if (node !== statement && ((functionWithBody(node) && !ts.isArrowFunction(node)) || ts.isClassLike(node))) return;
    if (ts.isMetaProperty(node) || (ts.isIdentifier(node) && node.text === 'arguments' && !isMemberName(node)))
      use = 'blocked';
    else if (node.kind === ts.SyntaxKind.ThisKeyword || node.kind === ts.SyntaxKind.SuperKeyword) use = 'this';
    ts.forEachChild(node, walk);
  })(statement);
  return use;
}

function isMemberName(identifier) {
  const parent = identifier.parent;
  if (ts.isQualifiedName(parent)) return parent.right === identifier;
  return (
    (ts.isPropertyAccessExpression(parent) ||
      ts.isPropertyAssignment(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isPropertyDeclaration(parent)) &&
    parent.name === identifier
  );
}

// Where the function goes. Inside a non-static class member it becomes a private method after that member, so it
// keeps `this`; anywhere else a function declared after the top-level statement, which needs no `this`.
function placementOf(statement, receiver) {
  for (let node = statement.parent; node; node = node.parent) {
    if (ts.isArrowFunction(node)) continue;
    const member =
      (functionWithBody(node) || ts.isPropertyDeclaration(node)) && node.parent && ts.isClassLike(node.parent);
    if (member && !ts.isClassStaticBlockDeclaration(node)) {
      const isStatic = node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword);
      if (!isStatic) return { method: true, container: node };
    }
    if (functionWithBody(node) || ts.isClassLike(node) || ts.isClassStaticBlockDeclaration(node)) break;
  }
  if (receiver) return;
  let top = statement;
  while (top.parent && !ts.isSourceFile(top.parent)) top = top.parent;
  if (top.parent) return { method: false, container: top };
}

// --- Narrowing the function relies on ---

// `a.b?.c!` and `a["b"]` as the path TypeScript narrows: `a.b.c`, `a.b`. Undefined for anything else.
function referencePath(node) {
  if (ts.isIdentifier(node)) return node.text;
  if (node.kind === ts.SyntaxKind.ThisKeyword) return 'this';
  if (ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node)) return referencePath(node.expression);
  const owner = node.expression && referencePath(node.expression);
  if (!owner) return;
  if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.name)) return owner + '.' + node.name.text;
  if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression))
    return owner + '.' + node.argumentExpression.text;
  // TypeScript also narrows `a[key]` for a constant key.
  if (ts.isElementAccessExpression(node) && ts.isIdentifier(node.argumentExpression))
    return owner + '[' + node.argumentExpression.text + ']';
}

function isPathNode(node) {
  return (
    ts.isIdentifier(node) ||
    node.kind === ts.SyntaxKind.ThisKeyword ||
    ts.isPropertyAccessExpression(node) ||
    ts.isElementAccessExpression(node)
  );
}

// Paths under `root`. A called function is not narrowed by the call, so callees are left out.
function addPaths(root, paths) {
  (function walk(node) {
    const callee = ts.isCallExpression(node.parent) && node.parent.expression === node;
    if (isPathNode(node) && !callee) {
      const found = referencePath(node);
      if (found) paths.add(found);
    }
    ts.forEachChild(node, walk);
  })(root);
}

function isAssignment(node) {
  return ts.isBinaryExpression(node) && ts.isAssignmentOperator(node.operatorToken.kind);
}

function isIncrement(node) {
  return (
    (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
    (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)
  );
}

// Expressions whose paths TypeScript may narrow for the code after them.
function narrowingParts(node) {
  if (ts.isIfStatement(node) || ts.isWhileStatement(node) || ts.isDoStatement(node)) return [node.expression];
  if (ts.isSwitchStatement(node)) return [node.expression];
  if (ts.isForStatement(node)) return [node.condition];
  if (ts.isConditionalExpression(node)) return [node.condition];
  if (ts.isBinaryExpression(node)) {
    const operator = node.operatorToken.kind;
    if (ts.isAssignmentOperator(operator)) return [node.left];
    if (
      operator === ts.SyntaxKind.AmpersandAmpersandToken ||
      operator === ts.SyntaxKind.BarBarToken ||
      operator === ts.SyntaxKind.QuestionQuestionToken
    )
      return [node.left];
  }
  if (ts.isCallExpression(node) && /^assert/i.test(referencePath(node.expression)?.split('.').at(-1) ?? ''))
    return node.arguments;
  if (isIncrement(node)) return [node.operand];
  // A declared union narrows to the type of its initializer.
  if ((ts.isVariableDeclaration(node) || ts.isParameter(node)) && node.initializer) return [node.name];
  return [];
}

// Paths of `fn` outside `statement` that a condition, assertion or assignment may narrow.
function narrowedPaths(fn, statement) {
  const paths = new Set();
  (function walk(node) {
    if (node === statement) return;
    for (const part of narrowingParts(node)) if (part) addPaths(part, paths);
    ts.forEachChild(node, walk);
  })(fn);
  return paths;
}

// A type narrowing cannot change: known, and neither a union nor any/unknown (which unresolved imports become).
function plainType(type) {
  return !(type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Never)) && !type.isUnion();
}

function bindingList(declaration) {
  let node = declaration;
  while (node && (ts.isBindingElement(node) || ts.isObjectBindingPattern(node) || ts.isArrayBindingPattern(node)))
    node = node.parent;
  if (node && ts.isVariableDeclaration(node)) return node.parent;
}

function constantSymbol(symbol) {
  const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
  if (!declaration) return false;
  if (ts.isVariableDeclaration(declaration) || ts.isBindingElement(declaration)) {
    const list = bindingList(declaration);
    return Boolean(list && ts.isVariableDeclarationList(list) && list.flags & ts.NodeFlags.Const);
  }
  return (
    ts.isImportSpecifier(declaration) ||
    ts.isImportClause(declaration) ||
    ts.isNamespaceImport(declaration) ||
    ts.isClassDeclaration(declaration) ||
    ts.isEnumDeclaration(declaration)
  );
}

// Identifiers a node writes to: assignment and increment targets, including destructuring.
function writtenIdentifiers(node) {
  const target = isAssignment(node)
    ? node.left
    : isIncrement(node)
      ? node.operand
      : (ts.isForOfStatement(node) || ts.isForInStatement(node)) && !ts.isVariableDeclarationList(node.initializer)
        ? node.initializer
        : undefined;
  if (!target) return [];
  const identifiers = [];
  (function walk(part) {
    if (ts.isIdentifier(part)) identifiers.push(part);
    else if (ts.isShorthandPropertyAssignment(part)) identifiers.push(part.name);
    else if (ts.isPropertyAssignment(part)) walk(part.initializer);
    else if (
      ts.isArrayLiteralExpression(part) ||
      ts.isObjectLiteralExpression(part) ||
      ts.isParenthesizedExpression(part) ||
      ts.isSpreadElement(part) ||
      ts.isSpreadAssignment(part) ||
      (ts.isBinaryExpression(part) && part.operatorToken.kind === ts.SyntaxKind.EqualsToken)
    )
      ts.forEachChild(part, walk);
  })(target);
  return identifiers;
}

function symbolOf(checker, identifier) {
  const parent = identifier.parent;
  if (ts.isShorthandPropertyAssignment(parent) && parent.name === identifier)
    return checker.getShorthandAssignmentValueSymbol(parent);
  return checker.getSymbolAtLocation(identifier);
}

// `node` runs inside a function that does not hold `declaration`, so it may run at another time.
function insideClosure(node, declaration) {
  for (let current = node.parent; current; current = current.parent) {
    if (contains(current, declaration)) return false;
    if (functionWithBody(current)) return true;
  }
  return false;
}

// --- Parameters ---

const memberSymbols = ts.SymbolFlags.Property | ts.SymbolFlags.Method | ts.SymbolFlags.Accessor;

// A binding of `container` that the new function cannot see: declared inside it, except the binding a top-level
// statement itself declares.
function isLocal(declaration, container) {
  if (!contains(container, declaration) || declaration === container) return false;
  return bindingList(declaration)?.parent !== container;
}

// Local variables the statement uses, in order of first use, with every reference and write in `container`.
// Undefined when it uses a local function, class or type, which the new function could not reach.
function freeVariables(statement, container, checker) {
  const found = new Map();
  let blocked = false;
  function capture(node) {
    const symbol = symbolOf(checker, node);
    const declaration = symbol && (symbol.valueDeclaration ?? symbol.declarations?.[0]);
    if (!declaration || contains(statement, declaration) || !isLocal(declaration, container)) return;
    if (!(symbol.flags & ts.SymbolFlags.Variable)) {
      if (!(symbol.flags & memberSymbols)) blocked = true;
      return;
    }
    if (!found.has(symbol)) found.set(symbol, { symbol, declaration, first: node });
  }
  (function walk(node) {
    if (blocked) return;
    if (ts.isIdentifier(node)) capture(node);
    ts.forEachChild(node, walk);
  })(statement);
  if (blocked) return;
  const variables = [...found.values()];
  for (const variable of variables) {
    variable.references = [];
    variable.writes = [];
  }
  const bySymbol = new Map(variables.map((variable) => [variable.symbol, variable]));
  (function walk(node) {
    if (ts.isIdentifier(node)) bySymbol.get(symbolOf(checker, node))?.references.push(node);
    for (const identifier of writtenIdentifiers(node))
      bySymbol.get(symbolOf(checker, identifier))?.writes.push(identifier);
    ts.forEachChild(node, walk);
  })(container);
  return variables;
}

function isLetVariable(declaration) {
  const list = bindingList(declaration);
  return Boolean(list && list.flags & ts.NodeFlags.Let);
}

// The one variable the function hands back, null for none, or undefined when the parameters would not behave
// like the variables they copy.
function returnedVariable(statement, container, variables) {
  let returned = null;
  for (const variable of variables) {
    const { declaration, references, writes } = variable;
    // Read before its declaration runs, the copy would throw where the original code did not.
    if (declaration.pos > statement.pos) return;
    // A closure that assigns the variable, or that the statement creates and that reads it later, would see
    // the copy and the variable drift apart.
    if (writes.some((write) => insideClosure(write, declaration))) return;
    const readLater = references.some(
      (reference) => contains(statement, reference) && insideClosure(reference, declaration),
    );
    if (writes.length && readLater) return;
    if (!writes.some((write) => contains(statement, write))) continue;
    if (returned || !isLetVariable(declaration)) return;
    if (references.some((reference) => insideClosure(reference, declaration))) return;
    returned = variable;
  }
  // A throw halfway through would leave the copy's changes behind, where a surrounding try could still look.
  if (returned)
    for (let node = statement.parent; node && node !== container; node = node.parent)
      if (ts.isTryStatement(node)) return;
  return returned;
}

// TypeScript narrows outer paths for the code inside them; a separate function sees only declared types. The
// parameters carry the narrowed type of each variable, but paths through properties and module bindings lose it.
function narrowingLost(statement, fn, checker, variables) {
  const narrowed = narrowedPaths(fn, statement);
  const parameters = new Set(variables.map((variable) => variable.symbol));
  let lost = false;
  (function walk(node) {
    if (lost) return;
    const path = isPathNode(node) && referencePath(node);
    if (path && narrowed.has(path) && !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node)) {
      if (ts.isIdentifier(node)) {
        const symbol = symbolOf(checker, node);
        const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
        if (!symbol) lost = true;
        // The parameter type is read at this spot, so it is narrowed already, unless it is unknown here.
        else if (parameters.has(symbol)) lost = Boolean(checker.getTypeAtLocation(node).flags & ts.TypeFlags.Any);
        else if (declaration && contains(statement, declaration)) lost = false;
        else
          lost = !(
            plainType(checker.getTypeOfSymbol(symbol)) ||
            (constantSymbol(symbol) && !ts.isVariableDeclaration(declaration) && !ts.isBindingElement(declaration))
          );
      } else if (path.includes('.') || path.includes('[')) {
        const property = ts.isPropertyAccessExpression(node) && checker.getSymbolAtLocation(node.name);
        if (!property || !plainType(checker.getTypeOfSymbol(property))) lost = true;
      }
    }
    ts.forEachChild(node, walk);
  })(statement);
  return lost;
}

const typeFormat = ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope;

// `name: Type` for each parameter, or undefined when a type cannot be written down.
function typedParameters(variables, returned, checker, enclosing) {
  const parameters = [];
  for (const variable of variables) {
    const type =
      variable === returned ? checker.getTypeOfSymbol(variable.symbol) : checker.getTypeAtLocation(variable.first);
    // The checker ends object types with `; }`, where formatters write ` }`.
    const text = checker.typeToString(type, enclosing, typeFormat).replace(/; \}/g, ' }');
    if (unprintableType.test(text) || uselessParameterType.test(text.trim())) return;
    parameters.push(`${variable.symbol.name}: ${text}`);
  }
  return parameters;
}

// --- Naming ---

// `items`, `ITEM_KEYS` or `item_keys` as a capitalized part of a camelCase name.
function pascal(word) {
  const parts = /[a-z]/.test(word) && !word.includes('_') ? [word] : word.toLowerCase().split('_').filter(Boolean);
  return parts.map((part) => part[0].toUpperCase() + part.slice(1)).join('');
}

// Methods that read or reshape their receiver, so the receiver names what the code is about.
const receiverMethods = new Set([
  'get',
  'has',
  'includes',
  'some',
  'every',
  'find',
  'at',
  'indexOf',
  'filter',
  'map',
  'slice',
  'entries',
  'values',
  'keys',
  'flat',
  'flatMap',
  'sort',
  'reverse',
  'concat',
  'from',
  'toSorted',
  'toReversed',
]);

// The noun a loop or condition is about: the last name in `a.b.items`, the receiver of `items.filter(...)`, the
// argument of `Object.entries(items)`, or `items` in `getItems()`.
function subjectName(expression) {
  if (!expression) return;
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) {
    if (expression.name.text === 'length' || expression.name.text === 'size') return subjectName(expression.expression);
    return expression.name.text;
  }
  if (ts.isCallExpression(expression)) {
    const callee = expression.expression;
    if (ts.isPropertyAccessExpression(callee)) {
      const receiver = callee.expression;
      // Static helpers such as Object.entries(items) or Array.from(items) are about their argument.
      const staticHelper = ts.isIdentifier(receiver) && /^[A-Z]/.test(receiver.text);
      if (staticHelper && expression.arguments.length) return subjectName(expression.arguments[0]);
      if (receiverMethods.has(callee.name.text)) return subjectName(receiver);
    }
    return subjectName(callee)?.replace(/^(get|find|list|load|fetch)(?=[A-Z])/, '');
  }
  if (
    ts.isParenthesizedExpression(expression) ||
    ts.isNonNullExpression(expression) ||
    ts.isAsExpression(expression) ||
    ts.isElementAccessExpression(expression)
  )
    return subjectName(expression.expression);
  if (ts.isPrefixUnaryExpression(expression)) return subjectName(expression.operand);
  if (ts.isBinaryExpression(expression)) return subjectName(expression.left) ?? subjectName(expression.right);
  if (ts.isTypeOfExpression(expression)) return subjectName(expression.expression);
}

// The first call the statement makes, as the action a try block attempts.
function firstCallName(statement) {
  let name;
  forOwnNodes(statement, (node) => {
    if (name) return false;
    if (ts.isCallExpression(node)) name = subjectName(node.expression);
  });
  return name;
}

function describedName(statement) {
  if (ts.isForOfStatement(statement) || ts.isForInStatement(statement))
    return subjectName(statement.expression) && 'process' + pascal(subjectName(statement.expression));
  if (ts.isForStatement(statement) || ts.isWhileStatement(statement) || ts.isDoStatement(statement)) {
    const condition = ts.isForStatement(statement) ? statement.condition : statement.expression;
    // `i < items.length` is about items, not the counter.
    const bound = condition && ts.isBinaryExpression(condition) ? subjectName(condition.right) : undefined;
    const subject = bound ?? subjectName(condition);
    return subject && 'process' + pascal(subject);
  }
  if (ts.isIfStatement(statement) || ts.isSwitchStatement(statement)) {
    const subject = subjectName(statement.expression);
    return subject && 'handle' + pascal(subject);
  }
  if (ts.isTryStatement(statement)) {
    const action = firstCallName(statement.tryBlock);
    return action && 'try' + pascal(action);
  }
}

// A descriptive name that nothing in the file already uses, so the function shadows and clashes with nothing.
function helperName(statement, sourceFile) {
  const base = describedName(statement);
  if (!base || !/^[A-Za-z_$][\w$]*$/.test(base)) return;
  if (!nameUsed(sourceFile, base)) return base;
}

// --- Layout ---

// One indentation step, read from the statement and the line that opens its block.
function indentationStep(statement, sourceFile) {
  const text = sourceFile.text;
  const own = indentationAt(text, statement.getStart(sourceFile));
  const outer = indentationAt(text, statement.parent.getStart(sourceFile));
  if (own.startsWith(outer) && own.length > outer.length) return own.slice(outer.length);
}

// The statement's lines re-indented to `indentation`, or undefined when a line sits left of the statement.
function movedLines(statement, sourceFile, indentation) {
  const text = sourceFile.text;
  const own = indentationAt(text, statement.getStart(sourceFile));
  const lines = text.slice(lineStart(text, statement.getStart(sourceFile)), statement.end).split('\n');
  if (lines.some((line) => !blank(line) && !line.startsWith(own))) return;
  return lines.map((line) => (blank(line) ? line.replace(/^[ \t]+/, '') : indentation + line.slice(own.length)));
}

// Code written without semicolons gets none either.
function usesSemicolons(fn, sourceFile) {
  let withSemicolon = 0;
  let without = 0;
  forOwnNodes(fn.body, (node) => {
    if (!ts.isExpressionStatement(node) && !ts.isVariableStatement(node)) return;
    if (sourceFile.text[node.end - 1] === ';') withSemicolon++;
    else without++;
  });
  return withSemicolon >= without;
}

// Without semicolons, a following line that starts with one of these would continue the inserted call.
const continuingLine = /^\s*[([`+\-/]/;

// The edits that move `statement` out of `fn` into a named function: the call in its place and the declaration
// after the enclosing member or top-level statement. Undefined when it would not run the same code, or not
// type-check the same.
function extractionEdit(statement, fn, sourceFile) {
  if (!ts.isBlock(statement.parent) || !ownsLines(statement) || hasMultilineLiteral(statement)) return;
  const text = sourceFile.text;
  const lineCount = text.slice(statement.getStart(sourceFile), statement.end).split('\n').length;
  if (lineCount < minExtractedLines || lineCount > maxHunkLines || leavesFunction(statement)) return;
  const receiver = receiverUse(statement);
  if (receiver === 'blocked') return;
  const placement = placementOf(statement, receiver === 'this');
  if (!placement) return;
  const { method, container } = placement;
  const checker = originalProgram(sourceFile).getTypeChecker();
  const variables = freeVariables(statement, container, checker);
  if (!variables || variables.length > maxParameters) return;
  const returned = returnedVariable(statement, container, variables);
  if (returned === undefined) return;
  const typeScript = typeScriptFile.test(sourceFile.fileName);
  if (typeScript && narrowingLost(statement, fn, checker, variables)) return;
  const parameters = typeScript
    ? typedParameters(variables, returned, checker, container.parent)
    : variables.map((variable) => variable.symbol.name);
  const step = indentationStep(statement, sourceFile);
  const name = helperName(statement, sourceFile);
  if (!parameters || !step || !name) return;
  if (!blank(text.slice(container.end, lineEnd(text, container.end)))) return;

  const newline = newlineOf(text);
  const end = usesSemicolons(fn, sourceFile) ? ';' : '';
  if (!end && continuingLine.test(text.slice(statement.end))) return;
  const outerIndentation = indentationAt(text, container.getStart(sourceFile));
  const keyword = method ? (typeScript ? 'private ' : '') : 'function ';
  const header = `${outerIndentation}${keyword}${name}(${parameters.join(', ')}) {`;
  const body = movedLines(statement, sourceFile, outerIndentation + step);
  if (!body || header.length > maxSignatureLength) return;
  const returnLine = returned ? `${newline}${outerIndentation}${step}return ${returned.symbol.name}${end}` : '';

  const indentation = indentationAt(text, statement.getStart(sourceFile));
  const callee = (method ? 'this.' : '') + name;
  const call =
    (returned ? `${returned.symbol.name} = ` : '') +
    `${callee}(${variables.map((variable) => variable.symbol.name).join(', ')})${end}`;
  if (indentation.length + call.length > maxSignatureLength) return;
  const start = lineStart(text, statement.getStart(sourceFile));
  const edits = [
    { start, end: statement.end, text: indentation + call },
    {
      start: container.end,
      end: container.end,
      text: `${newline}${newline}${header}${newline}${body.join('\n')}${returnLine}${newline}${outerIndentation}}`,
    },
  ];
  if (!fitsHunks(sourceFile, edits)) return;
  if (typeScript && !typeChecksAsBefore(sourceFile, applyEdits(sourceFile.text, edits))) return;
  return { name, edits };
}

// --- Measuring the rewritten file with the checker itself ---

function applyEdits(text, edits) {
  let result = text;
  for (const edit of [...edits].sort((left, right) => right.start - left.start))
    result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
  return result;
}

// Whether site-fix would print every hunk of `edits` within its line limit.
function fitsHunks(sourceFile, edits) {
  const text = sourceFile.text;
  const row = (offset) => sourceFile.getLineAndCharacterOfPosition(offset).line;
  const groups = [];
  for (const edit of [...edits].sort((left, right) => left.start - right.start)) {
    const first = row(edit.start);
    const last = row(Math.max(edit.start, edit.end - 1));
    const group = groups.at(-1);
    if (group && first - group.last <= hunkJoinDistance) {
      group.edits.push(edit);
      group.last = Math.max(group.last, last);
    } else groups.push({ first, last, edits: [edit] });
  }
  return groups.every((group) => {
    const start = sourceFile.getPositionOfLineAndCharacter(group.first, 0);
    const before = text.slice(start, lineEnd(text, sourceFile.getPositionOfLineAndCharacter(group.last, 0)));
    const shifted = group.edits.map((edit) => ({ ...edit, start: edit.start - start, end: edit.end - start }));
    const after = applyEdits(before, shifted);
    return before.split('\n').length <= maxHunkLines && after.split('\n').length <= maxHunkLines;
  });
}

// The function a finding belongs to: the one it names, or the one whose body holds the reported statement.
function ownerOf(sourceFile, finding) {
  const offset = sourceFile.getPositionOfLineAndCharacter(finding.line - 1, finding.column - 1);
  const node = innermostNodeAt(ts, sourceFile, offset);
  if (!node) return;
  const named = flaggedFunction(node);
  if (named) return named;
  for (let current = node.parent; current; current = current.parent) if (functionWithBody(current)) return current;
}

// The value the checker reports for `ruleId` on the function starting at `functionStart` (0 when it is under the
// threshold), and how many other functions in the file the rule reports.
function measure(sourceFile, findings, functionStart, ruleId) {
  let value = 0;
  let others = 0;
  for (const finding of findings) {
    if (finding.ruleId !== ruleId) continue;
    const owner = ownerOf(sourceFile, finding);
    if (owner && owner.getStart(sourceFile) === functionStart) value = Number(/\d+/.exec(finding.message)[0]);
    else others++;
  }
  return { value, others };
}

// Every candidate gets a fresh measurement. Candidates from one parsed source share its original findings.
const originalFindings = new WeakMap();
function measuredEdits(sourceFile, fn, ruleId, edits) {
  const start = fn.getStart(sourceFile);
  if (!originalFindings.has(sourceFile))
    originalFindings.set(sourceFile, analyzeFunctions(sourceFile, sourceFile.fileName));
  const before = measure(sourceFile, originalFindings.get(sourceFile), start, ruleId);
  const rewritten = ts.createSourceFile(
    sourceFile.fileName,
    applyEdits(sourceFile.text, edits),
    ts.ScriptTarget.Latest,
    true,
  );
  const after = measure(rewritten, analyzeFunctions(rewritten, rewritten.fileName), start, ruleId);
  return { before: before.value, after: after.value, contained: after.others <= before.others };
}

// Statements of `fn` that run as part of its own body, outermost first.
function ownStatements(fn) {
  const statements = [];
  forOwnNodes(fn.body, (node) => {
    if (node !== fn.body && functionWithBody(node)) return false;
    if (ts.isStatement(node) && ts.isBlock(node.parent) && node.parent !== node) statements.push(node);
  });
  return statements;
}

// Decisions the checker counts inside `statement` for its own function.
function decisionCount(statement) {
  let count = 0;
  forOwnNodes(statement, (node) => {
    if (node !== statement && functionWithBody(node)) return false;
    if (
      ts.isIfStatement(node) ||
      ts.isIterationStatement(node, false) ||
      ts.isSwitchStatement(node) ||
      ts.isCatchClause(node) ||
      ts.isConditionalExpression(node)
    )
      count++;
  });
  return count;
}

module.exports = { extractionEdit, fitsHunks, measuredEdits, ownStatements, decisionCount, originalProgram };
